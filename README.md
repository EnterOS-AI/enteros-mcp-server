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
| Approvals | list pending, decide, create, get workspace approvals |
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
        "MOLECULE_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

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

## Remote Agents (Phase 30)

For agents running outside the platform's Docker network, the `get_remote_agent_setup_command`
tool generates a bash one-liner:

```bash
pip install molecule-ai-sdk
WORKSPACE_ID=... PLATFORM_URL=... python3 -c "from molecule_agent import RemoteAgentClient; ..."
```

See the full tool registry in `CLAUDE.md` for all 87 tools.
