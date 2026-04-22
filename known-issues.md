# Known Issues — molecule-mcp-server

Issues identified in source but not yet filed as GitHub issues (GH_TOKEN
unavailable in automated agent contexts). Each entry has: location,
symptom, impact, suggested fix.

Format per entry:
```
## KI-N — Short title

**File:** `<path>:<line>`
**Status:** TODO comment / identified / partially fixed
**Severity:** Critical / High / Medium / Low

### Symptom
...

### Impact
...

### Suggested fix
...
---
```

---

## KI-001 — No structured logging; all errors go to console.log

**File:** `src/index.ts`, `src/api.ts` (and potentially all tool handlers)
**Status:** ✅ Resolved
**Severity:** Medium

### Resolution
Replaced all `console.log/error` calls with structured JSON logging via
[pino](https://getpino.io) (`src/utils/logger.ts`). The logger:

- Emits JSON by default (production); pretty-prints when `NODE_ENV != "production"`
  or stdout is a TTY.
- Level is controlled by `LOG_LEVEL` env var (default: `30` = warn; set `20` for debug).
- Uses Node.js `AsyncLocalStorage` (`src/utils/context.ts`) to propagate
  per-call context (`toolName`, `requestId`, `workspaceId`) into all downstream
  log entries automatically — no need to thread context through every function.
- Errors include `{ message, stack, name }` in the `err` field.

Files changed:
- `package.json` — added `pino@^9.6.0`, `pino-pretty@^13.0.0`
- `src/utils/context.ts` — new; `AsyncLocalStorage` context + `getContext()`, `withContext()`
- `src/utils/logger.ts` — new; `info()`, `warn()`, `error()`, `debug()` helpers
- `src/api.ts` — both `console.error` → `logError(…)`
- `src/index.ts` — all `console.error` → `logInfo()`/`logWarn()`/`logError()`

### What was NOT changed (follow-up)
Tool handlers that want to emit application-level log events (e.g. "installed
plugin X", "delegated to workspace Y") should import and call `info()`/`warn()`
directly. The `AsyncLocalStorage` context is already active during handler
execution so those calls automatically carry `toolName` etc.

Correlation IDs from a platform trace header (`X-Trace-ID`) are not yet wired up —
the MCP SDK does not expose request headers to handlers. A follow-up will be needed
once the SDK supports header access or we adopt a middleware approach.

---

## KI-002 — Tool input schemas are not validated before passing to handlers

**File:** `src/tools/*.ts` (tool handlers)
**Status:** Resolved — validation is handled by the MCP SDK framework
**Severity:** High

### Resolution
The `@modelcontextprotocol/sdk` server framework (`src/server/mcp.js`) calls
`validateToolInput(tool, args, toolName)` before dispatching to any handler.
It uses `safeParseAsync()` against the tool's `inputSchema` (a Zod object
or raw shape) and throws `McpError(ErrorCode.InvalidParams, ...)` on parse
failure — which the SDK maps to an `INVALID_ARGUMENTS` MCP response.

Concretely:

1. `srv.tool(name, desc, inputSchema, handler)` registers the schema.
2. On every call, the SDK calls `validateToolInput(tool, request.params.arguments)`.
3. `safeParseAsync(schemaToParse, args)` runs — `args` must match the Zod schema.
4. On failure, an `INVALID_ARGUMENTS` MCP error is returned. **Handlers never
   receive invalid input** — the SDK short-circuits before the handler is called.

Each handler in `src/tools/*.ts` therefore does **not** need its own Zod
validation layer. Adding one would be redundant. The existing `srv.tool(..., inputSchema)`
registration is sufficient and already satisfies the KI requirement.

### What would break this
If a tool's `inputSchema` is missing required fields, or if `safeParseAsync`
fails for a valid input (e.g. due to `anyOf` in the generated JSON Schema —
see KI-006), the validation would incorrectly reject valid calls.

---

## KI-003 — `test.txt` artifact left in repo root

**File:** `test.txt` (root)
**Status:** Resolved
**Resolved in:** main branch commit `b422105` removed test.txt as part of CLAUDE.md merge.

### Symptom
A 5-byte file named `test.txt` with content `"test"` existed in the repo root.
This was a leftover debug artifact with no legitimate purpose.

### Impact
Clutter. Could have been accidentally included in the npm package if `files` in
`package.json` was ever set to include all non-ignored files.

---

## KI-004 — No rate limiting or backpressure on platform API calls

**File:** `src/api.ts`, `src/tools/*.ts`
**Status:** Resolved (PR: `feat/mcp-rate-limiting`)
**Severity:** Medium

### Resolution
Added `platformGet()` in `src/api.ts` — a GET helper with automatic retry
on 429 (Too Many Requests). It respects the `Retry-After` header (seconds,
rounded up to ms); when absent it uses exponential backoff with ±25% jitter
(starting at 1 s, doubling each attempt, capped at 30 s). After 3 retries
it returns `{ error: "RATE_LIMITED", detail: … }` so callers get a
structured `RATE_LIMITED` MCP error code. All 37 GET calls across the 12
tool modules now use `platformGet()` instead of `apiCall("GET", …)`. POST,
PUT, PATCH, DELETE calls continue to use `apiCall` (non-idempotent).
`platformGet` is also re-exported from `src/index.ts` for SDK consumers.

---

## KI-005 — Streaming tools do not honour cancellation signals

**File:** `src/tools/` (streaming-capable tool handlers)
**Status:** Identified
**Severity:** Low

### Symptom
If a streaming tool is cancelled mid-stream (the MCP host closes the connection
or sends a cancellation signal), the handler continues emitting chunks until
the full response is complete. There is no check for cancellation before each
chunk emission.

### Impact
Cancelled requests continue consuming platform API resources (and possibly
incurring cost) even after the client has disconnected. Chunks emitted after
cancellation are silently dropped by the transport but still consumed
upstream.

### Suggested fix
If the MCP server library exposes a cancellation token or abort signal,
check it before each `ContentBlock` emission and stop cleanly (close the
stream without error) if cancelled. Document the behaviour in the streaming
convention in CLAUDE.md.

---

## KI-006 — `anyOf` schemas cause `INVALID_ARGUMENTS` on valid inputs

**File:** `src/tools/plugins.ts`, `src/tools/workspaces.ts`
**Status:** Resolved (PR: `fix/kind-ki006-anyof` #5)
**Severity:** Medium

### Resolution
The root cause was `z.string().optional().nullable()` (zod chain order) in the
`update_workspace` tool's `parent_id` schema. `zod-to-json-schema` with
`strictUnions: true` produces `anyOf` for the `optional().nullable()` chain, but
`nullable().optional()` produces a clean `type: ["string","null"]` with no `anyOf`.

Fix: changed `z.string().nullable().optional()` → `z.string().optional().nullable()`
in `src/tools/workspaces.ts:122`. Semantically equivalent (string | null | undefined),
no runtime behaviour change.

Regression guard added in `tests/__tests__/plugins-schema.test.ts`: mirrors all 6
plugin tool schemas and asserts no `anyOf` in JSON Schema output. Includes a control
test documenting the known `optional().nullable()` zod-to-json-schema quirk.

---

## KI-007 — Heartbeat cleanup fires after SSE stream closes

**File:** `src/tools/remote_agents.ts` (heartbeat tool)
**Status:** Identified
**Severity:** Low

### Symptom
When using SSE transport, the heartbeat mechanism does not immediately clean up
when a stream closes. A background timer or goroutine may continue sending heartbeats
to workspaces whose SSE connections have been closed by the client.

### Impact
Orphaned heartbeat calls continue consuming platform API quota after the MCP client
has disconnected. Over time this can cause the workspace to accumulate heartbeat
sessions that never expire on the platform side.

### Suggested fix
Attach a cleanup function to the SSE stream `close` event. Invalidate the heartbeat
timer when the stream ends so no further calls are made. Document the expected
SSE session lifecycle in the streaming convention section of CLAUDE.md.