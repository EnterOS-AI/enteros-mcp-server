# molecule-mcp-server

TypeScript MCP server that exposes the Molecule AI agent platform as tools via the Model Context Protocol (MCP).

## Project Overview

This server acts as a bridge between MCP clients (e.g., Claude Desktop, other MCP-compatible hosts) and the Molecule AI platform. It registers platform capabilities as MCP tools so agents can interact with the platform natively.

## Build and Test

```bash
# Install dependencies
npm install

# Build (TypeScript -> JS, output to dist/)
npm run build

# Run tests (Jest, config in jest.config.cjs)
npm test

# Type check without building
npm run lint    # if present
```

Watch mode for development:

```bash
npm run build -- --watch
```

## MCP Tool Conventions

All tools follow these conventions to ensure consistent behavior across the server.

### Naming

- Tool names: `snake_case` (e.g., `list_workspaces`, `create_agent`)
- Resource names: `camelCase` prefixed by type (e.g., `workspace:default`)
- Always use present tense imperatives for actions (list, create, delete, not `listing`)

### Error Codes

Use structured errors with known codes — never throw plain strings:

| Code | Meaning |
|------|---------|
| `TOOL_NOT_FOUND` | Tool/resource name not registered |
| `INVALID_ARGUMENTS` | Arguments failed schema validation |
| `PLATFORM_ERROR` | Upstream platform API error |
| `AUTH_ERROR` | Authentication/authorization failure |
| `RATE_LIMITED` | Platform rate limit hit |
| `INTERNAL_ERROR` | Unexpected server-side failure |

All tool responses wrap errors in the MCP `error` shape — never return error text as a plain string in `content`.

### Streaming Behavior

- If a tool supports streaming, declare it in the tool manifest
- Stream results incrementally via `ContentBlock` chunks — do not buffer and return all at once
- On cancellation, stop emitting and close the stream cleanly (no half-written responses)

### Tool Schema

Every tool must have a JSON Schema (Draft 7) `inputSchema`. Keep it minimal — only expose parameters the server actually uses. Do not mirror the full platform API surface if MCP does not need it.

## Release Process

Releases are automated via Gitea Actions on every tag matching `v*`.

### Cutting a Release

1. Land the `package.json` version bump through a normal reviewed PR; never push
   a release commit directly to `main`.
2. After explicit release approval, verify the intended commit is the current
   green `main`, create `vX.Y.Z` at that exact commit, and push only the tag.

The workflow (`.gitea/workflows/publish.yml`):
1. Pushes `v*` tag → triggers the `publish.yml` Gitea Actions workflow
2. Workflow runs `npm install`, `npm run build:manifest`, `npm test`
3. On success: publishes to the **private Gitea npm registry** for the
   `@molecule-ai` scope (`npm publish --registry
   https://git.moleculesai.app/api/packages/molecule-ai/npm/`), authenticating
   with `MOL_PACKAGE_TOKEN` fetched from the Infisical SSOT — **not** public npm

**Do not publish manually.** Let the tag push flow handle it.

## Platform Integration

### APIs Connected

The server connects to the Molecule AI platform REST API via its own TypeScript
client (`src/api.ts`). It does not use the Python SDK (`molecule-ai-sdk`) —
the Python SDK is for remote agents that run outside the platform; this server
connects through the configured Molecule platform API.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MOLECULE_API_URL` | Yes | Per-tenant workspace API base (`https://<slug>.moleculesai.app` in SaaS) |
| `MOLECULE_API_KEY` | Yes in SaaS | Tenant API bearer; optional only for a no-auth localhost stack |

Set these values in the MCP host configuration or the launching shell. The
entrypoint does not load a repository `.env` file.

### Postgres

Platform data lives in Postgres (source of truth). The server reads data via the platform REST API — it does not connect to Postgres directly.

## TypeScript Conventions

### Async Patterns

- Use `async`/`await` throughout — no `.then()` chains except for bridging legacy callback code
- Every handler function is `async`
- Never use `void` async functions unless the MCP spec explicitly requires fire-and-forget

### Error Handling

- Never `console.log` user-facing errors — use structured logging and return MCP errors
- Wrap every tool handler in a `try/catch`; catch errors and re-throw as MCP-structured errors
- Avoid non-Error throws (numbers, strings) — always throw or return `Error` instances

### Typing Standards

- Strict mode is enabled (`"strict": true` in `tsconfig.json`)
- Avoid `any` — use `unknown` and narrow with type guards or Zod validators
- Use `zod` for all external input validation (API args, tool schemas)
- Export shared interfaces from the module that owns them, then re-export public
  contracts from `src/index.ts` when consumers need them.

### File Structure

```
src/
  index.ts          # Server entry point
  tools/            # MCP tool implementations
  utils/            # Helpers, validators
```

## MCP Tool Registry

`npm run build:manifest` composes the real server in both modes and writes the
authoritative names, descriptions, and schemas to `dist/manifest.json`. The
current generated totals are **93 workspace-mode tools** and **46
management-mode tools**, ratcheted by the registration tests. The tables below
are a workspace-mode reference, not an exhaustive registry.

### Workspace Tools (9)
| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces with their status, skills, and hierarchy |
| `create_workspace` | Create a new workspace node on the canvas |
| `get_workspace` | Get detailed information about a specific workspace |
| `update_workspace` | Update workspace fields (name, role, tier, parent_id, position) |
| `delete_workspace` | Delete a workspace (cascades to children) |
| `restart_workspace` | Restart an offline or failed workspace |
| `pause_workspace` | Pause a workspace (stops container, preserves config) |
| `provision_workspace` | Provision a new workspace with runtime validation and read-back verification |
| `resume_workspace` | Resume a paused workspace |

### Agent Tools (6)
| Tool | Description |
|------|-------------|
| `chat_with_agent` | Send a message to a workspace agent and get a response |
| `assign_agent` | Assign an AI model to a workspace |
| `replace_agent` | Replace the model on an existing workspace agent |
| `remove_agent` | Remove the agent from a workspace |
| `move_agent` | Move an agent from one workspace to another |
| `get_model` | Get current model configuration for a workspace |

### Delegation Tools (8)
| Tool | Description |
|------|-------------|
| `async_delegate` | Delegate a task to another workspace (non-blocking, returns delegation_id) |
| `check_delegations` | Check status of delegated tasks for a workspace |
| `record_delegation` | Register an agent-initiated delegation with the activity log |
| `update_delegation_status` | Mirror delegation status to activity_logs (completed or failed) |
| `report_activity` | Write an arbitrary activity log row from an agent |
| `list_activity` | List activity logs for a workspace (A2A, tasks, errors) |
| `notify_user` | Push a notification from the agent to the canvas via WebSocket |
| `list_traces` | List recent LLM traces from Langfuse for a workspace |

### Secrets Tools (6)
| Tool | Description |
|------|-------------|
| `set_secret` | Set an API key or environment variable for a workspace |
| `list_secrets` | List secret keys for a workspace (values never exposed) |
| `delete_secret` | Delete a secret from a workspace |
| `list_global_secrets` | List global secret keys (values never exposed) |
| `set_global_secret` | Set a global secret (available to all workspaces) |
| `delete_global_secret` | Delete a global secret |

### Files Tools (7)
| Tool | Description |
|------|-------------|
| `list_files` | List workspace config files (skills, prompts, config.yaml) |
| `read_file` | Read a workspace config file |
| `write_file` | Write or create a workspace config file |
| `delete_file` | Delete a workspace file or folder |
| `replace_all_files` | Replace all workspace config files at once |
| `get_config` | Get workspace runtime config as JSON |
| `update_config` | Update workspace runtime config |

### Memory Tools (8)
| Tool | Description |
|------|-------------|
| `commit_memory` | Store a fact in workspace memory (LOCAL, TEAM, or GLOBAL scope) |
| `search_memory` | Search workspace memories |
| `delete_memory` | Delete a specific memory entry |
| `session_search` | Search recent session activity and memory (FTS) |
| `memory_set` | Set a key-value memory entry with optional TTL |
| `memory_get` | Read a single K/V memory entry |
| `memory_list` | List all K/V memory entries for a workspace |
| `memory_delete_kv` | Delete a single K/V memory entry |

### Plugins Tools (7)
| Tool | Description |
|------|-------------|
| `list_plugin_registry` | List all available plugins from the registry |
| `list_installed_plugins` | List plugins installed in a workspace |
| `install_plugin` | Install a plugin into a workspace (auto-restarts) |
| `uninstall_plugin` | Remove a plugin from a workspace (auto-restarts) |
| `list_plugin_sources` | List registered plugin install-source schemes |
| `list_available_plugins` | List plugins from registry filtered by workspace runtime |
| `check_plugin_compatibility` | Preflight: which installed plugins would break if runtime changed? |

### Channels Tools (8)
| Tool | Description |
|------|-------------|
| `list_channel_adapters` | List available social channel adapters (Telegram, Slack, etc.) |
| `list_channels` | List social channels connected to a workspace |
| `add_channel` | Connect a social channel to a workspace |
| `update_channel` | Update a channel's config, enabled state, or allowed users |
| `remove_channel` | Remove a social channel from a workspace |
| `send_channel_message` | Send an outbound message from a workspace to a channel |
| `test_channel` | Send a test message to verify a channel connection |
| `discover_channel_chats` | Auto-detect chat IDs for a given bot token |

### Schedules Tools (6)
| Tool | Description |
|------|-------------|
| `list_schedules` | List cron schedules for a workspace |
| `create_schedule` | Create a cron schedule that fires a prompt on a recurring timer |
| `update_schedule` | Update fields on an existing schedule |
| `delete_schedule` | Delete a schedule |
| `run_schedule` | Fire a schedule manually, bypassing its cron expression |
| `get_schedule_history` | Get past runs of a schedule — status, start/end, output |

### Discovery Tools (12)
| Tool | Description |
|------|-------------|
| `list_peers` | List reachable peer workspaces (siblings, children, parent) |
| `discover_workspace` | Resolve a workspace URL by ID (for A2A communication) |
| `check_access` | Check if two workspaces can communicate |
| `list_events` | List structure events (global or per workspace) |
| `list_templates` | List available workspace templates |
| `list_org_templates` | List available org templates |
| `import_org` | Import an org template to create an entire workspace hierarchy |
| `import_template` | Import agent files as a new workspace template |
| `export_bundle` | Export a workspace as a portable .bundle.json |
| `import_bundle` | Import a workspace from a bundle JSON object |
| `get_canvas_viewport` | Get the current canvas viewport (x, y, zoom) |
| `set_canvas_viewport` | Persist the canvas viewport (x, y, zoom) |

### Remote Agents Tools (4)
| Tool | Description |
|------|-------------|
| `list_remote_agents` | List all workspaces with runtime='external' (Phase 30 remote agents) |
| `get_remote_agent_state` | Lightweight state poll for a remote workspace |
| `get_remote_agent_setup_command` | Build a bash command to register an agent on a remote machine |
| `check_remote_agent_freshness` | Check if a remote agent's heartbeat is recent |

### Approvals Tools (4) — DEPRECATED shims over the unified requests subsystem
These keep their original names and signatures (backward-compatible) but now
route to the unified `/requests` endpoints with `kind=approval` (RFC
"unified-requests-inbox", P5). New approvals land in the unified `requests`
table and surface in the unified inbox/Approvals tab. Prefer the Requests /
Inbox tools (`create_request` / `respond_request` / `list_inbox` /
`check_requests`) for new work.

| Tool | Description | Routes to |
|------|-------------|-----------|
| `list_pending_approvals` | List all pending approval requests across workspaces | `GET /requests/pending?kind=approval` |
| `decide_approval` | Approve or deny a pending approval request (legacy `denied` -> `rejected`) | `POST /workspaces/:id/requests/:id/respond` |
| `create_approval` | Create an approval request for a workspace | `POST /workspaces/:id/requests` (kind=approval) |
| `get_workspace_approvals` | List requests raised by a specific workspace | `GET /workspaces/:id/requests` |

## MCP Transport

The executable implements stdio only (`StdioServerTransport`). It has no HTTP
listener, port setting, transport selector, or command-line update/help parser.
Keep stdout reserved for MCP frames; diagnostics use the repository logger on
stderr. On Windows, use an absolute executable path with JSON-safe separators in
the host configuration.

## Claude Desktop Configuration

Add this server to Claude Desktop via `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux:** `~/.config/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "molecule-ai": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "MOLECULE_API_URL": "https://<slug>.moleculesai.app",
        "MOLECULE_API_KEY": "your-tenant-api-key-here"
      }
    }
  }
}
```

Build and verify that the configured entrypoint exists:
```bash
npm run build
test -f dist/index.js
```

After editing the config, restart Claude Desktop (fully quit, then reopen) to load the new server.

## Known Issues

See `known-issues.md` at the repo root for the full tracked list.
