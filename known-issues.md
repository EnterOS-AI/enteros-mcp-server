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

## KI-006 — `anyOf` schemas cause `INVALID_ARGUMENTS` on valid inputs

**File:** `src/tools/plugins.ts` (and other tools with union-typed schemas)  
**Status:** Identified  
**Severity:** Medium

### Symptom
Tool `inputSchema` definitions that use JSON Schema `anyOf` to express union types
(e.g., `anyOf: [{ type: "string" }, { type: "null" }]`) are not handled correctly by
the MCP JSON Schema validator. Even when the actual input matches a valid branch of
the `anyOf`, validation fails and returns `INVALID_ARGUMENTS`.

### Impact
Tools using optional or nullable fields defined with `anyOf` reject all calls,
breaking plugin installation and other workflows that depend on those tools.

### Suggested fix
Replace `anyOf` with nullable types directly (`{ type: "string", nullable: true }`)
or flatten the schema to use oneOf with concrete variants. Alternatively, pre-process
the schema before passing to the validator to normalize `anyOf` into supported forms.

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

---

## KI-002 — Tool input schemas are not validated before passing to handlers

**File:** `src/tools/*.ts` (tool handlers)  
**Status:** Resolved  
**Severity:** High

### Resolution
The `@modelcontextprotocol/sdk` server framework already calls
`validateToolInput(tool, args, toolName)` before dispatching to any handler.
It uses `zod.safeParseAsync()` against the tool's `inputSchema` (a Zod object
or raw shape) and returns `INVALID_ARGUMENTS` on parse failure — no handler
code change needed. Each tool's `srv.tool(..., inputSchema)` already satisfies
this requirement.

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
