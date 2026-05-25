/**
 * inbox-uploads — chat-upload resolution flow for /activity-polling adapters.
 *
 * MANDATORY contract surface for any TS adapter that consumes `chat_upload_receive`
 * activity rows. Mirrors the Python reference at
 *   molecule_runtime/inbox_uploads.py
 * in `molecule-ai-workspace-runtime` (724 LOC; the in-container runtime's
 * upload-resolution module).
 *
 * IF YOU EDIT THIS FILE:
 *   - Mirror the change in the Python reference (`molecule_runtime/inbox_uploads.py`).
 *   - If the contract semantics change (steps, ordering, endpoint shape),
 *     ALSO update the spec section in
 *     `molecule_runtime/a2a_mcp_server.py::_build_channel_instructions`
 *     ("Upload resolution (MANDATORY...)" block).
 *   - The Layer D contract test in `__tests__/inbox-uploads-import-contract.test.ts`
 *     will fail-CI on any TS file that imports `apiCall` from
 *     `@molecule-ai/mcp-server` to poll /activity but does NOT also import
 *     `resolvePendingUpload` (or opts out via the documented magic comment).
 *
 * Bidirectional drift catchable from either side:
 *   - Python side: `tests/test_upload_resolution_contract.py` pins the
 *     spec text (steps named verbatim, references to BOTH this TS file
 *     AND the Python file, kind enumeration including video).
 *   - TS side: `__tests__/inbox-uploads.test.ts` pins URICache LRU
 *     semantics, fetch/persist/ack/cache/rewrite flow, JSON-walk rewrite
 *     across attachments[] and message.parts surfaces.
 *
 * Origin: RFC#640 4-layer cascade Layer B. CTO chat GO 2026-05-22T01:31:48Z.
 * Empirical trigger: 2026-05-21 ~23:12Z agents-team canvas paste —
 * channel plugin had no resolution code path and surfaced
 * `platform-pending:` URIs the agent couldn't open. Layer B closes the
 * asymmetry between Python SDK (full module) and TS base MCP (zero module).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { PLATFORM_URL } from "./api.js";

// ---------------------------------------------------------------------------
// LRU cache (mirrors molecule_runtime/inbox_uploads.py::_URICache semantics)
// ---------------------------------------------------------------------------

/**
 * Default LRU bound for TS adapters. Tighter than the Python reference
 * (which uses `URI_CACHE_MAX_ENTRIES=1024` because the in-container
 * runtime has the workspace's full memory budget) because TS adapters
 * — channel plugin, telegram-style adapters, codex bridges — typically
 * run in a host shell or sidecar with less memory headroom. 32 entries
 * comfortably covers a single agent session's upload count (the
 * empirical canvas paste was 1 file; even an aggressive multi-file
 * drag rarely exceeds 5-10).
 *
 * Adapters with looser budgets can override via the URICache constructor.
 */
export const URI_CACHE_MAX_ENTRIES = 32;

/**
 * Bounded LRU mapping `platform-pending:<ws>/<file_id>` → local file URI.
 *
 * JS Maps preserve insertion order, so we use the Map's natural iteration
 * order for LRU: on `set`, delete-and-reinsert promotes the entry to
 * most-recent; on `get`, same delete-and-reinsert promotes; eviction
 * pops the first (oldest) entry.
 *
 * Not thread-safe — Node.js is single-threaded with cooperative async
 * scheduling, so the Python reference's `threading.Lock` doesn't apply.
 * A future Worker-thread adapter would need to add synchronization.
 */
export class URICache {
  private entries: Map<string, string> = new Map();

  constructor(private readonly maxEntries: number = URI_CACHE_MAX_ENTRIES) {
    if (maxEntries < 1) {
      throw new Error(`URICache maxEntries must be >= 1, got ${maxEntries}`);
    }
  }

  get(pendingUri: string): string | undefined {
    const local = this.entries.get(pendingUri);
    if (local !== undefined) {
      // Promote to most-recent.
      this.entries.delete(pendingUri);
      this.entries.set(pendingUri, local);
    }
    return local;
  }

  set(pendingUri: string, localUri: string): void {
    // If already present, delete first so the re-set lands at most-recent.
    if (this.entries.has(pendingUri)) {
      this.entries.delete(pendingUri);
    }
    this.entries.set(pendingUri, localUri);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Activity-row matcher (mirrors molecule_runtime/inbox_uploads.py::is_chat_upload_row)
// ---------------------------------------------------------------------------

/**
 * True iff `row` is a `chat_upload_receive` activity row.
 *
 * Adapters fork this row off the regular A2A message handling path —
 * it's not a peer message; it's an instruction to fetch + stage bytes.
 * Match on `method` only; the upstream `/activity` filter already
 * scopes by `activity_type=a2a_receive` if needed.
 */
export function isChatUploadReceiveRow(row: unknown): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    (row as { method?: unknown }).method === "chat_upload_receive"
  );
}

// ---------------------------------------------------------------------------
// Fetch + persist + ack flow
// ---------------------------------------------------------------------------

/**
 * Result of a successful resolvePendingUpload call.
 *
 * - `localPath`: absolute path on the local filesystem where bytes were
 *   written. Adapters that surface a `file://` URI to the agent use
 *   this directly.
 * - `localUri`: `file://...` URI variant of localPath; convenience for
 *   adapters that pass URIs through to the agent / model context.
 * - `mimeType`: from the platform's Content-Type response header, if
 *   present and parseable. Undefined when the platform doesn't supply.
 * - `size`: byte count of what was written.
 * - `cachedPendingUri`: the `platform-pending:<ws>/<file_id>` URI used
 *   as the cache key. Adapters that want to update an external URI
 *   cache (beyond the one passed in via opts.cache) use this.
 */
export interface ResolveUploadResult {
  localPath: string;
  localUri: string;
  mimeType?: string;
  size: number;
  cachedPendingUri: string;
}

/**
 * Options for resolvePendingUpload.
 *
 * Required:
 * - `workspaceId`: the workspace UUID — same one used for /activity polling.
 * - `fileId`: the `<file_id>` from `platform-pending:<ws>/<file_id>` or
 *   from the activity row's request_body.
 * - `authHeaders`: HTTP headers including the Bearer auth — adapters
 *   pass the SAME headers they use for /activity polling. The
 *   /pending-uploads/<id>/content + /ack endpoints are wsAuth-gated, so
 *   the workspace's bearer is sufficient (no separate handshake).
 * - `cacheDir`: absolute directory path where bytes are persisted.
 *   Adapter-specific:
 *     - Claude Code channel plugin: `~/.claude/channels/molecule/inbox/`
 *     - In-container Python runtime: `/workspace/.molecule/chat-uploads/`
 *     - Other adapters: pick a stable, adapter-specific path.
 *
 * Optional:
 * - `filename`: hint for the on-disk filename (without prefix). The
 *   final filename is `<32-hex-prefix>-<sanitized-filename>` so that
 *   parallel uploads with the same source name don't collide.
 *   Default `upload.bin` if not supplied.
 * - `cache`: a URICache instance to populate with the
 *   `platform-pending:<ws>/<file_id>` → `file://<localPath>` mapping
 *   on success. If omitted, no cache write happens (caller manages
 *   cache separately).
 * - `platformUrl`: override the platform base URL (defaults to
 *   PLATFORM_URL from `./api.js` — `MOLECULE_API_URL` env var).
 * - `fetchImpl`: override `globalThis.fetch` for testing.
 * - `maxBytes`: per-file safety cap. Default 25 MiB matching the
 *   platform's same-side staging cap.
 * - `timeoutMs`: timeout for each upload content/ack request. Default 15s.
 */
export interface ResolveUploadOptions {
  workspaceId: string;
  fileId: string;
  authHeaders: Record<string, string>;
  cacheDir: string;
  filename?: string;
  cache?: URICache;
  platformUrl?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`resolvePendingUpload: timeoutMs must be > 0, got ${timeoutMs}`);
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`resolvePendingUpload: ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withTimeout(
      fetchImpl(url, {
        ...init,
        signal: controller.signal,
      }),
      timeoutMs,
      label,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch the bytes of a `platform-pending:<ws>/<file_id>` upload, persist
 * to a local cache dir, ack the platform-side `pending_uploads` row,
 * and (if a cache is provided) record the URI mapping.
 *
 * Returns the full result envelope. On any failure (network, non-2xx,
 * fs write error, size-cap breach) throws an Error with a structured
 * message. The platform-side row stays unacked when the throw originates
 * upstream of the ack POST — adapters' poll-loop retry semantics carry
 * it through to a future invocation.
 *
 * This is the 5-step MANDATORY flow named in the
 * `_build_channel_instructions` spec section. Skipping any step results
 * in silent file loss — the agent sees `platform-pending:` URIs it
 * cannot open with no error surfaced. The flow:
 *
 *   1. GET /workspaces/<ws>/pending-uploads/<file_id>/content
 *   2. mkdir + write to cacheDir/<prefix>-<filename>  (mode 0600)
 *   3. POST /workspaces/<ws>/pending-uploads/<file_id>/ack
 *   4. cache.set("platform-pending:<ws>/<file_id>", "file://<localPath>")
 *   5. (URI rewrite is the caller's concern — use rewritePendingURIs())
 */
export async function resolvePendingUpload(
  opts: ResolveUploadOptions,
): Promise<ResolveUploadResult> {
  const {
    workspaceId,
    fileId,
    authHeaders,
    cacheDir,
    filename = "upload.bin",
    cache,
    platformUrl = PLATFORM_URL,
    fetchImpl = fetch,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
  } = opts;

  if (!workspaceId) throw new Error("resolvePendingUpload: workspaceId required");
  if (!fileId) throw new Error("resolvePendingUpload: fileId required");
  if (!cacheDir) throw new Error("resolvePendingUpload: cacheDir required");

  const pendingUri = `platform-pending:${workspaceId}/${fileId}`;
  const baseUrl = `${platformUrl}/workspaces/${encodeURIComponent(workspaceId)}/pending-uploads/${encodeURIComponent(fileId)}`;
  const contentUrl = `${baseUrl}/content`;
  const ackUrl = `${baseUrl}/ack`;

  // Step 1: fetch content
  const res = await fetchWithTimeout(
    fetchImpl,
    contentUrl,
    {
      method: "GET",
      headers: authHeaders,
    },
    timeoutMs,
    `GET ${contentUrl}`,
  );
  if (!res.ok) {
    throw new Error(
      `resolvePendingUpload: GET ${contentUrl} returned ${res.status} ${res.statusText}`,
    );
  }
  const ab = await withTimeout(
    res.arrayBuffer(),
    timeoutMs,
    `read body from GET ${contentUrl}`,
  );
  const bytes = new Uint8Array(ab);
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `resolvePendingUpload: content size ${bytes.byteLength} exceeds maxBytes ${maxBytes}`,
    );
  }
  const mimeType = (res.headers.get("content-type") ?? undefined) || undefined;

  // Step 2: persist to local cache dir
  await fs.mkdir(cacheDir, { recursive: true });
  const sanitized = sanitizeFilename(filename);
  // 32-hex prefix matches Python's pysecrets.token_hex(16) — random
  // enough that two parallel uploads of the same source filename can't
  // collide; also defeats any "guess the on-disk name" attack from a
  // stale agent that knows the original filename.
  const prefix = crypto.randomBytes(16).toString("hex");
  const stored = `${prefix}-${sanitized}`;
  const localPath = path.join(cacheDir, stored);
  // mode 0o600 — only this process's user can read. Matches the Python
  // reference's _open_safe pattern. wx mode rejects pre-existing files
  // at the target (the 32-hex prefix makes collision astronomical, but
  // defense-in-depth costs nothing).
  await fs.writeFile(localPath, bytes, { mode: 0o600, flag: "wx" });

  // Step 3: ack
  try {
    const ackRes = await fetchWithTimeout(
      fetchImpl,
      ackUrl,
      {
        method: "POST",
        headers: authHeaders,
      },
      timeoutMs,
      `POST ${ackUrl}`,
    );
    if (!ackRes.ok) {
      // Failure here means the bytes ARE on disk but the platform row
      // stays in the pending queue. Phase 3 sweep will eventually
      // surface the stale row; the agent already has the local file.
      // We log + continue rather than throw, because the user-visible
      // outcome (agent can read the file) is achieved.
      // eslint-disable-next-line no-console
      console.warn(
        `resolvePendingUpload: POST ${ackUrl} returned ${ackRes.status} ${ackRes.statusText} ` +
          `— bytes written locally but platform-side row not reclaimed`,
      );
    }
  } catch (err) {
    // Failure here means the bytes ARE on disk but the platform row
    // stays in the pending queue. Phase 3 sweep will eventually
    // surface the stale row; the agent already has the local file.
    // We log + continue rather than throw, because the user-visible
    // outcome (agent can read the file) is achieved.
    // eslint-disable-next-line no-console
    console.warn(
      `resolvePendingUpload: POST ${ackUrl} failed: ${err instanceof Error ? err.message : String(err)} ` +
        `— bytes written locally but platform-side row not reclaimed`,
    );
  }

  // Step 4: cache the mapping
  const localUri = `file://${localPath}`;
  if (cache) {
    cache.set(pendingUri, localUri);
  }

  return {
    localPath,
    localUri,
    mimeType,
    size: bytes.byteLength,
    cachedPendingUri: pendingUri,
  };
}

// ---------------------------------------------------------------------------
// URI rewrite (mirrors molecule_runtime/inbox_uploads.py::rewrite_request_body
// + the broader walk semantics)
// ---------------------------------------------------------------------------

/**
 * Walk `body` (arbitrary JSON-shaped value) and rewrite any
 * `platform-pending:<ws>/<file_id>` URIs to their cached local URIs.
 *
 * The walk is deep + non-destructive: returns a new value with
 * substitutions applied; the input is not mutated.
 *
 * Two surfaces are explicitly handled because they're the documented
 * inbound shapes that carry attachment URIs:
 *   - Top-level `attachments[]` array (peer_info-enriched activity rows)
 *   - Embedded `params.message.parts[*].file.uri` (a2a-sdk v1 message
 *     parts; the in-container runtime emits these for peer-agent
 *     attachments)
 *
 * The walk is conservative: it ONLY rewrites string values that exactly
 * start with `platform-pending:` and are present in the cache. Other
 * strings (text content, identity fields, etc.) pass through unchanged.
 * A cache miss (URI not yet resolved) leaves the URI in place — the
 * agent will see something it can't open, which is preferable to
 * silently dropping the URI.
 */
export function rewritePendingURIs(body: unknown, cache: URICache): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body === "string") {
    if (body.startsWith("platform-pending:")) {
      const local = cache.get(body);
      return local ?? body;
    }
    return body;
  }
  if (Array.isArray(body)) {
    return body.map((item) => rewritePendingURIs(item, cache));
  }
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = rewritePendingURIs(v, cache);
    }
    return out;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a filename: keep alnum + dash + underscore + dot, collapse
 * everything else to `_`. Defense against ../ traversal, shell-meta
 * chars, and null bytes in user-supplied filenames.
 */
function sanitizeFilename(name: string): string {
  if (!name) return "upload.bin";
  // Strip any directory components.
  const base = name.replace(/^.*[/\\]/, "");
  // Drop null bytes + non-portable chars; collapse runs of `_`.
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return "upload.bin";
  return cleaned.slice(0, 240); // ext4 NAME_MAX = 255; leave room for the prefix
}
