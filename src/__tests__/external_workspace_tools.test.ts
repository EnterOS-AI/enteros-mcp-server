import {
  EXTERNAL_WORKSPACE_MCP_TOOLS,
  EXTERNAL_WORKSPACE_TOOL_NAMES,
  externalWorkspaceToolByName,
} from "../external_workspace_tools.js";

describe("EXTERNAL_WORKSPACE_MCP_TOOLS", () => {
  it("pins the universal external-workspace MCP tool names", () => {
    expect(EXTERNAL_WORKSPACE_TOOL_NAMES).toEqual([
      "delegate_task",
      "delegate_task_async",
      "check_task_status",
      "list_peers",
      "get_workspace_info",
      "send_message_to_user",
      "commit_memory",
      "recall_memory",
    ]);
  });

  it("keeps schemas JSON-schema shaped and required fields explicit", () => {
    for (const tool of EXTERNAL_WORKSPACE_MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeTruthy();
    }
    expect(externalWorkspaceToolByName("delegate_task")?.inputSchema.required).toEqual(["workspace_id", "task"]);
    expect(externalWorkspaceToolByName("send_message_to_user")?.inputSchema.required).toEqual(["message"]);
  });
});
