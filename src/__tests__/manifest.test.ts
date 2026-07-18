/**
 * Unit tests for the producer-emitted tool manifest (RFC #3285, P1).
 *
 * Two contracts are pinned here:
 *
 *  (1) ENVELOPE — buildManifest() is pure (no SDK, no I/O), so we assert the
 *      versioned/per-mode/stamped shape and its determinism directly. This is
 *      what a consumer parses; it must be stable and version-stamped.
 *
 *  (2) ENUMERATION SOURCE — the manifest is derived from createServer()'s
 *      ACTUAL registrations. We mock the MCP SDK with the same recording shim
 *      management.test.ts uses (records tool names; throws on duplicates like
 *      the real SDK) and assert each mode enumerates a non-empty, collision-free
 *      set. This is the regression gate: if two registrars ever collide the
 *      server can't be composed, so the manifest cannot describe a phantom.
 *
 * The real in-memory-client emit path (Client + InMemoryTransport + tools/list)
 * runs only at build time against the REAL SDK (node, not jest); it is not
 * exercised here because the SDK is mocked under jest.
 */

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registeredToolNames: string[] = [];
    tool(name: string) {
      if (this.registeredToolNames.includes(name)) {
        throw new Error(`Tool ${name} is already registered`);
      }
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
import { buildManifest, type ManifestTool } from "../manifest.js";

const tool = (name: string, description = "", inputSchema: unknown = {}): ManifestTool => ({
  name,
  description,
  inputSchema,
});

describe("buildManifest envelope", () => {
  it("stamps package name + version and the two mode keys", () => {
    const m = buildManifest(
      "@molecule-ai/mcp-server",
      "9.9.9",
      [tool("provision_workspace")],
      [tool("chat_with_agent")],
      "2026-06-26T00:00:00.000Z",
    );
    expect(m.name).toBe("@molecule-ai/mcp-server");
    expect(m.version).toBe("9.9.9");
    expect(m.generatedAt).toBe("2026-06-26T00:00:00.000Z");
    expect(Object.keys(m.modes).sort()).toEqual(["management", "workspace"]);
    expect(m.modes.management.map((t) => t.name)).toEqual(["provision_workspace"]);
    expect(m.modes.workspace.map((t) => t.name)).toEqual(["chat_with_agent"]);
  });

  it("sorts tools by name within each mode (deterministic output)", () => {
    const m = buildManifest(
      "@molecule-ai/mcp-server",
      "1.0.0",
      [tool("zeta"), tool("alpha"), tool("mike")],
      [tool("yankee"), tool("bravo")],
      "2026-06-26T00:00:00.000Z",
    );
    expect(m.modes.management.map((t) => t.name)).toEqual(["alpha", "mike", "zeta"]);
    expect(m.modes.workspace.map((t) => t.name)).toEqual(["bravo", "yankee"]);
  });

  it("preserves description + inputSchema (the verb's signature)", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const m = buildManifest(
      "@molecule-ai/mcp-server",
      "1.0.0",
      [tool("provision_workspace", "Management: provision a workspace.", schema)],
      [],
      "2026-06-26T00:00:00.000Z",
    );
    expect(m.modes.management[0].description).toBe("Management: provision a workspace.");
    expect(m.modes.management[0].inputSchema).toEqual(schema);
  });

  it("is a pure transform — does not mutate the input arrays", () => {
    const mgmt = [tool("zeta"), tool("alpha")];
    buildManifest("@molecule-ai/mcp-server", "1.0.0", mgmt, [], "2026-06-26T00:00:00.000Z");
    expect(mgmt.map((t) => t.name)).toEqual(["zeta", "alpha"]); // unsorted, untouched
  });
});

describe("enumeration source (createServer registrations)", () => {
  const prev = process.env.MOLECULE_MCP_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MOLECULE_MCP_MODE;
    else process.env.MOLECULE_MCP_MODE = prev;
  });

  it("management mode composes a non-empty, collision-free toolset", () => {
    process.env.MOLECULE_MCP_MODE = "management";
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    const names = srv.registeredToolNames;
    expect(names).toHaveLength(45);
    expect(new Set(names).size).toBe(names.length); // no duplicate registrations
    expect(names).toContain("provision_workspace");
    expect(names).not.toContain("recreate_workspace");
    expect(names).not.toContain("chat_with_agent"); // workspace-only verb absent
  });

  it("workspace mode composes a non-empty, collision-free toolset", () => {
    process.env.MOLECULE_MCP_MODE = "";
    const srv = createServer() as unknown as { registeredToolNames: string[] };
    const names = srv.registeredToolNames;
    expect(names).toHaveLength(85);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("chat_with_agent");
    expect(names).not.toContain("list_channels");
    expect(names).not.toContain("add_channel");
    expect(names).not.toContain("test_channel");
  });
});
