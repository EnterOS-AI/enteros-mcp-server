/**
 * Structured logger for the Molecule AI MCP server.
 *
 * All log output is JSON (machine-parseable).  During development / when
 * NODE_ENV !== "production" the output is pretty-printed so humans can read it.
 *
 * Every log entry includes:
 *   - level    — numeric pino level (30 = warn, 50 = error)
 *   - time     — ISO-8601 timestamp
 *   - pid      — process ID
 *   - hostname — machine hostname
 *   - msg      — human-readable message
 *   - err      — (on error entries) error object with message + stack
 *
 * Plus whatever fields are passed as additional arguments, e.g.:
 *   log.warn({ workspaceId: "ws_123", tool: "list_workspaces" }, "rate limit hit")
 *
 * The MCP request context from src/utils/context.ts is automatically attached
 * to every entry when inside a tool-call scope (toolName, requestId, workspaceId).
 */

import { getContext } from "./context.js";
import pino from "pino";

// pino is imported statically (works in both the ESM runtime build and the
// ts-jest CJS transform via esModuleInterop). The pino INSTANCE is still
// created lazily in logger() below, so tests that mock console run before the
// first real log call. The earlier `createRequire(import.meta.url)` approach
// crashed ts-jest (`Cannot use 'import.meta' outside a module`) — avoid it.

/** Logger instance returned by pino(). */
type PinoLogger = {
  info: (bindings: Record<string, unknown>, msg: string) => void;
  warn: (bindings: Record<string, unknown>, msg: string) => void;
  error: (bindings: Record<string, unknown>, msg: string) => void;
  debug: (bindings: Record<string, unknown>, msg: string) => void;
};

// Lazy singleton — created on first log call so tests that mock console run
// before the first actual log invocation.
let _logger: PinoLogger | null = null;

function logger(): PinoLogger {
  if (!_logger) {
    // pino is called untyped (as the prior `require("pino") as any` did) so the
    // existing numeric `level` + transport/formatter options keep their runtime
    // behavior without re-typing against pino's stricter option types.
    // ALL log output MUST go to stderr (fd 2). This server speaks MCP over
    // stdio: stdout is the JSONRPC channel, and any log line written there —
    // pretty-printed OR plain JSON — corrupts the protocol stream. (Seen in
    // the field 2026-07-19: the colorized startup banner on stdout made every
    // hermes tool call hang behind "Failed to parse JSONRPC message".)
    const pretty = process.env["NODE_ENV"] !== "production" || process.stdout.isTTY;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _logger = (pino as any)(
      {
        // Level 30 (warn) and above; quiet by default so MCP protocol traffic
        // is not logged (only application-level events).
        level: Number(process.env["LOG_LEVEL"] ?? 30),
        // Pretty-print when run interactively (TTY) or when explicitly requested.
        transport: pretty
          ? { target: "pino-pretty", options: { colorize: true, destination: 2 } }
          : undefined,
        base: {
          // Strip the pid and hostname fields that pino adds by default — they
          // are noise for a containerised MCP server.
          pid: undefined,
          hostname: undefined,
        },
        // Do not redact anything by default; the platform handles secrets.
        redact: [],
      },
      // pino rejects a destination stream alongside `transport`, so only the
      // non-pretty (plain JSON) path passes one explicitly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pretty ? undefined : (pino as any).destination(2),
    );
  }
  return _logger!;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Emit an INFO-level structured log.
 * Automatically includes the current AsyncLocalStorage context fields.
 */
export function info(msg: string, extra: Record<string, unknown> = {}): void {
  logger().info({ ...getContext(), ...extra }, msg);
}

/**
 * Emit a WARN-level structured log.  Use for expected-but-worthy conditions:
 * rate-limited API calls, skipped optional steps, deprecation notices.
 */
export function warn(msg: string, extra: Record<string, unknown> = {}): void {
  logger().warn({ ...getContext(), ...extra }, msg);
}

/**
 * Emit an ERROR-level structured log.  Includes the Error object as `err`.
 * MCP handlers must NOT use this for user-facing errors (return a structured
 * MCP error response instead); this is for internal failures that operators
 * need to correlate in logs.
 */
export function error(err: unknown, msg: string, extra: Record<string, unknown> = {}): void {
  const e =
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err) };
  logger().error({ ...getContext(), ...extra, err: e }, msg);
}

/**
 * Emit a DEBUG-level structured log.  Only emitted when LOG_LEVEL=20.
 */
export function debug(msg: string, extra: Record<string, unknown> = {}): void {
  logger().debug({ ...getContext(), ...extra }, msg);
}
