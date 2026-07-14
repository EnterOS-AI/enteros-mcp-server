#!/usr/bin/env node
/**
 * Molecule AI MCP Server
 *
 * Exposes Molecule AI platform operations as MCP tools so any AI coding agent
 * (Claude Code, Cursor, Codex, OpenCode) can manage workspaces, agents,
 * skills, and memory.
 *
 * Transport: stdio (for local CLI integration)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PLATFORM_URL, apiCall, platformGet, isApiError } from "./api.js";
import { info as logInfo, warn as logWarn, error as logError } from "./utils/logger.js";
import { registerWorkspaceTools } from "./tools/workspaces.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerSecretTools } from "./tools/secrets.js";
import { registerFileTools } from "./tools/files.js";
import { registerMemoryTools } from "./tools/memory.js";
import { registerPluginTools } from "./tools/plugins.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerDelegationTools } from "./tools/delegation.js";
import { registerScheduleTools } from "./tools/schedules.js";
import { registerApprovalTools } from "./tools/approvals.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerRemoteAgentTools } from "./tools/remote_agents.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerRequestTools } from "./tools/requests.js";
import { registerManagementTools } from "./tools/management/index.js";

// Re-exports so existing importers (tests, SDK consumers) keep working.
// Explicit names (not `export *`) so tree-shakers and TS readers can see
// exactly which handlers are part of the public surface, and a missing
// export triggers a compile error instead of a silent undefined at import.
export { PLATFORM_URL, apiCall, isApiError, platformGet, toMcpResult, toMcpText } from "./api.js";
export type { ApiError } from "./api.js";
// RFC#640 Layer B — chat-upload resolution flow. MANDATORY surface for
// any /activity-polling adapter (channel plugin, telegram-style
// adapters, codex bridges) that consumes chat_upload_receive rows.
// See molecule_runtime/a2a_mcp_server.py::_build_channel_instructions
// "Upload resolution (MANDATORY...)" for the spec.
export {
  URICache,
  URI_CACHE_MAX_ENTRIES,
  resolvePendingUpload,
  rewritePendingURIs,
  isChatUploadReceiveRow,
} from "./inbox-uploads.js";
export type {
  ResolveUploadOptions,
  ResolveUploadResult,
} from "./inbox-uploads.js";
export { formatTargetSummary, parseWorkspaceTargets } from "./targets.js";
export type { WorkspaceTarget } from "./targets.js";
export {
  EXTERNAL_WORKSPACE_MCP_TOOLS,
  EXTERNAL_WORKSPACE_TOOL_NAMES,
  externalWorkspaceToolByName,
} from "./external_workspace_tools.js";
export type { ExternalWorkspaceTool } from "./external_workspace_tools.js";

export {
  registerWorkspaceTools,
  handleListWorkspaces,
  handleCreateWorkspace,
  handleProvisionWorkspace,
  handleGetWorkspace,
  handleDeleteWorkspace,
  handleRestartWorkspace,
  handleUpdateWorkspace,
  handlePauseWorkspace,
  handleResumeWorkspace,
} from "./tools/workspaces.js";

export {
  registerAgentTools,
  handleChatWithAgent,
  handleAssignAgent,
  handleReplaceAgent,
  handleRemoveAgent,
  handleMoveAgent,
  handleGetModel,
} from "./tools/agents.js";

export {
  registerSecretTools,
  handleSetSecret,
  handleListSecrets,
  handleDeleteSecret,
  handleListGlobalSecrets,
  handleSetGlobalSecret,
  handleDeleteGlobalSecret,
} from "./tools/secrets.js";

export {
  registerFileTools,
  handleListFiles,
  handleReadFile,
  handleWriteFile,
  handleDeleteFile,
  handleReplaceAllFiles,
  handleGetConfig,
  handleUpdateConfig,
} from "./tools/files.js";

export {
  registerMemoryTools,
  handleCommitMemory,
  handleSearchMemory,
  handleDeleteMemory,
  handleSessionSearch,
  handleSetKV,
  handleGetKV,
  handleListKV,
  handleDeleteKV,
} from "./tools/memory.js";

export {
  registerPluginTools,
  handleListPluginRegistry,
  handleListInstalledPlugins,
  handleInstallPlugin,
  handleUninstallPlugin,
  handleListPluginSources,
  handleListAvailablePlugins,
  handleCheckPluginCompatibility,
} from "./tools/plugins.js";

export {
  registerChannelTools,
  handleListChannelAdapters,
  handleListChannels,
  handleAddChannel,
  handleUpdateChannel,
  handleRemoveChannel,
  handleSendChannelMessage,
  handleTestChannel,
  handleDiscoverChannelChats,
} from "./tools/channels.js";

export {
  registerDelegationTools,
  handleAsyncDelegate,
  handleCheckDelegations,
  handleRecordDelegation,
  handleUpdateDelegationStatus,
  handleReportActivity,
  handleListActivity,
  handleNotifyUser,
  handleListTraces,
} from "./tools/delegation.js";

export {
  registerScheduleTools,
  handleListSchedules,
  handleCreateSchedule,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleRunSchedule,
  handleGetScheduleHistory,
} from "./tools/schedules.js";

export {
  registerApprovalTools,
  handleListPendingApprovals,
  handleDecideApproval,
  handleCreateApproval,
  handleGetWorkspaceApprovals,
} from "./tools/approvals.js";

export {
  registerDiscoveryTools,
  handleListPeers,
  handleDiscoverWorkspace,
  handleCheckAccess,
  handleListEvents,
  handleListTemplates,
  handleListOrgTemplates,
  handleImportOrg,
  handleImportTemplate,
  handleExportBundle,
  handleImportBundle,
  handleGetViewport,
  handleSetViewport,
} from "./tools/discovery.js";

export {
  registerRemoteAgentTools,
  handleListRemoteAgents,
  handleGetRemoteAgentState,
  handleGetRemoteAgentSetupCommand,
  handleCheckRemoteAgentFreshness,
} from "./tools/remote_agents.js";

// Management registry — the cross-org / org-lifecycle management surface
// (Org API Key, tenant host). Enabled by MOLECULE_MCP_MODE=management; see
// createServer() and tools/management/. Exported for tests + SDK consumers.
// Note: handleProvisionWorkspace + handleListPendingApprovals +
// handleInstallPlugin + handleListAvailablePlugins are NOT re-exported here —
// those identifiers are already owned by the legacy
// workspaces/approvals/plugins export blocks above. The management variants
// are reachable via the "./tools/management/index.js" module path and are
// wired into the server through registerManagementTools.
export {
  registerManagementTools,
  handleDeprovisionWorkspace,
  handleSetWorkspaceSecret,
  handleListWorkspaceSecrets,
  handleDeleteWorkspaceSecret,
  handleSetOrgSecret,
  handleListOrgSecrets,
  handleDeleteOrgSecret,
  handleSetWorkspaceBudget,
  handleSetLlmBillingMode,
  handleCreateOrgFromTemplate,
  handleMintOrgToken,
  handleListOrgTokens,
  handleRevokeOrgToken,
  handleMintWorkspaceToken,
  handleGetOrgPluginAllowlist,
  handleSetOrgPluginAllowlist,
  handleGetConversationHistory,
} from "./tools/management/index.js";
export {
  registerIssueTools,
  handleCreateIssue,
  buildIssueBody,
  deriveLabelNames,
  giteaApiUrl,
  defaultIssueRepo,
} from "./tools/issues.js";
export {
  registerRequestTools,
  handleCreateRequest,
  handleListInbox,
  handleCheckRequests,
  handleGetRequest,
  handleRespondRequest,
  handleAddRequestMessage,
  handleCancelRequest,
} from "./tools/requests.js";
export { mgmtCall, mgmtGet, managementUrl } from "./tools/management/client.js";
export { registerCpAdminTools, handleListOrgs, handleGetOrg, cpUrl, cpConfigured } from "./tools/management/cp_admin.js";

/**
 * Returns true when the server should run as the MANAGEMENT server (the
 * cross-org / org-lifecycle surface) rather than the legacy single-tenant
 * workspace-ops surface. Driven by MOLECULE_MCP_MODE=management.
 *
 * The two registries are mutually exclusive in one server instance because
 * several tool names overlap (list_workspaces, get_workspace, restart/pause/
 * resume_workspace) and the MCP SDK throws on duplicate tool names. The
 * management registry is the SAME codebase + conventions, not a fork — it's
 * a distinct mode of this one server (SSOT).
 */
export function isManagementMode(): boolean {
  return (process.env.MOLECULE_MCP_MODE || "").toLowerCase() === "management";
}

export function createServer() {
  const srv = new McpServer({
    name: isManagementMode() ? "molecule-platform" : "molecule-a2a",
    version: "1.0.0",
  });

  if (isManagementMode()) {
    // Management registry — Org API Key, tenant host. CP-tier tools
    // (list_orgs/get_org) are registered by registerManagementTools via the
    // separate cp_admin module and gated on CP_ADMIN_API_TOKEN.
    registerManagementTools(srv);
    // Issue filing is useful from BOTH surfaces (an operator on the management
    // host and an agent on the workspace surface both observe bugs worth
    // tracking). The tool name is unique, so it is safe in both registries.
    registerIssueTools(srv);
    // Unified requests/inbox tools (RFC P2) — registered in BOTH modes, same
    // as create_issue: an agent on either surface can raise/answer requests.
    registerRequestTools(srv);
    return srv;
  }

  registerWorkspaceTools(srv);
  registerAgentTools(srv);
  registerSecretTools(srv);
  registerFileTools(srv);
  registerMemoryTools(srv);
  registerPluginTools(srv);
  registerChannelTools(srv);
  registerDelegationTools(srv);
  registerScheduleTools(srv);
  registerApprovalTools(srv);
  registerDiscoveryTools(srv);
  registerRemoteAgentTools(srv);
  registerIssueTools(srv);
  registerRequestTools(srv);

  return srv;
}

async function main() {
  // Validate platform connectivity on startup
  try {
    const res = await fetch(`${PLATFORM_URL}/health`);
    if (res.ok) {
      logInfo("Molecule AI platform connected", { platformUrl: PLATFORM_URL });
    } else {
      logWarn(`Molecule AI platform at ${PLATFORM_URL} returned ${res.status}. Tools may fail.`, {
        platformUrl: PLATFORM_URL,
        status: res.status,
      });
    }
  } catch (err) {
    logWarn(`Cannot reach Molecule AI platform at ${PLATFORM_URL}. Start it with: cd platform && go run ./cmd/server`, {
      platformUrl: PLATFORM_URL,
    });
  }

  // Auth preflight (issue #36). If MOLECULE_API_KEY is set, fire one cheap
  // auth-gated GET so a rejected key is surfaced LOUDLY at startup rather than
  // silently 401-ing on every tool call. We reuse the discovery `/templates`
  // path (same endpoint as the list_templates tool). We never crash on a bad
  // key — the server still starts (e.g. so localhost no-auth tools work).
  if (process.env.MOLECULE_API_KEY && process.env.MOLECULE_API_KEY.length > 0) {
    try {
      const res = await platformGet("/templates");
      if (isApiError(res)) {
        // platformGet stamps HTTP errors as `error: "HTTP <code>"`.
        const m = /HTTP (\d+)/.exec(res.error);
        const code = m ? Number(m[1]) : undefined;
        if (code === 401 || code === 403) {
          // eslint-disable-next-line no-console
          console.error(
            `AUTH_ERROR: MOLECULE_API_KEY rejected by ${PLATFORM_URL} (HTTP ${code})`,
          );
        }
        // Other errors (platform unreachable, 5xx, etc.) are already logged by
        // the helper / health check above; the preflight only owns auth.
      } else {
        logInfo("MOLECULE_API_KEY accepted by platform", { platformUrl: PLATFORM_URL });
      }
    } catch (err) {
      // Preflight must never crash startup.
      logWarn("Auth preflight failed to complete (continuing startup)", {
        platformUrl: PLATFORM_URL,
      });
    }
  } else {
    logInfo(
      `MOLECULE_API_KEY not set — running unauthenticated (dev / no-auth localhost). Set MOLECULE_API_KEY to authenticate against ${PLATFORM_URL}.`,
      { platformUrl: PLATFORM_URL },
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (isManagementMode()) {
    logInfo("Molecule AI MANAGEMENT MCP server running on stdio (Org API Key, tenant host)", {
      transport: "stdio",
      mode: "management",
    });
  } else {
    logInfo("Molecule AI MCP server running on stdio (93 tools available)", { transport: "stdio", toolCount: 93 });
  }
}

// Only auto-start when run directly (not when imported). main() does I/O
// (platform health fetch + auth preflight + stdio connect), so it must NOT run
// when another module imports createServer for enumeration:
//   - JEST_WORKER_ID  is set automatically by Jest in every worker process.
//   - MOLECULE_MCP_SUPPRESS_AUTOSTART is set by the producer-emitted tool
//     manifest emitter (manifest-emit.ts) before it dynamically imports this
//     module to dump the registered tools. (Env, not import.meta, so this stays
//     valid under the CommonJS ts-jest transform the test suite uses.)
if (!process.env.JEST_WORKER_ID && !process.env.MOLECULE_MCP_SUPPRESS_AUTOSTART) {
  main().catch((err) => logError(err, "MCP server main() threw unexpectedly"));
}
