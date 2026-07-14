# Molecule AI MCP Server

MCP server that exposes Molecule AI platform operations as tools for AI coding agents.

## 87 Tools Available

See the [full tool registry](CLAUDE.md#mcp-tool-registry) for all tools. Highlights:

| Category | Tools |
|----------|-------|
| Workspace | list, create, get, update, delete, restart, pause, resume |
| Agent | chat_with, assign, replace, remove, move, get_model |
| Delegation | async_delegate, check_delegations, record_delegation, notify_user, list_activity |
| Secrets | set, list, delete (workspace + global variants) |
| Files | list, read, write, delete, replace_all, get_config, update_config |
| Memory | commit, search, delete (HMA scopes) + memory_set/get/list/delete (K/V) |
| Plugins | list registry, list installed, install, uninstall, list sources, check compatibility |
| Channels | list adapters, list, add, update, remove, send, test, discover chats |
| Schedules | list, create, update, delete, run, get history |
| Discovery | list peers, discover, check_access, list events, import/export, canvas viewport |
| Requests / Inbox | `create_request`, `list_inbox`, `check_requests`, `get_request`, `respond_request`, `add_request_message`, `cancel_request` (unified Tasks + Approvals) |
| Approvals *(deprecated)* | `list_pending_approvals`, `decide_approval`, `create_approval`, `get_workspace_approvals` — backward-compatible shims that route to the unified requests system (`kind='approval'`); prefer the Requests / Inbox tools |
| Remote Agents | list (runtime=external), get state, setup command, check freshness |

## Setup

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "molecule": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "MOLECULE_API_URL": "https://<slug>.moleculesai.app",
        "MOLECULE_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

`MOLECULE_API_KEY` is sent as `Authorization: Bearer <key>` on every platform
request. It may be omitted only against a no-auth localhost dev platform
(`MOLECULE_API_URL=http://localhost:8080`); any real tenant host requires it or
every call 401s. The control-plane domain (`api.moleculesai.app`) is not the
single-tenant workspace API used by the default registry.

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "molecule": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "MOLECULE_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

### Codex / OpenCode

```bash
MOLECULE_API_URL=http://localhost:8080 node mcp-server/dist/index.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOLECULE_API_URL` | `http://localhost:8080` | Platform API base URL |
| `MOLECULE_API_KEY` | — | API key for platform authentication |
| `MCP_SERVER_PORT` | `3000` | Port (for HTTP/SSE transport) |

## Quick Start

1. `npm install && npm run build`
2. Set `MOLECULE_API_URL` and `MOLECULE_API_KEY`
3. `npm start` (stdio mode) or use an MCP host config

## Examples

```
You: "Create an SEO agent workspace using the seo-agent template"
Agent: [calls create_workspace with template="seo-agent"]

You: "Set the OpenRouter API key for the SEO workspace"
Agent: [calls set_secret with key="OPENROUTER_API_KEY"]

You: "Ask the SEO agent to audit my homepage"
Agent: [calls chat_with_agent with message="Audit https://example.com for SEO"]

You: "What skills does the coding agent have?"
Agent: [calls get_workspace, reads agent_card.skills]
```

## Management MCP (cross-org / org-lifecycle surface)

The default registry above is **single-tenant workspace-ops** against one
tenant's workspace-server. The server also ships a **management registry** —
the org-lifecycle / management surface — selected with
`MOLECULE_MCP_MODE=management`. It is the *same* server and conventions, run in
a distinct mode (the two registries are mutually exclusive in one process
because several tool names overlap).

### Tools (§5(a))

| Group | Tools |
|-------|-------|
| Workspaces | `list_workspaces`, `get_workspace`, `provision_workspace`, `deprovision_workspace`, `restart_workspace`, `pause_workspace`, `resume_workspace` |
| Secrets | `set_workspace_secret`, `list_workspace_secrets`, `delete_workspace_secret`, `set_org_secret`, `list_org_secrets`, `delete_org_secret` |
| Budget / billing | `set_workspace_budget`, `set_llm_billing_mode` |
| Templates / org import | `list_org_templates`, `create_org_from_template`, `list_templates`, `import_template` |
| Tokens | `mint_org_token`, `list_org_tokens`, `revoke_org_token`, `mint_workspace_token` |
| Plugin governance | `get_org_plugin_allowlist`, `set_org_plugin_allowlist` |
| Bundles | `export_bundle`, `import_bundle` |
| Audit | `list_org_events`, `list_pending_approvals` *(deprecated shim → `/requests/pending?kind=approval`)* |
| **CP-tier (gated)** | `list_orgs`, `get_org` |

Each tool's input schema, endpoint, and request body are derived from the
canonical tenant router/handler source
(`molecule-core/workspace-server/internal/router/router.go` +
`internal/handlers/*`) — the same source the management OpenAPI is being
authored from.

### Auth model — Org API Key (tenant credential)

The management tools authenticate with the **Org API Key** (dashboard → "Org
API Keys"), presented to the **per-org tenant host**
(`<slug>.moleculesai.app`) as:

```
Authorization: Bearer ${MOLECULE_ORG_API_KEY}
X-Molecule-Org-Id: ${MOLECULE_ORG_ID}
```

The Org API Key is `org_api_tokens` (sha256-hashed, prefixed, revocable). It
satisfies the tenant `AdminAuth` / `WorkspaceAuth` gates, and the tenant
`TenantGuard` requires the `X-Molecule-Org-Id` header to match the tenant
selected by the routed host.

> **⚠ Security — the Org API Key is full-tenant-admin AND self-minting.** It
> authorizes the entire tenant-admin surface of its own org (workspaces,
> secrets, templates, bundles) and can mint/revoke *more* Org API Keys via
> `mint_org_token` / `revoke_org_token`. **A management MCP holding one holds
> tenant root.** There is no scope-down below full-admin today; per-role /
> per-workspace scoping is a planned follow-up. Treat `MOLECULE_ORG_API_KEY`
> as a root credential — store it in a secrets manager, never in source.

### CP-tier caveat (`list_orgs` / `get_org`)

The Org API Key is a **tenant** credential and **cannot reach the control
plane** — CP `/api/v1/orgs/*` (org create/delete/export/members/billing)
401/403 the org key. `list_orgs` / `get_org` are therefore kept in a clearly
separated CP-admin module and **gated** on `CP_ADMIN_API_TOKEN`. When that
token is absent they return a structured `CP_TIER_NOT_CONFIGURED` result (not
a silent failure) and make no network call. Member/billing management tools
need the same CP session tier and are intentionally out of scope for the
org-key MCP.

### Management env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `MOLECULE_MCP_MODE` | Yes | Set to `management` to run the management registry |
| `MOLECULE_API_URL` | Yes | The **tenant host** base URL (`https://<slug>.moleculesai.app`) |
| `MOLECULE_ORG_API_KEY` | Yes | Org API Key (full-tenant-admin; see security note) |
| `MOLECULE_ORG_ID` | Yes | Org id for the `X-Molecule-Org-Id` tenant-guard header |
| `MOLECULE_ORG_SLUG` | No | Optional `X-Molecule-Org-Slug` header |
| `CP_ADMIN_API_TOKEN` | No | CP admin bearer — required only for the CP-tier `list_orgs` / `get_org` tools |
| `MOLECULE_CP_URL` | No | Control-plane base URL (default `https://api.moleculesai.app`) |

### Management host config

```json
{
  "mcpServers": {
    "molecule-platform": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"],
      "env": {
        "MOLECULE_MCP_MODE": "management",
        "MOLECULE_API_URL": "https://agents-team.moleculesai.app",
        "MOLECULE_ORG_API_KEY": "<org-api-key>",
        "MOLECULE_ORG_ID": "<org-id>"
      }
    }
  }
}
```

## Remote Agents (Phase 30)

For agents running outside the platform's Docker network, the `get_remote_agent_setup_command`
tool generates a bash one-liner:

```bash
pip install molecule-ai-sdk
WORKSPACE_ID=... PLATFORM_URL=... python3 -c "from molecule_external_workspace import RemoteAgentClient; ..."
```

See the full tool registry in `CLAUDE.md` for all 87 tools.
