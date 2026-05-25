/**
 * Tests for src/inbox-uploads.ts (Layer B of RFC#640 4-layer cascade).
 *
 * Three surfaces under test:
 *   1. URICache — LRU eviction, promote-on-get/set, size, clear, bounds.
 *   2. resolvePendingUpload — fetch + persist + ack + cache flow, with
 *      mock fetch + mock fs (real fs via tmpdir).
 *   3. rewritePendingURIs — deep walk across attachments[] +
 *      message.parts[*].file.uri surfaces; cache miss preserves URI.
 *
 * Mirrors the Python reference's test envelope shape — the contract
 * is bidirectional (Python tests pin the spec text; TS tests pin the
 * implementation correctness).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  URICache,
  URI_CACHE_MAX_ENTRIES,
  resolvePendingUpload,
  rewritePendingURIs,
  isChatUploadReceiveRow,
} from "../inbox-uploads.js";

// ---------------------------------------------------------------------------
// URICache
// ---------------------------------------------------------------------------

describe("URICache", () => {
  it("returns undefined for missing key", () => {
    const c = new URICache();
    expect(c.get("platform-pending:ws/x")).toBeUndefined();
  });

  it("returns the stored URI", () => {
    const c = new URICache();
    c.set("platform-pending:ws/x", "file:///tmp/x");
    expect(c.get("platform-pending:ws/x")).toBe("file:///tmp/x");
  });

  it("set replaces existing entry without growing size", () => {
    const c = new URICache();
    c.set("k", "v1");
    c.set("k", "v2");
    expect(c.size()).toBe(1);
    expect(c.get("k")).toBe("v2");
  });

  it("evicts oldest when cap exceeded", () => {
    const c = new URICache(3);
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    c.set("d", "4"); // evicts "a"
    expect(c.size()).toBe(3);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
    expect(c.get("d")).toBe("4");
  });

  it("promotes on get — most-recently-accessed survives eviction", () => {
    const c = new URICache(3);
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    // Touch "a" so it becomes most-recent.
    expect(c.get("a")).toBe("1");
    // Set "d" — eviction should now drop "b" (which is the new oldest).
    c.set("d", "4");
    expect(c.get("a")).toBe("1");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe("3");
    expect(c.get("d")).toBe("4");
  });

  it("clear empties the cache", () => {
    const c = new URICache();
    c.set("a", "1");
    c.set("b", "2");
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeUndefined();
  });

  it("rejects maxEntries < 1", () => {
    expect(() => new URICache(0)).toThrow();
    expect(() => new URICache(-1)).toThrow();
  });

  it("default URI_CACHE_MAX_ENTRIES is 32 (TS-adapter budget)", () => {
    // Python reference uses 1024 because the in-container runtime has
    // the workspace's full memory; TS adapters in tighter budgets use 32.
    expect(URI_CACHE_MAX_ENTRIES).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// isChatUploadReceiveRow
// ---------------------------------------------------------------------------

describe("isChatUploadReceiveRow", () => {
  it("matches chat_upload_receive method", () => {
    expect(isChatUploadReceiveRow({ method: "chat_upload_receive" })).toBe(true);
  });
  it("rejects other methods", () => {
    expect(isChatUploadReceiveRow({ method: "message/send" })).toBe(false);
    expect(isChatUploadReceiveRow({ method: "notify" })).toBe(false);
  });
  it("rejects non-object input defensively", () => {
    expect(isChatUploadReceiveRow(null)).toBe(false);
    expect(isChatUploadReceiveRow(undefined)).toBe(false);
    expect(isChatUploadReceiveRow("chat_upload_receive")).toBe(false);
    expect(isChatUploadReceiveRow(42)).toBe(false);
  });
  it("rejects object without method field", () => {
    expect(isChatUploadReceiveRow({ activity_id: "x" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolvePendingUpload
// ---------------------------------------------------------------------------

describe("resolvePendingUpload", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inbox-test-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("fetches content + writes file + acks + caches", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const calls: Array<{ url: string; method: string }> = [];
    const mockFetch: typeof fetch = async (url, init) => {
      const m = (init?.method ?? "GET") as string;
      const u = (url as string).toString();
      calls.push({ url: u, method: m });
      if (u.endsWith("/content")) {
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (u.endsWith("/ack")) {
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const cache = new URICache();
    const result = await resolvePendingUpload({
      workspaceId: "ws-1",
      fileId: "file-abc",
      authHeaders: { Authorization: "Bearer test-token" },
      cacheDir: tmpDir,
      filename: "pasted.png",
      cache,
      platformUrl: "https://api.test",
      fetchImpl: mockFetch,
    });

    // Both endpoints called exactly once with the right shape.
    expect(calls.length).toBe(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://api.test/workspaces/ws-1/pending-uploads/file-abc/content",
    );
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe(
      "https://api.test/workspaces/ws-1/pending-uploads/file-abc/ack",
    );

    // File written to disk with the expected size + mode.
    expect(fs.existsSync(result.localPath)).toBe(true);
    const stat = fs.statSync(result.localPath);
    expect(stat.size).toBe(5);
    // Filename has the 32-hex prefix + sanitized name.
    expect(path.basename(result.localPath)).toMatch(/^[0-9a-f]{32}-pasted\.png$/);

    // Result envelope shape.
    expect(result.size).toBe(5);
    expect(result.mimeType).toBe("image/png");
    expect(result.localUri).toBe(`file://${result.localPath}`);
    expect(result.cachedPendingUri).toBe("platform-pending:ws-1/file-abc");

    // Cache populated.
    expect(cache.get("platform-pending:ws-1/file-abc")).toBe(result.localUri);
  });

  it("throws on GET non-2xx", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response("denied", { status: 403, statusText: "Forbidden" });
    await expect(
      resolvePendingUpload({
        workspaceId: "ws-1",
        fileId: "file-abc",
        authHeaders: {},
        cacheDir: tmpDir,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/403 Forbidden/);
  });

  it("times out a stuck content fetch before writing", async () => {
    const mockFetch = jest.fn(
      () => new Promise<Response>(() => {}),
    ) as unknown as typeof fetch;

    await expect(
      resolvePendingUpload({
        workspaceId: "ws-1",
        fileId: "file-abc",
        authHeaders: {},
        cacheDir: tmpDir,
        fetchImpl: mockFetch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/GET .* timed out after 10ms/);

    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  it("times out a stuck body read before writing", async () => {
    const stuckResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    } as Response;
    const mockFetch: typeof fetch = async () => stuckResponse;

    await expect(
      resolvePendingUpload({
        workspaceId: "ws-1",
        fileId: "file-abc",
        authHeaders: {},
        cacheDir: tmpDir,
        fetchImpl: mockFetch,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/read body from GET .* timed out after 10ms/);

    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  it("throws on size-cap breach BEFORE writing", async () => {
    const bigBytes = new Uint8Array(11);
    const mockFetch: typeof fetch = async (url) => {
      const u = (url as string).toString();
      if (u.endsWith("/content")) {
        return new Response(bigBytes, { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    await expect(
      resolvePendingUpload({
        workspaceId: "ws-1",
        fileId: "file-abc",
        authHeaders: {},
        cacheDir: tmpDir,
        maxBytes: 10,
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/exceeds maxBytes/);
    // Tmpdir stayed empty — no partial write.
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  it("logs but does not throw when ack fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const mockFetch: typeof fetch = async (url) => {
      const u = (url as string).toString();
      if (u.endsWith("/content")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      // Ack returns 500.
      return new Response("server error", { status: 500, statusText: "Server Error" });
    };
    const result = await resolvePendingUpload({
      workspaceId: "ws-1",
      fileId: "file-abc",
      authHeaders: {},
      cacheDir: tmpDir,
      fetchImpl: mockFetch,
    });
    expect(result.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/POST .*\/ack returned 500/));
    warn.mockRestore();
  });

  it("logs but does not throw when ack times out", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const mockFetch: typeof fetch = async (url) => {
      const u = (url as string).toString();
      if (u.endsWith("/content")) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return new Promise<Response>(() => {});
    };

    const result = await resolvePendingUpload({
      workspaceId: "ws-1",
      fileId: "file-abc",
      authHeaders: {},
      cacheDir: tmpDir,
      fetchImpl: mockFetch,
      timeoutMs: 10,
    });

    expect(result.size).toBe(1);
    expect(fs.existsSync(result.localPath)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/POST .*\/ack failed: .*timed out/));
    warn.mockRestore();
  });

  it("default filename + sanitizes traversal attempts", async () => {
    const mockFetch: typeof fetch = async (url) => {
      const u = (url as string).toString();
      if (u.endsWith("/content")) {
        return new Response(new Uint8Array([0]), { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    const result = await resolvePendingUpload({
      workspaceId: "ws-1",
      fileId: "file-abc",
      authHeaders: {},
      cacheDir: tmpDir,
      filename: "../../../etc/passwd",
      fetchImpl: mockFetch,
    });
    // Final filename strips the path components and keeps a safe name.
    const base = path.basename(result.localPath);
    expect(base).not.toContain("../");
    expect(base).toMatch(/^[0-9a-f]{32}-passwd$/);
  });

  it("uses workspaceId + fileId in URL encoding", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      calls.push((url as string).toString());
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    await resolvePendingUpload({
      workspaceId: "ws with space",
      fileId: "file/with/slash",
      authHeaders: {},
      cacheDir: tmpDir,
      fetchImpl: mockFetch,
      platformUrl: "https://api.test",
    });
    // Both ws and fileId percent-encoded.
    expect(calls[0]).toBe(
      "https://api.test/workspaces/ws%20with%20space/pending-uploads/file%2Fwith%2Fslash/content",
    );
  });

  it("validates required workspaceId, fileId, cacheDir", async () => {
    const noop: typeof fetch = async () => new Response("", { status: 200 });
    await expect(
      resolvePendingUpload({
        workspaceId: "",
        fileId: "f",
        authHeaders: {},
        cacheDir: tmpDir,
        fetchImpl: noop,
      }),
    ).rejects.toThrow(/workspaceId/);
    await expect(
      resolvePendingUpload({
        workspaceId: "w",
        fileId: "",
        authHeaders: {},
        cacheDir: tmpDir,
        fetchImpl: noop,
      }),
    ).rejects.toThrow(/fileId/);
    await expect(
      resolvePendingUpload({
        workspaceId: "w",
        fileId: "f",
        authHeaders: {},
        cacheDir: "",
        fetchImpl: noop,
      }),
    ).rejects.toThrow(/cacheDir/);
  });
});

// ---------------------------------------------------------------------------
// rewritePendingURIs
// ---------------------------------------------------------------------------

describe("rewritePendingURIs", () => {
  it("rewrites a bare platform-pending: string", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/a", "file:///tmp/x");
    expect(rewritePendingURIs("platform-pending:ws/a", cache)).toBe("file:///tmp/x");
  });

  it("preserves URI on cache miss (no silent drop)", () => {
    const cache = new URICache();
    expect(rewritePendingURIs("platform-pending:ws/missing", cache)).toBe(
      "platform-pending:ws/missing",
    );
  });

  it("rewrites top-level attachments[] uri", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/a", "file:///tmp/a.png");
    const body = {
      attachments: [
        { kind: "image", uri: "platform-pending:ws/a", name: "a.png", mime_type: "image/png" },
      ],
      text: "hello",
    };
    const out = rewritePendingURIs(body, cache) as typeof body;
    expect(out.attachments[0].uri).toBe("file:///tmp/a.png");
    expect(out.attachments[0].name).toBe("a.png");
    expect(out.text).toBe("hello");
  });

  it("rewrites embedded message.parts[*].file.uri", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/img", "file:///tmp/img.png");
    cache.set("platform-pending:ws/aud", "file:///tmp/aud.mp3");
    const body = {
      params: {
        message: {
          parts: [
            { kind: "text", text: "see attached" },
            {
              kind: "image",
              file: { uri: "platform-pending:ws/img", mime_type: "image/png", name: "img.png" },
            },
            {
              kind: "audio",
              file: { uri: "platform-pending:ws/aud", mime_type: "audio/mpeg", name: "aud.mp3" },
            },
          ],
        },
      },
    };
    const out = rewritePendingURIs(body, cache) as typeof body;
    expect(out.params.message.parts[0]).toEqual({ kind: "text", text: "see attached" });
    expect(out.params.message.parts[1].file!.uri).toBe("file:///tmp/img.png");
    expect(out.params.message.parts[2].file!.uri).toBe("file:///tmp/aud.mp3");
  });

  it("non-URI strings pass through unchanged", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/x", "file:///tmp/x");
    expect(rewritePendingURIs("hello world", cache)).toBe("hello world");
    expect(rewritePendingURIs("workspace:/tmp/foo.pdf", cache)).toBe(
      "workspace:/tmp/foo.pdf",
    );
  });

  it("does not mutate the input", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/a", "file:///tmp/a");
    const input = { x: "platform-pending:ws/a" };
    const out = rewritePendingURIs(input, cache) as typeof input;
    // Input unchanged.
    expect(input.x).toBe("platform-pending:ws/a");
    // Output rewritten.
    expect(out.x).toBe("file:///tmp/a");
    // Different identity (new object).
    expect(out).not.toBe(input);
  });

  it("handles null + undefined + primitives", () => {
    const cache = new URICache();
    expect(rewritePendingURIs(null, cache)).toBeNull();
    expect(rewritePendingURIs(undefined, cache)).toBeUndefined();
    expect(rewritePendingURIs(42, cache)).toBe(42);
    expect(rewritePendingURIs(true, cache)).toBe(true);
  });

  it("walks deep into nested arrays + objects", () => {
    const cache = new URICache();
    cache.set("platform-pending:ws/deep", "file:///tmp/deep");
    const body = {
      a: { b: { c: [{ d: "platform-pending:ws/deep" }] } },
    };
    const out = rewritePendingURIs(body, cache) as {
      a: { b: { c: Array<{ d: string }> } };
    };
    expect(out.a.b.c[0].d).toBe("file:///tmp/deep");
  });
});
