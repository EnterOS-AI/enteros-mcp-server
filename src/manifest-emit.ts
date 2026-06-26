#!/usr/bin/env node
/**
 * Producer-emitted tool manifest — BUILD-TIME EMITTER (Tool-Contract SSOT,
 * RFC #3285, P1).
 *
 * Builds the REAL server per mode (the same createServer() the binary runs) and
 * dumps the tools it ACTUALLY registers over an in-memory MCP `tools/list`
 * round-trip — names + descriptions + JSON-Schema input signatures — then
 * stamps the package version and writes dist/manifest.json. Because the
 * manifest is derived from the live registrations, it cannot describe a phantom
 * tool: enumeration IS the source of truth.
 *
 * ADVISORY / NON-BREAKING. This file is never imported by the running server.
 * It adds NO new runtime dependency: Client, InMemoryTransport and the SDK's
 * own zod-to-json-schema are all part of the already-pinned
 * @modelcontextprotocol/sdk. It runs only via `npm run manifest` /
 * `npm run build:manifest`, and in the tag-triggered publish workflow before
 * `npm publish`, so dist/manifest.json ships in the npm tarball. The required
 * CI `build`/`test` steps are unchanged (build stays plain `tsc`).
 *
 * Composing the real server doubles as a regression gate: the SDK throws on a
 * duplicate tool name, so a cross-registry collision fails this emitter loudly.
 *
 * Run: `node dist/manifest-emit.js` (after `tsc`). Writes dist/manifest.json.
 */
// Suppress index.ts's auto-start BEFORE importing it. ESM evaluates static
// imports before any other top-level code, so the dynamic import of ./index.js
// inside toolsForMode() is what guarantees this env var is already set when
// index's module body (and its auto-start guard) runs. Without this, importing
// createServer would fire main()'s platform health fetch + auth preflight +
// stdio connect.
process.env.MOLECULE_MCP_SUPPRESS_AUTOSTART = "1";

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildManifest, type ManifestTool } from "./manifest.js";

const require = createRequire(import.meta.url);
// dist/manifest-emit.js → ../package.json. package.json is the SINGLE source of
// truth for the version; the McpServer constructor version ("1.0.0") is a
// separate, unrelated protocol-server identifier and is intentionally NOT used.
const pkg = require("../package.json") as { name: string; version: string };

/**
 * Builds the REAL server for `mode` and dumps the tools it actually registers
 * via an in-memory MCP client (the supported `tools/list` contract). Toggles
 * MOLECULE_MCP_MODE around createServer() exactly the way isManagementMode()
 * reads it, and restores the previous value afterward so the two passes never
 * bleed into each other.
 */
async function toolsForMode(
  mode: "management" | "workspace",
): Promise<ManifestTool[]> {
  const prev = process.env.MOLECULE_MCP_MODE;
  process.env.MOLECULE_MCP_MODE = mode === "management" ? "management" : "";
  try {
    // Dynamic import (not static) so MOLECULE_MCP_SUPPRESS_AUTOSTART is already
    // set when index's module body evaluates. ESM caches the module, so this
    // resolves once and is cheap on the second mode.
    const { createServer } = await import("./index.js");
    const server = createServer(); // REAL registrations (srv.tool(...))
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({
      name: "molecule-mcp-manifest-emitter",
      version: pkg.version,
    });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
  } finally {
    if (prev === undefined) delete process.env.MOLECULE_MCP_MODE;
    else process.env.MOLECULE_MCP_MODE = prev;
  }
}

async function main(): Promise<void> {
  const manifest = buildManifest(
    pkg.name,
    pkg.version,
    await toolsForMode("management"),
    await toolsForMode("workspace"),
  );
  const out = join(dirname(fileURLToPath(import.meta.url)), "manifest.json"); // dist/manifest.json
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  // stderr only — never pollute stdout (the MCP stdio channel convention).
  console.error(
    `Wrote ${out}: management=${manifest.modes.management.length} workspace=${manifest.modes.workspace.length} tools (v${manifest.version})`,
  );
}

// Run only when executed as the entrypoint (`node dist/manifest-emit.js`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("manifest emit failed:", err);
    process.exit(1);
  });
}
