/** Static ratchets for the server's active setup and topology guidance. */

import { readFileSync } from "node:fs";
import { join } from "node:path";


const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");


describe("current MCP setup guidance", () => {
  it("keeps the tenant host distinct from the control-plane host", () => {
    const readme = read("README.md");
    const claude = read("CLAUDE.md");
    const api = read("src/api.ts");

    expect(readme).toContain('"MOLECULE_API_URL": "https://<slug>.moleculesai.app"');
    expect(claude).toContain('"MOLECULE_API_URL": "https://<slug>.moleculesai.app"');
    expect(claude).not.toContain('"MOLECULE_API_URL": "https://api.moleculesai.app"');
    expect(api).toContain("per-tenant workspace API base URL");
    expect(api).not.toContain("Control plane API base URL");
    expect(api).not.toContain("MOLECULE_RUNTIME_URL");
  });

  it("keeps workspace and management credentials distinct", () => {
    const readme = read("README.md");
    const authGuidance = [
      readme,
      read("CLAUDE.md"),
      read("src/api.ts"),
      read("src/tools/management/client.ts"),
    ].join("\n");

    expect(authGuidance).not.toMatch(/sends\s+no\s+Authorization/i);
    expect(readme).toContain(
      "`MOLECULE_API_KEY` is the workspace registry's tenant API bearer.",
    );
    expect(readme).toMatch(
      /It is\s+distinct from `MOLECULE_ORG_API_KEY`, the full-tenant-admin Org API Key used by\s+management mode\./,
    );
  });

  it("states the workspace bearer contract in the management client", () => {
    const managementClient = read("src/tools/management/client.ts").replace(
      /\n\s*\*\s?/g,
      " ",
    );

    expect(managementClient).toMatch(
      /The workspace surface sends\s+`MOLECULE_API_KEY` when configured/,
    );
  });

  it("states the management bearer contract in the management client", () => {
    const managementClient = read("src/tools/management/client.ts").replace(
      /\n\s*\*\s?/g,
      " ",
    );

    expect(managementClient).toMatch(
      /The management registry requires\s+`MOLECULE_ORG_API_KEY` \(the full-tenant-admin Org API Key\) on every call/,
    );
  });

  it("documents only the implemented stdio transport and entrypoint", () => {
    const guidance = `${read("README.md")}\n${read("CLAUDE.md")}`;

    for (const retired of [
      "MCP_SERVER_PORT",
      "SSE Transport",
      "HTTP/SSE transport",
      "--self-update",
      "node dist/index.js --help",
      "src/types/",
    ]) {
      expect(guidance).not.toContain(retired);
    }
    expect(guidance).toContain("StdioServerTransport");
  });

  it("does not describe a retired EC2 or pinned-Gitea topology", () => {
    const activeComments = [
      read("src/tools/management/client.ts"),
      read("src/tools/workspaces.ts"),
    ].join("\n");
    expect(activeComments).not.toMatch(/\bEC2\b/);
    expect(read(".gitea/workflows/gitea-merge-queue.yml")).not.toContain("Gitea 1.22.6");
  });

  it("directs tool-count readers to the generated per-mode manifest", () => {
    const readme = read("README.md");
    const claude = read("CLAUDE.md");
    expect(readme).not.toMatch(/\b87 tools\b/i);
    expect(claude).not.toMatch(/\b88 total\b/i);
    expect(readme).toContain("dist/manifest.json");
    expect(claude).toContain("dist/manifest.json");
    expect(readme).toContain("85 workspace-mode tools");
    expect(readme).toMatch(/46\s+management-mode\s+tools/);
    expect(claude).toContain("85 workspace-mode tools");
    expect(claude).toMatch(/46\s+management-mode\s+tools/);
  });

  it("keeps the production promote capability distinct and fail-closed", () => {
    const guidance = `${read("README.md")}\n${read("CLAUDE.md")}\n${read("src/tools/management/cp_admin.ts")}`;
    expect(guidance).toContain("CP_PROMOTE_PROD_API_TOKEN");
    expect(guidance).toMatch(/generic CP admin bearer is never/i);
    expect(guidance).toContain("contracts/promote-request.contract.json");
  });
});
