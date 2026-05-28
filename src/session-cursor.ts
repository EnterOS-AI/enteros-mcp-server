/**
 * session-cursor — session-namespaced, durable since_id cursor store for
 * /activity-polling adapters.
 *
 * Shared contract surface for any TS adapter that polls
 *   GET /workspaces/:id/activity?since_id=<cursor>
 * and must persist "the activity_logs.id of the last event I delivered" so a
 * restart resumes without missing or replaying messages. The channel plugin
 * had this inline; hermes-ts / codex-ts will need the identical behavior.
 * Extracted here (beside `inbox-uploads` / `targets`) so the polling-cursor
 * contract has one implementation, per the cross-adapter SSOT pattern.
 *
 * WHY SESSION-NAMESPACED:
 *   A single host can run more than one adapter session (two `claude`
 *   invocations both loading the plugin). They poll the same workspace_id,
 *   but the platform is fully concurrent (register/heartbeat are
 *   workspace-keyed last-writer-wins, /activity is read-only with a
 *   client-driven since_id — molecule-core registry.go / activity.go). The
 *   ONLY thing that races is a *shared* cursor file. Keying the cursor file
 *   by a session key removes that race so concurrent sessions don't clobber
 *   each other (molecule-mcp-claude-channel#26 / internal#726).
 *
 *   - Primary (no session key)  → `cursor.json`  — survives restarts, so the
 *     common single-session case resumes from its last position.
 *   - Secondary (session key)   → `cursor.<key>.json` — independent; pruned
 *     when its session is gone.
 *
 * Logging-agnostic on purpose: `load()` swallows corruption (optionally
 * reporting via `onLoadError`) and `save()` throws — the adapter owns its
 * stderr/pino phrasing and decides whether a failed tick should be fatal.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const PRIMARY_FILE = "cursor.json";
const SESSION_RE = /^cursor\.([A-Za-z0-9_-]+)\.json$/;
const VALID_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Map a session key to its cursor filename.
 *   undefined / null / "" → "cursor.json"      (primary; survives restarts)
 *   "12345"               → "cursor.12345.json" (secondary; per-session)
 * Throws on a key that would break filename round-tripping or escape the
 * state dir (path separators, dots). Callers pass a PID string, always valid.
 */
export function cursorFileName(sessionKey?: string | null): string {
  const key = (sessionKey ?? "").trim();
  if (!key) return PRIMARY_FILE;
  if (!VALID_KEY.test(key)) {
    throw new Error(
      `session key must match ${VALID_KEY} (got ${JSON.stringify(sessionKey)})`,
    );
  }
  return `cursor.${key}.json`;
}

/**
 * Inverse of {@link cursorFileName} for secondary files. Returns the session
 * key for a `cursor.<key>.json` file, or null for the primary `cursor.json`
 * and any unrelated file. Used to identify prunable per-session files.
 */
export function parseSessionKey(fileName: string): string | null {
  const m = SESSION_RE.exec(fileName);
  return m ? m[1]! : null;
}

/**
 * Delete per-session cursor files whose session is no longer alive. Never
 * touches the primary `cursor.json` or unrelated files. `isAlive(key)` is
 * supplied by the adapter (e.g. a PID-liveness probe). Returns the list of
 * removed filenames (for logging). Tolerant of a missing state dir.
 */
export function pruneOrphanCursors(
  stateDir: string,
  isAlive: (sessionKey: string) => boolean,
): string[] {
  const pruned: string[] = [];
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return pruned;
  }
  for (const name of names) {
    const key = parseSessionKey(name);
    if (key === null) continue; // primary or unrelated
    let alive = true;
    try {
      alive = isAlive(key);
    } catch {
      // A probe that throws is treated as "alive" — never delete a cursor we
      // can't prove is orphaned.
      alive = true;
    }
    if (alive) continue;
    try {
      unlinkSync(join(stateDir, name));
      pruned.push(name);
    } catch {
      // Already gone or unreadable — nothing to do.
    }
  }
  return pruned;
}

export interface CursorStoreOptions {
  /** Directory holding the cursor file(s). */
  stateDir: string;
  /** Session key; null/undefined => the shared primary cursor. */
  sessionKey?: string | null;
  /** File mode for the cursor file. Defaults to 0o600 (it's not secret, but cheap to lock down). */
  fileMode?: number;
  /** Optional hook invoked when {@link CursorStore.load} hits an unreadable/corrupt file. */
  onLoadError?: (err: unknown) => void;
}

/**
 * A workspace_id → last-delivered-activity-id map backed by one JSON file.
 *
 * Schema on disk: `{ "ws-uuid-1": "act-uuid-X", "ws-uuid-2": "act-uuid-Y" }`.
 * Atomic persistence via temp+rename so a crash mid-write can't corrupt the
 * file (the previous cursor stays valid; worst case is a few replays).
 */
export class CursorStore {
  /** Filename within the state dir (e.g. "cursor.json" or "cursor.123.json"). */
  readonly fileName: string;
  /** Absolute path to the backing file. */
  readonly path: string;
  private readonly fileMode: number;
  private readonly onLoadError?: (err: unknown) => void;
  private readonly cursors = new Map<string, string>();

  constructor(opts: CursorStoreOptions) {
    this.fileName = cursorFileName(opts.sessionKey);
    this.path = join(opts.stateDir, this.fileName);
    this.fileMode = opts.fileMode ?? 0o600;
    this.onLoadError = opts.onLoadError;
  }

  /**
   * Populate from disk. Missing file => empty (first run). Corrupt file =>
   * empty (treated as first run; `onLoadError` is invoked if provided). Never
   * throws — a poller that refuses to start over one bad file is worse than
   * the recovery cost (re-seed from now). Returns `this` for chaining.
   */
  load(): this {
    this.cursors.clear();
    if (!existsSync(this.path)) return this;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.length > 0) this.cursors.set(k, v);
      }
    } catch (err) {
      this.cursors.clear();
      this.onLoadError?.(err);
    }
    return this;
  }

  get(workspaceId: string): string | undefined {
    return this.cursors.get(workspaceId);
  }

  has(workspaceId: string): boolean {
    return this.cursors.has(workspaceId);
  }

  set(workspaceId: string, activityId: string): void {
    this.cursors.set(workspaceId, activityId);
  }

  delete(workspaceId: string): boolean {
    return this.cursors.delete(workspaceId);
  }

  entries(): Array<[string, string]> {
    return Array.from(this.cursors.entries());
  }

  get size(): number {
    return this.cursors.size;
  }

  /**
   * Atomically persist to disk (temp + rename). The temp name is PID-suffixed
   * so two writers never collide on the temp path. Throws on write failure —
   * the caller (typically a setInterval tick) decides whether to log+swallow.
   */
  save(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.cursors) obj[k] = v;
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: this.fileMode });
    renameSync(tmp, this.path);
  }

  /** Remove the backing file. Used by a secondary session on clean exit. No-op if already gone. */
  unlink(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed or never written.
    }
  }
}
