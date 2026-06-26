/**
 * Producer-emitted tool manifest — PURE envelope builder (Tool-Contract SSOT,
 * RFC #3285, P1).
 *
 * This module is intentionally dependency-free (no MCP SDK, no fs, no
 * import.meta): it only assembles the versioned, per-mode manifest envelope
 * from already-collected tool lists. Keeping it pure means it is importable
 * under jest (CommonJS via ts-jest) and the stamping contract — package name +
 * version + the two mode keys + deterministic ordering — is unit-testable in
 * isolation. The actual server enumeration (real SDK, in-memory tools/list)
 * lives in the build-time entrypoint manifest-emit.ts, which calls buildManifest.
 *
 * ADVISORY / NON-BREAKING: nothing in the running server imports this; it adds
 * no runtime dependency and changes no tool, handler, or transport.
 */

export type ManifestTool = {
  name: string;
  description: string;
  // JSON-Schema for the tool's input parameters (the "signature").
  inputSchema: unknown;
};

export type ToolManifest = {
  name: string;
  version: string;
  generatedAt: string;
  modes: {
    management: ManifestTool[];
    workspace: ManifestTool[];
  };
};

/**
 * Builds the versioned manifest envelope from already-collected per-mode tool
 * lists. Pure: returns a new object, sorts tools by name (deterministic output
 * regardless of registration order), and never mutates the inputs.
 */
export function buildManifest(
  pkgName: string,
  pkgVersion: string,
  management: ManifestTool[],
  workspace: ManifestTool[],
  generatedAt: string = new Date().toISOString(),
): ToolManifest {
  const sortByName = (a: ManifestTool, b: ManifestTool) =>
    a.name.localeCompare(b.name);
  return {
    name: pkgName,
    version: pkgVersion,
    generatedAt,
    modes: {
      management: [...management].sort(sortByName),
      workspace: [...workspace].sort(sortByName),
    },
  };
}
