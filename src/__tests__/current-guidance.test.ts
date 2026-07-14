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
  });
});
