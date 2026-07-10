/**
 * Reader-binding test — management-MCP credentials contract
 * (molecule-ai-sdk contracts/credentials).
 *
 * WHY THIS EXISTS
 * ───────────────
 * This server is the READER of the Org API Key. `managementHeaders()` in
 * `src/tools/management/client.ts` authenticates every org-scoped tool call
 * with `Authorization: Bearer ${process.env.MOLECULE_ORG_API_KEY}` — STRICT,
 * no alias accepted. The credentials contract (molecule-ai-sdk, the root-level
 * SSOT for the credential/privilege model) declares that env key as the
 * canonical `org-api-key` credential AND as a REQUIRED member of
 * `management_mcp_env.required`, and lists the historical misname `ORG_API_KEY`
 * under `management_mcp_env.deprecated_do_not_use`.
 *
 * That misname is the ORIGINAL bug. core's `conciergePlatformMCPEnv` sets
 * `MOLECULE_ORG_API_KEY`; an older workspace-runtime forward-allowlist carried
 * an UNPREFIXED `ORG_API_KEY` that nobody set and stripped the prefixed name;
 * and this reader — which reads ONLY `MOLECULE_ORG_API_KEY` — therefore got
 * nothing, so every freshly provisioned concierge degraded with
 * `AUTH_ERROR — MOLECULE_ORG_API_KEY is not set` (fixed end-to-end in
 * molecule-ai-workspace-runtime#259; the forwarder is drift-gated in #260 and
 * the core setter in molecule-core#3716).
 *
 * The existing management auth tests (management.test.ts) exercise the same
 * behaviour but HARD-CODE `MOLECULE_ORG_API_KEY`, so a rename of BOTH the
 * reader and those tests back to the deprecated key would stay green. This test
 * closes that gap: it reads the key names FROM the vendored contract (never
 * hard-coded) and would fail the moment the reader stopped honouring the
 * contract's canonical name or started honouring the deprecated one — offline,
 * on day one, instead of via a fleet-wide runtime degrade.
 *
 * CONTRACT-SHARING MECHANISM: vendored copy + CI sync-check, exactly like the
 * verb-binding gate (see contract-verb-binding.test.ts and
 * .gitea/scripts/check-credentials-vendor-sync.sh). The unit test reads a local
 * file so it is offline/deterministic; a separate CI step byte-compares that
 * file against molecule-ai-sdk's canonical so the vendored copy cannot silently
 * drift.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {},
}));
jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

import { mgmtGet } from "../tools/management/client.js";

interface CredentialEntry {
  id: string;
  env_key: string;
  aliases: string[];
  reader?: string;
}
interface CredentialsContract {
  credentials: CredentialEntry[];
  management_mcp_env: {
    required: string[];
    deprecated_do_not_use: string[];
  };
}

const CONTRACT_PATH = join(__dirname, "..", "..", "contracts", "credentials.contract.json");

function loadContract(): CredentialsContract {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as CredentialsContract;
}

const contract = loadContract();
const orgApiKeyCred = contract.credentials.find((c) => c.id === "org-api-key");
const CANONICAL = orgApiKeyCred?.env_key ?? "";
const DEPRECATED = contract.management_mcp_env.deprecated_do_not_use;
const ORG_ID = "org-11111111";
const HOST = "https://agents-team.moleculesai.app";

/** Mock fetch returning an empty-object JSON body; records call args. */
function mockFetch() {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: jest.fn().mockResolvedValue("{}"),
  });
}

function headersOf(fetchMock: jest.Mock): Record<string, string> {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return ((init as RequestInit).headers as Record<string, string>) || {};
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MOLECULE_API_URL = HOST;
  process.env.MOLECULE_ORG_ID = ORG_ID;
  // Start from a clean org-credential slate so each test declares exactly which
  // name it sets (a leaked canonical/deprecated env would mask the assertion).
  delete process.env.MOLECULE_ORG_API_KEY;
  for (const name of DEPRECATED) delete process.env[name];
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("management-MCP credentials contract (reader binding)", () => {
  test("contract declares a strict org-api-key credential + deprecates the unprefixed name", () => {
    // Guard the vendored copy itself: the reader's whole design (strict, no
    // alias) is what makes the deprecated-name test below meaningful.
    expect(orgApiKeyCred).toBeDefined();
    expect(CANONICAL).toBe("MOLECULE_ORG_API_KEY");
    expect(orgApiKeyCred?.aliases).toEqual([]);
    expect(contract.management_mcp_env.required).toContain(CANONICAL);
    expect(DEPRECATED).toContain("ORG_API_KEY");
    // Canonical and deprecated must be disjoint — a name can't be both.
    expect(DEPRECATED).not.toContain(CANONICAL);
  });

  test("the reader authenticates with the contract's canonical org-api-key env", async () => {
    // The core gate keys a healthy concierge off this reader succeeding. Set the
    // contract's canonical name and assert the outgoing tenant request carries
    // it as the Bearer credential — proving the reader binds to the SSOT name.
    const secret = "org_testkey_canonical";
    process.env[CANONICAL] = secret;
    const f = mockFetch();
    global.fetch = f as unknown as typeof fetch;

    const res = await mgmtGet("/workspaces");

    expect(f).toHaveBeenCalledTimes(1);
    expect(headersOf(f).Authorization).toBe(`Bearer ${secret}`);
    // A successful (mocked) call must not surface an AUTH_ERROR.
    expect((res as { error?: string }).error).toBeUndefined();
  });

  test.each(DEPRECATED)(
    "the reader IGNORES the deprecated name %s (the original concierge AUTH_ERROR)",
    async (deprecatedName) => {
      // Set ONLY the deprecated name — the exact broken state the runtime
      // forward-allowlist used to produce. A reader that honoured it would
      // authenticate; the strict reader must fail closed with no network call.
      process.env[deprecatedName] = "org_testkey_deprecated";
      const f = mockFetch();
      global.fetch = f as unknown as typeof fetch;

      const res = (await mgmtGet("/workspaces")) as { error?: string };

      expect(res.error).toBe("AUTH_ERROR");
      expect(f).not.toHaveBeenCalled();
    },
  );
});
