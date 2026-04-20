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
