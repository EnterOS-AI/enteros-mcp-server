import { InvalidArgumentsError } from "../utils/validation.js";
import { handlePromoteToProduction } from "../tools/management/cp_admin.js";

function mockFetch(payload: unknown, status = 200) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  });
}

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

const TARGET_IMAGE = `registry.moleculesai.app/molecule-ai/molecule-tenant@sha256:${"a".repeat(64)}`;

function promoteSuccess(dryRun: boolean, env = "production") {
  const tenantResults = ["tenant-a", "tenant-b"].map((slug, index) => ({
    slug,
    instance_id: `instance-${index + 1}`,
    provider: index === 0 ? "local" : "hetzner",
    phase: index === 0 ? "canary" : "batch-1",
    ssm_status: dryRun ? "DryRun" : "Success",
    healthz_ok: !dryRun,
    verified_on_target: !dryRun,
    ...(dryRun ? {} : { running_image: TARGET_IMAGE }),
  }));
  return {
    ok: true,
    complete: !dryRun,
    env,
    dry_run: dryRun,
    results: [{
      component: "tenant-fleet",
      status: dryRun ? "planned" : "ok",
      target_image: TARGET_IMAGE,
      coverage: {
        target_image: TARGET_IMAGE,
        enumerated: 2,
        planned: dryRun ? 2 : 0,
        refreshed: dryRun ? 0 : 2,
        verified_on_target: dryRun ? 0 : 2,
        failed: 0,
        stragglers: [],
      },
      tenant_results: tenantResults,
    }],
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.MOLECULE_CP_URL = "https://api.moleculesai.app";
  delete process.env.CP_ADMIN_API_TOKEN;
  delete process.env.CP_PROMOTE_PROD_API_TOKEN;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("promote_to_production v2", () => {
  it("defaults to a non-mutating production plan and sends exactly the four contract fields once", async () => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const f = mockFetch(promoteSuccess(true));
    global.fetch = f as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({}));

    expect(out).toMatchObject({ ok: true, complete: false, dry_run: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.moleculesai.app/cp/admin/promote");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer prod-promote-token");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("curl/8.4.0");
    expect(JSON.parse(init.body as string)).toEqual({
      env: "production",
      components: ["tenant-fleet"],
      dry_run: true,
      confirm: false,
    });
  });

  it("uses only the generic staging admin token for a staging plan", async () => {
    process.env.MOLECULE_CP_URL = "https://staging-api.moleculesai.app";
    process.env.CP_ADMIN_API_TOKEN = "staging-admin-token";
    process.env.CP_PROMOTE_PROD_API_TOKEN = "must-not-be-used";
    const f = mockFetch(promoteSuccess(true, "staging"));
    global.fetch = f as unknown as typeof fetch;

    await handlePromoteToProduction({ env: "staging", dry_run: true });

    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://staging-api.moleculesai.app/cp/admin/promote");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer staging-admin-token");
    expect(JSON.parse(init.body as string).env).toBe("staging");
  });

  it("defaults an explicit staging assertion to the staging control-plane domain", async () => {
    delete process.env.MOLECULE_CP_URL;
    delete process.env.CP_API_URL;
    delete process.env.MOLECULE_CP_STAGING_URL;
    process.env.CP_ADMIN_API_TOKEN = "staging-admin-token";
    const f = mockFetch(promoteSuccess(true, "staging"));
    global.fetch = f as unknown as typeof fetch;

    await handlePromoteToProduction({ env: "staging", dry_run: true });

    expect(f.mock.calls[0][0]).toBe("https://staging-api.moleculesai.app/cp/admin/promote");
  });

  it("never substitutes the generic CP admin token for the production capability", async () => {
    process.env.CP_ADMIN_API_TOKEN = "generic-must-not-promote-production";
    const f = mockFetch({ ok: true, complete: false });
    global.fetch = f as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: true }));

    expect(out.error).toBe("CP_PROMOTE_NOT_CONFIGURED");
    expect(f).not.toHaveBeenCalled();
  });

  it("requires explicit confirm for every wet request before network", async () => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const f = mockFetch(promoteSuccess(false));
    global.fetch = f as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: false }));

    expect(out.error).toBe("CONFIRMATION_REQUIRED");
    expect(f).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ["all"], ["tenant-fleet"]])(
    "canonicalizes selector %p to the sole tenant-fleet component",
    async (components) => {
      process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
      const f = mockFetch(promoteSuccess(true));
      global.fetch = f as unknown as typeof fetch;
      const args = components === undefined ? { dry_run: true } : { dry_run: true, components };

      await handlePromoteToProduction(args);

      const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
      expect(body.components).toEqual(["tenant-fleet"]);
    },
  );

  it.each([
    { target_tag: "latest" },
    { rollback_to: "old" },
    { env: "preview" },
    { components: ["canvas"] },
    { components: ["tenant-fleet", "tenant-fleet"] },
    { dry_run: 0 },
    { confirm: 1 },
  ])("rejects non-contract input before network: %p", async (args) => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const f = mockFetch({});
    global.fetch = f as unknown as typeof fetch;

    await expect(handlePromoteToProduction(args)).rejects.toBeInstanceOf(InvalidArgumentsError);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects an accepted/queued HTTP 202 response", async () => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const f = mockFetch(promoteSuccess(false), 202);
    global.fetch = f as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: false, confirm: true }));

    expect(out.error).toBe("PROMOTE_FAILED");
    expect(out.detail).toMatchObject({ error: "HTTP 202", status: 202 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ok: false, complete: false },
    { ok: true, complete: true },
    { ok: true },
    { ok: true, complete: false, env: "production", dry_run: true, results: [] },
  ])("fails closed on an invalid dry-run completion: %p", async (payload) => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    global.fetch = mockFetch(payload) as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: true }));

    expect(out.error).toBe("PROMOTE_INCOMPLETE");
  });

  it.each([
    { ok: false, complete: true, results: [{ component: "tenant-fleet", status: "ok" }] },
    { ok: true, complete: false, results: [{ component: "tenant-fleet", status: "ok" }] },
    { ok: true, complete: true, results: [] },
    { ok: true, complete: true, results: [{ component: "other", status: "ok" }] },
    { ok: true, complete: true, results: [{ component: "tenant-fleet", status: "failed" }] },
    { ok: true, complete: true, results: [
      { component: "tenant-fleet", status: "ok" },
      { component: "tenant-fleet", status: "ok" },
    ] },
  ])("fails closed on invalid wet completion: %p", async (payload) => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    global.fetch = mockFetch(payload) as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: false, confirm: true }));

    expect(out.error).toBe("PROMOTE_INCOMPLETE");
  });

  it("fails closed when a nominal wet result lacks exact immutable fleet coverage", async () => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const payload = promoteSuccess(false);
    payload.results[0].coverage.verified_on_target = 1;
    global.fetch = mockFetch(payload) as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({ dry_run: false, confirm: true }));

    expect(out.error).toBe("PROMOTE_INCOMPLETE");
  });

  it("returns exact verified wet evidence after one CP POST", async () => {
    process.env.CP_PROMOTE_PROD_API_TOKEN = "prod-promote-token";
    const payload = promoteSuccess(false);
    const f = mockFetch(payload);
    global.fetch = f as unknown as typeof fetch;

    const out = parsed(await handlePromoteToProduction({
      env: "production",
      components: ["all"],
      dry_run: false,
      confirm: true,
    }));

    expect(out).toEqual(payload);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
