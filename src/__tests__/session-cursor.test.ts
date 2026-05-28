import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CursorStore,
  cursorFileName,
  parseSessionKey,
  pruneOrphanCursors,
} from "../session-cursor.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "session-cursor-test-"));
}

describe("cursorFileName", () => {
  it("maps absent/empty key to the shared primary file", () => {
    expect(cursorFileName()).toBe("cursor.json");
    expect(cursorFileName(undefined)).toBe("cursor.json");
    expect(cursorFileName(null)).toBe("cursor.json");
    expect(cursorFileName("")).toBe("cursor.json");
    expect(cursorFileName("   ")).toBe("cursor.json");
  });

  it("maps a session key to a per-session file", () => {
    expect(cursorFileName("12345")).toBe("cursor.12345.json");
    expect(cursorFileName("a_b-9")).toBe("cursor.a_b-9.json");
  });

  it("rejects keys that would break filename round-trip or escape the dir", () => {
    expect(() => cursorFileName("../etc")).toThrow();
    expect(() => cursorFileName("a/b")).toThrow();
    expect(() => cursorFileName("a.b")).toThrow();
  });
});

describe("parseSessionKey", () => {
  it("extracts the key from a per-session file", () => {
    expect(parseSessionKey("cursor.12345.json")).toBe("12345");
    expect(parseSessionKey("cursor.a_b-9.json")).toBe("a_b-9");
  });

  it("returns null for the primary file and unrelated files (round-trips cursorFileName)", () => {
    expect(parseSessionKey("cursor.json")).toBeNull();
    expect(parseSessionKey("bot.pid")).toBeNull();
    expect(parseSessionKey(".env")).toBeNull();
    expect(parseSessionKey("cursor.12345.json.tmp.999")).toBeNull();
    // Round-trip invariant for valid keys.
    for (const key of ["12345", "a_b-9"]) {
      expect(parseSessionKey(cursorFileName(key))).toBe(key);
    }
  });
});

describe("CursorStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("primary vs secondary pick distinct files", () => {
    expect(new CursorStore({ stateDir: dir }).fileName).toBe("cursor.json");
    expect(new CursorStore({ stateDir: dir, sessionKey: "777" }).fileName).toBe("cursor.777.json");
  });

  it("load on a missing file yields an empty store (first run)", () => {
    const store = new CursorStore({ stateDir: dir }).load();
    expect(store.size).toBe(0);
    expect(store.get("ws-1")).toBeUndefined();
  });

  it("round-trips set → save → reload", () => {
    const a = new CursorStore({ stateDir: dir });
    a.set("ws-1", "act-100");
    a.set("ws-2", "act-200");
    a.save();

    const b = new CursorStore({ stateDir: dir }).load();
    expect(b.get("ws-1")).toBe("act-100");
    expect(b.get("ws-2")).toBe("act-200");
    expect(b.size).toBe(2);
  });

  it("delete then save drops the key on disk", () => {
    const a = new CursorStore({ stateDir: dir });
    a.set("ws-1", "act-100");
    a.set("ws-2", "act-200");
    a.save();
    expect(a.delete("ws-1")).toBe(true);
    a.save();

    const b = new CursorStore({ stateDir: dir }).load();
    expect(b.has("ws-1")).toBe(false);
    expect(b.get("ws-2")).toBe("act-200");
  });

  it("treats a corrupt file as first-run and reports via onLoadError", () => {
    writeFileSync(join(dir, "cursor.json"), "{not json");
    const errs: unknown[] = [];
    const store = new CursorStore({ stateDir: dir, onLoadError: (e) => errs.push(e) }).load();
    expect(store.size).toBe(0);
    expect(errs).toHaveLength(1);
  });

  it("ignores non-string / empty values in the persisted object", () => {
    writeFileSync(
      join(dir, "cursor.json"),
      JSON.stringify({ "ws-1": "act-1", "ws-2": 42, "ws-3": "", "ws-4": null }),
    );
    const store = new CursorStore({ stateDir: dir }).load();
    expect(store.get("ws-1")).toBe("act-1");
    expect(store.has("ws-2")).toBe(false);
    expect(store.has("ws-3")).toBe(false);
    expect(store.has("ws-4")).toBe(false);
  });

  it("save is atomic — no temp file lingers and the JSON is well-formed", () => {
    const a = new CursorStore({ stateDir: dir });
    a.set("ws-1", "act-100");
    a.save();
    const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "cursor.json"), "utf8"))).toEqual({ "ws-1": "act-100" });
  });

  it("unlink removes the backing file and is a no-op when already gone", () => {
    const a = new CursorStore({ stateDir: dir, sessionKey: "777" });
    a.set("ws-1", "act-1");
    a.save();
    expect(existsSync(join(dir, "cursor.777.json"))).toBe(true);
    a.unlink();
    expect(existsSync(join(dir, "cursor.777.json"))).toBe(false);
    expect(() => a.unlink()).not.toThrow();
  });
});

describe("pruneOrphanCursors", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes only dead per-session files; keeps primary, live sessions, and unrelated files", () => {
    writeFileSync(join(dir, "cursor.json"), "{}"); // primary — never pruned
    writeFileSync(join(dir, "cursor.111.json"), "{}"); // dead session
    writeFileSync(join(dir, "cursor.222.json"), "{}"); // live session
    writeFileSync(join(dir, "bot.pid"), "222"); // unrelated — never pruned

    const pruned = pruneOrphanCursors(dir, (key) => key === "222");

    expect(pruned).toEqual(["cursor.111.json"]);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(["bot.pid", "cursor.222.json", "cursor.json"]);
  });

  it("never deletes a cursor whose liveness probe throws", () => {
    writeFileSync(join(dir, "cursor.111.json"), "{}");
    const pruned = pruneOrphanCursors(dir, () => {
      throw new Error("probe blew up");
    });
    expect(pruned).toEqual([]);
    expect(existsSync(join(dir, "cursor.111.json"))).toBe(true);
  });

  it("tolerates a missing state dir", () => {
    expect(pruneOrphanCursors(join(dir, "does-not-exist"), () => false)).toEqual([]);
  });
});
