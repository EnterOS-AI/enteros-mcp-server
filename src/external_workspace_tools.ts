export interface ExternalWorkspaceTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const EXTERNAL_WORKSPACE_MCP_TOOLS: ExternalWorkspaceTool[] = [
  {
    name: "delegate_task",
    description:
      "Delegate a task to a peer workspace via A2A and WAIT for the response (synchronous). " +
      "Use for QUICK questions and small sub-tasks; for long-running work use " +
      "delegate_task_async + check_task_status so this session does not block.",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to send AS (omit if only one watched)." },
        workspace_id: { type: "string", description: "Target peer workspace ID (from list_peers)." },
        task: { type: "string", description: "Task description to send to the peer." },
      },
      required: ["workspace_id", "task"],
    },
  },
  {
    name: "delegate_task_async",
    description:
      "Send a task to a peer and return immediately with a task_id (non-blocking). " +
      "Poll with check_task_status. The platform A2A queue handles delivery + retries.",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to send AS (omit if only one watched)." },
        workspace_id: { type: "string", description: "Target peer workspace ID (from list_peers)." },
        task: { type: "string", description: "Task description to send to the peer." },
      },
      required: ["workspace_id", "task"],
    },
  },
  {
    name: "check_task_status",
    description:
      "Poll the status of a task started with delegate_task_async; returns the result when done. " +
      "Statuses: pending/in_progress (peer working - wait), queued (peer busy with prior task - " +
      "do not retry), completed (result available), failed (real error).",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id whose delegations to inspect (omit if only one watched)." },
        task_id: { type: "string", description: "task_id (delegation_id) returned by delegate_task_async. Omit to list recent." },
      },
    },
  },
  {
    name: "list_peers",
    description:
      "List the watched workspace's peer agents (siblings, children, parent) as registered " +
      "in the canvas. Use first when you need to delegate but do not know the target's ID. " +
      "Access control is enforced - you only see peers your workspace can reach.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", description: "Watched workspace_id to query peers for (omit if only one watched)." },
        q: { type: "string", description: "Optional case-insensitive substring filter on peer name or role." },
      },
    },
  },
  {
    name: "get_workspace_info",
    description:
      "Get the watched workspace's own info - id, name, role, tier, parent, status, agent_card. " +
      "Use to introspect identity before reporting back to the user or checking role/tier.",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to introspect (omit if only one watched)." },
      },
    },
  },
  {
    name: "send_message_to_user",
    description:
      "Send a message to the user's canvas chat - pushed instantly via WebSocket. Use to " +
      "(1) acknowledge a task immediately, (2) post mid-flight progress updates, (3) deliver " +
      "follow-up results, (4) attach files via the attachments field. Never paste file URLs " +
      "in message; always pass absolute paths in attachments so the platform serves them " +
      "as download chips.",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to send AS (omit if only one watched)." },
        message: { type: "string", description: "Caption text for the chat bubble. Required even with attachments." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Absolute file paths on the local machine. Each is uploaded via /chat/uploads and surfaces as a download chip. 25 MB cap per file.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "commit_memory",
    description:
      "Save a fact to persistent memory; survives across sessions and restarts. " +
      "Scopes: LOCAL (private to this workspace), TEAM (shared with parent + siblings), " +
      "GLOBAL (entire org - only tier-0 roots can write).",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to commit AS (omit if only one watched)." },
        content: { type: "string", description: "What to remember - be specific." },
        scope: { type: "string", enum: ["LOCAL", "TEAM", "GLOBAL"], description: "Memory scope (default LOCAL)." },
      },
      required: ["content"],
    },
  },
  {
    name: "recall_memory",
    description:
      "Search persistent memory; returns matching LOCAL + TEAM + GLOBAL rows. " +
      "Empty query returns all accessible memories and avoids missing rows that do not match a narrow keyword.",
    inputSchema: {
      type: "object",
      properties: {
        _as_workspace: { type: "string", description: "Watched workspace_id to recall FROM (omit if only one watched)." },
        query: { type: "string", description: "Search query (empty returns all)." },
        scope: { type: "string", enum: ["LOCAL", "TEAM", "GLOBAL", ""], description: "Filter by scope (empty = all accessible)." },
      },
    },
  },
];

export const EXTERNAL_WORKSPACE_TOOL_NAMES = EXTERNAL_WORKSPACE_MCP_TOOLS.map((tool) => tool.name);

export function externalWorkspaceToolByName(name: string): ExternalWorkspaceTool | undefined {
  return EXTERNAL_WORKSPACE_MCP_TOOLS.find((tool) => tool.name === name);
}
