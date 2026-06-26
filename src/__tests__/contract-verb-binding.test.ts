/**
 * Producer-binding test — MCP-plugin delivery verb contract (core#3082 / #3280).
 *
 * WHY THIS EXISTS
 * ───────────────
 * The platform online/degraded gate in molecule-core decides whether a
 * provisioned concierge is healthy by checking that the management MCP
 * surfaces a known workspace-creation verb (namespaced
 * `mcp__<mcp_server_name>__<verb>`). Core asserts that verb from a SHARED
 * contract: `contracts/mcp-plugin-delivery.contract.json`. The contract's
 * SSOT for the verb is the SINGULAR field `required_tool` (a string).
 *
 * THIS repo (@molecule-ai/mcp-server) is the PRODUCER of that verb. Because
 * the boundary is cross-language (Go core ↔ TS mcp-server) there is no typed
 * import that ties the two together — so the producer can silently rename or
 * drop the verb, OR the contract can hand-assert a verb the producer never
 * exposes, and core only finds out at runtime, when a freshly provisioned
 * concierge degrades.
 *
 * That second failure mode is the ORIGINAL bug: an earlier contract
 * hand-asserted `create_workspace`, but the concierge runs THIS server in
 * MANAGEMENT mode, whose workspace-creation verb is `provision_workspace` —
 * `create_workspace` is NEVER registered in management mode (createServer()
 * returns early before the legacy workspace-mode tools). Nothing verified the
 * asserted verb against the producer, so the gate keyed off a verb no build
 * ever surfaced. This test is exactly the missing verification: it confirms the
 * management server really exposes the contract's `required_tool`
 * (provision_workspace), and it would have FAILED on its first run against the
 * wrong `create_workspace` contract — catching the contract being wrong on day
 * one instead of via a fleet-wide runtime degrade.
 *
 * WHAT THIS ENFORCES
 * ──────────────────
 * Against the SAME contract file core validates against (vendored byte-identical
 * into this repo and kept honest by a CI sync-check — see
 * `.gitea/scripts/check-contract-vendor-sync.sh`). The verb is read from the
 * contract (not hard-coded), so the test tracks whatever the SSOT declares:
 *
 *   1. The management server's name equals the contract's `mcp_server_name`
 *      (so `mcp__<name>__<verb>` namespacing core derives actually matches
 *      what this server registers under).
 *   2. The contract's `required_tool` verb is a registered tool of the
 *      management server — the producer genuinely surfaces the verb the gate
 *      REQUIRES. (This is the assertion that fails on a contract asserting a
 *      verb the producer never exposes, e.g. the original `create_workspace`.)
 *   3. The contract declares a non-empty `required_tool` (a corrupt contract
 *      that emptied it would derive an empty accepted id in core →
 *      fail-closed forever).
 *
 * Renaming/dropping the required verb in this repo therefore fails ITS OWN CI
 * here, before a stale build can be published and degrade a tenant.
 *
 * CONTRACT-SHARING MECHANISM: vendored copy + CI sync-check (chosen over a
 * git submodule or a published artifact). The unit test reads a local file so
 * it is offline/deterministic; a separate CI step byte-compares that local
 * file against core's canonical via the Gitea raw endpoint, so the vendored
 * copy cannot silently drift. This mirrors core's own
 * `mcp-plugin-delivery-contract-drift.yml` gate (core ↔ template ↔ runtime).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mirror the SDK mock used by index.test.ts so building the real server here
// records every registered tool name without touching stdio/transport.
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    name: string;
    registeredToolNames: string[] = [];
    constructor(args: { name: string }) {
      this.name = args.name;
    }
    tool(name: string) {
      this.registeredToolNames.push(name);
    }
    connect() {
      return Promise.resolve();
    }
  },
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

import { createServer } from "../index.js";

interface DeliveryContract {
  mcp_server_name: string;
  // SSOT for the management-MCP workspace-creation verb (core#3280): a SINGULAR
  // string, namespaced by core to `mcp__<mcp_server_name>__<required_tool>`.
  required_tool: string;
}

const CONTRACT_PATH = join(__dirname, "..", "..", "contracts", "mcp-plugin-delivery.contract.json");

function loadContract(): DeliveryContract {
  const raw = readFileSync(CONTRACT_PATH, "utf8");
  return JSON.parse(raw) as DeliveryContract;
}

/**
 * Builds the MANAGEMENT-mode server — the one named `molecule-platform` that a
 * concierge actually runs — and returns its registered tool names. The
 * management registry is the surface the online/degraded gate inspects.
 */
function managementServerToolNames(): { serverName: string; tools: string[] } {
  const saved = process.env.MOLECULE_MCP_MODE;
  process.env.MOLECULE_MCP_MODE = "management";
  try {
    const srv = createServer() as unknown as { name: string; registeredToolNames: string[] };
    return { serverName: srv.name, tools: [...srv.registeredToolNames] };
  } finally {
    if (saved === undefined) delete process.env.MOLECULE_MCP_MODE;
    else process.env.MOLECULE_MCP_MODE = saved;
  }
}

describe("MCP-plugin delivery verb contract (producer binding)", () => {
  const contract = loadContract();

  test("contract declares a non-empty required_tool verb", () => {
    // An empty required_tool would make core derive an empty accepted tool id
    // and fail-close every concierge. Guard the producer's own copy too, so a
    // corrupted vendored contract is caught here.
    expect(typeof contract.required_tool).toBe("string");
    expect(contract.required_tool.length).toBeGreaterThan(0);
    expect(contract.mcp_server_name).toBeTruthy();
  });

  test("management server registers under the contract's mcp_server_name", () => {
    // The gate derives `mcp__<mcp_server_name>__<verb>`; if this server
    // registered under a different name, the derived id would never match.
    const { serverName } = managementServerToolNames();
    expect(serverName).toBe(contract.mcp_server_name);
  });

  test("the contract's required_tool verb is genuinely registered by the management server", () => {
    // The core gate REQUIRES this verb. If the contract asserts a verb the
    // producer never registers (the original create_workspace bug), this fails
    // — precisely the day-one verification that was missing.
    const { tools } = managementServerToolNames();
    expect(tools).toContain(contract.required_tool);

    // The verb must be a uniquely-registered tool (the SDK rejects duplicate
    // names; this catches a partial/duplicate registration regression).
    expect(tools.filter((t) => t === contract.required_tool)).toHaveLength(1);
  });
});
