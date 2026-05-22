/**
 * Layer D (RFC#640 4-layer cascade) — AST-level contract test.
 *
 * Enforces the invariant: any TS file that polls `/workspaces/.../activity`
 * (the activity endpoint that delivers `chat_upload_receive` rows) MUST
 * also import the upload-resolution helpers from
 * `@molecule-ai/mcp-server`. Otherwise the adapter will silently drop
 * `platform-pending:` URIs the agent can't open — exactly the regression
 * Layer A's MANDATORY contract section + Layer B's TS implementation
 * close from the spec/implementation side.
 *
 * This test catches the THIRD failure surface: an adapter that has a
 * poll loop but forgot to wire in the resolution helpers. AST-level
 * (vs. runtime) means the failure shows up at CI parse-time, not at
 * runtime when a user happens to paste a file.
 *
 * # How it runs
 *
 * Consumer repos (channel adapter, telegram adapter, codex bridge, etc.)
 * point at this test via:
 *
 *   # In the consumer repo's CI:
 *   MCP_SERVER_CONTRACT_CONSUMERS=src/server.ts:src/poll.ts \
 *     npx jest --testPathPatterns=poll-uploads-resolved-contract \
 *              --rootDir=node_modules/@molecule-ai/mcp-server
 *
 * The env var is colon-separated list of TS source files (paths
 * relative to the consumer repo's cwd) to inspect. Each file is parsed
 * with the TypeScript compiler API; the invariant is asserted per file.
 *
 * # On producer-side CI (this repo's own jest run):
 *
 * The env var is unset → the test runs against an empty consumer list →
 * passes trivially. This means the test runs in this repo's CI without
 * needing external consumers; the gate is engaged only when a consumer
 * sets the env var. Same shape as the runtime-pin-check contract sibling
 * pattern. Producer-side passes; consumer-side gates.
 *
 * # Magic-comment opt-out
 *
 * A consumer that intentionally polls /activity but DOES NOT need upload
 * resolution (e.g. a logging-only inspector that never surfaces files to
 * an agent) can opt out by adding the magic comment ANYWHERE in the file:
 *
 *   // @no-resolve-uploads-justification: <reason>
 *
 * The reason text is informational — the test asserts the presence of
 * the magic-comment header but doesn't parse the reason. A reviewer
 * sees the comment + reason in code review.
 *
 * Origin: RFC#640 Layer D. CTO chat GO 2026-05-22T01:31:48Z.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

// ---------------------------------------------------------------------------
// Static config — keep in sync with src/inbox-uploads.ts public exports.
// ---------------------------------------------------------------------------

/** Helper names that, when imported, signal upload-resolution capability. */
const RESOLUTION_HELPER_NAMES = new Set([
  "resolvePendingUpload",
  "URICache",
  "rewritePendingURIs",
]);

/** Module specifier patterns that source the resolution helpers. */
const RESOLUTION_HELPER_SOURCES = [
  "@molecule-ai/mcp-server",
  "@molecule-ai/mcp-server/inbox-uploads",
];

/**
 * URL-literal patterns that mark a file as an /activity poller. Matches:
 *   `/workspaces/<ws>/activity`
 *   `/workspaces/<ws>/activity?include=peer_info`
 *   `/workspaces/${id}/activity?since_id=...`
 * The walk is conservative: only literal strings + tagged-template
 * sub-strings. A consumer that dynamically constructs the URL via a
 * helper function (e.g. `buildActivityUrl(ws)`) would slip past this
 * check; that's acceptable because the helper itself would land in a
 * file that does the curl, and the check catches the curl-site file.
 */
const ACTIVITY_URL_PATTERN = /\/workspaces\/[^/]*\/activity(?:\?|$|[^a-zA-Z0-9_/-])/;

/**
 * Magic-comment opt-out. Anywhere in the file body / leading comments.
 * The `<reason>` part is informational; the test only checks for the
 * prefix.
 */
const OPT_OUT_COMMENT = /\/\/\s*@no-resolve-uploads-justification:/;

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

interface ConsumerCheckResult {
  consumerPath: string;
  pollsActivity: boolean;
  importsResolutionHelper: boolean;
  hasOptOut: boolean;
  optOutLine?: number;
  importedResolutionNames: string[];
}

function checkConsumerFile(consumerPath: string): ConsumerCheckResult {
  const source = fs.readFileSync(consumerPath, "utf8");
  const sourceFile = ts.createSourceFile(
    consumerPath,
    source,
    ts.ScriptTarget.ES2022,
    /*setParentNodes*/ true,
    consumerPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  let pollsActivity = false;
  const importedFromMcpServer: string[] = [];

  const visit = (node: ts.Node): void => {
    // Import declaration with named imports: track imports from our package.
    if (ts.isImportDeclaration(node)) {
      const moduleSpec = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpec) && RESOLUTION_HELPER_SOURCES.includes(moduleSpec.text)) {
        const clause = node.importClause;
        if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            importedFromMcpServer.push(el.name.text);
          }
        }
      }
    }
    // String literal: any /activity URL in any string is a poll signal.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ACTIVITY_URL_PATTERN.test(node.text)) {
        pollsActivity = true;
      }
    }
    // Template literal with substitutions: also check raw fragments.
    if (ts.isTemplateExpression(node)) {
      const allText =
        node.head.text +
        node.templateSpans.map((s) => `<sub>${s.literal.text}`).join("");
      if (ACTIVITY_URL_PATTERN.test(allText)) {
        pollsActivity = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  // Magic-comment opt-out scan (text-level — covers leading comments,
  // mid-file block comments, etc.).
  let optOutLine: number | undefined;
  if (OPT_OUT_COMMENT.test(source)) {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (OPT_OUT_COMMENT.test(lines[i])) {
        optOutLine = i + 1;
        break;
      }
    }
  }

  const importsResolutionHelper = importedFromMcpServer.some((name) =>
    RESOLUTION_HELPER_NAMES.has(name),
  );

  return {
    consumerPath,
    pollsActivity,
    importsResolutionHelper,
    hasOptOut: optOutLine !== undefined,
    optOutLine,
    importedResolutionNames: importedFromMcpServer.filter((n) =>
      RESOLUTION_HELPER_NAMES.has(n),
    ),
  };
}

describe("RFC#640 Layer D — poll-uploads-resolved contract", () => {
  const consumersEnv = process.env.MCP_SERVER_CONTRACT_CONSUMERS ?? "";
  const consumers = consumersEnv
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (consumers.length === 0) {
    // Producer-side CI no-op gate. The contract is engaged in consumer
    // repos via MCP_SERVER_CONTRACT_CONSUMERS=<paths> on their jest run.
    it("no consumers declared (producer-side CI no-op)", () => {
      expect(consumers.length).toBe(0);
    });
    return;
  }

  for (const consumerPath of consumers) {
    describe(consumerPath, () => {
      let result: ConsumerCheckResult;

      beforeAll(() => {
        if (!fs.existsSync(consumerPath)) {
          throw new Error(
            `MCP_SERVER_CONTRACT_CONSUMERS lists ${consumerPath} but the file does not exist relative to cwd ${process.cwd()}`,
          );
        }
        result = checkConsumerFile(consumerPath);
      });

      it("either polls /activity AND imports resolution helpers, OR has the opt-out comment, OR does not poll /activity at all", () => {
        // Three valid states:
        //   (a) does not poll /activity        → invariant trivially holds
        //   (b) polls AND imports resolution   → invariant holds
        //   (c) polls AND has opt-out comment  → invariant escape hatch
        const reasonLines: string[] = [
          `path: ${result.consumerPath}`,
          `polls /activity: ${result.pollsActivity}`,
          `imports resolution helper(s): ${
            result.importsResolutionHelper
              ? `[${result.importedResolutionNames.join(", ")}]`
              : "no"
          }`,
          `has @no-resolve-uploads-justification: ${
            result.hasOptOut ? `yes (line ${result.optOutLine})` : "no"
          }`,
        ];
        const status =
          !result.pollsActivity || result.importsResolutionHelper || result.hasOptOut;
        expect({ ok: status, info: reasonLines.join("\n  ") }).toEqual({
          ok: true,
          info: reasonLines.join("\n  "),
        });
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Self-test fixtures: prove the checker logic catches each case correctly.
// These exercise the analysis function against synthesized source strings
// without requiring real fixture files on disk.
// ---------------------------------------------------------------------------

describe("RFC#640 Layer D — checker self-tests", () => {
  // Use tmpdir fixtures because checkConsumerFile reads from disk.
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "layer-d-self-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function fixture(name: string, content: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("file that polls /activity AND imports resolvePendingUpload → passes", () => {
    const p = fixture(
      "ok.ts",
      `
import { resolvePendingUpload, URICache } from "@molecule-ai/mcp-server";
async function pollLoop(wsId: string) {
  const url = \`/workspaces/\${wsId}/activity?include=peer_info\`;
  // ...
}
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(true);
    expect(r.importsResolutionHelper).toBe(true);
    expect(r.hasOptOut).toBe(false);
  });

  it("file that polls /activity but does NOT import resolution helpers → caught", () => {
    const p = fixture(
      "missing.ts",
      `
import { apiCall } from "@molecule-ai/mcp-server";
async function pollLoop(wsId: string) {
  await apiCall("GET", \`/workspaces/\${wsId}/activity\`);
}
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(true);
    expect(r.importsResolutionHelper).toBe(false);
    expect(r.hasOptOut).toBe(false);
  });

  it("file with magic-comment opt-out → not caught", () => {
    const p = fixture(
      "optout.ts",
      `
// @no-resolve-uploads-justification: this is a logging-only inspector
import { apiCall } from "@molecule-ai/mcp-server";
async function pollLoop(wsId: string) {
  await apiCall("GET", \`/workspaces/\${wsId}/activity\`);
}
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(true);
    expect(r.importsResolutionHelper).toBe(false);
    expect(r.hasOptOut).toBe(true);
    expect(r.optOutLine).toBe(2);
  });

  it("file that doesn't poll /activity at all → invariant trivially holds", () => {
    const p = fixture(
      "noPoll.ts",
      `
import { apiCall } from "@molecule-ai/mcp-server";
async function listWorkspaces() {
  await apiCall("GET", "/workspaces");
}
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(false);
    expect(r.importsResolutionHelper).toBe(false);
    expect(r.hasOptOut).toBe(false);
  });

  it("imports from subpath @molecule-ai/mcp-server/inbox-uploads also count", () => {
    const p = fixture(
      "subpath.ts",
      `
import { URICache } from "@molecule-ai/mcp-server/inbox-uploads";
const url = "/workspaces/ws/activity";
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(true);
    expect(r.importsResolutionHelper).toBe(true);
    expect(r.importedResolutionNames).toContain("URICache");
  });

  it("URL pattern: rejects /workspaces/X/activities (false-friend) but accepts /activity boundary", () => {
    const p1 = fixture("trip.ts", `const u = "/workspaces/x/activities";`);
    const p2 = fixture("good.ts", `const u = "/workspaces/x/activity?since_id=1";`);
    expect(checkConsumerFile(p1).pollsActivity).toBe(false);
    expect(checkConsumerFile(p2).pollsActivity).toBe(true);
  });

  it("template literal with /activity in head is detected", () => {
    const p = fixture(
      "tmpl.ts",
      "const u = `/workspaces/${ws}/activity`;",
    );
    expect(checkConsumerFile(p).pollsActivity).toBe(true);
  });

  it("template literal with /activity AFTER a substitution span is detected", () => {
    // The /activity literal is in the SECOND fragment after the
    // `${ws}` substitution — must still be caught by the walker.
    const p = fixture(
      "tmpl2.ts",
      "const u = `/workspaces/${ws}/activity?since_id=${cursor}`;",
    );
    expect(checkConsumerFile(p).pollsActivity).toBe(true);
  });

  it("default ImportClause (e.g. import foo from '@molecule-ai/mcp-server') does not count as named import", () => {
    // Sanity: bare default imports don't pull in resolvePendingUpload.
    const p = fixture(
      "default.ts",
      `
import mcpserver from "@molecule-ai/mcp-server";
const url = "/workspaces/x/activity";
`,
    );
    const r = checkConsumerFile(p);
    expect(r.pollsActivity).toBe(true);
    expect(r.importsResolutionHelper).toBe(false);
  });
});
