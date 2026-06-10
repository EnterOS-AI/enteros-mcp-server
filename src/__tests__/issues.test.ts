/**
 * Unit tests for create_issue (src/tools/issues.ts).
 *
 * Pure rendering (buildIssueBody / deriveLabelNames) is tested directly; the
 * handler is tested with a mocked global.fetch — no real Gitea calls. Mirrors
 * the fetch-mock convention in index.test.ts.
 */

import {
  buildIssueBody,
  deriveLabelNames,
  handleCreateIssue,
} from "../tools/issues.js";

function mockFetchSequence(
  responses: Array<{ ok?: boolean; status?: number; body: unknown }>,
) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: jest
        .fn()
        .mockResolvedValue(typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    });
  }
  return fn;
}

function textOf(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

const ORIGINAL_ENV = process.env;
beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    GITEA_ISSUE_TOKEN: "tok",
    GITEA_ISSUE_REPO: "molecule-ai/triage",
    GITEA_API_URL: "https://git.example/api/v1",
  };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe("buildIssueBody", () => {
  it("renders a context table, the free-text sections, redaction note + provenance", () => {
    const body = buildIssueBody({
      title: "t",
      description: "boom",
      severity: "high",
      external: true,
      org_id: "org_1",
      workspace_id: "ws_1",
      component: "runtime",
      environment: "prod",
      reproduction: "do x",
      related_ids: ["#12", "run_9"],
      logs_excerpt: "panic: nil",
    });
    expect(body).toContain("| Severity | high |");
    expect(body).toContain("| Tenancy | external (customer-facing) |");
    expect(body).toContain("| Component | runtime |");
    expect(body).toContain("## Description");
    expect(body).toContain("## Reproduction");
    expect(body).toContain("- #12");
    expect(body).toContain("Redact secrets");
    expect(body).toContain("Filed via");
  });

  it("omits the table and optional sections when no structured fields are given", () => {
    const body = buildIssueBody({ title: "t", description: "only desc" });
    expect(body).not.toContain("| Field | Value |");
    expect(body).not.toContain("## Reproduction");
    expect(body).not.toContain("## Related");
    expect(body).toContain("## Description");
  });

  it("labels tenancy internal when external=false", () => {
    expect(buildIssueBody({ title: "t", description: "d", external: false })).toContain(
      "| Tenancy | internal |",
    );
  });
});

describe("deriveLabelNames", () => {
  it("derives the taxonomy labels and dedups caller extras", () => {
    const ls = deriveLabelNames({
      title: "t",
      description: "d",
      severity: "critical",
      external: true,
      component: "cp",
      environment: "prod",
      labels: ["foo", "source/mcp-filed"],
    });
    expect(ls).toEqual(
      expect.arrayContaining([
        "source/mcp-filed",
        "severity/critical",
        "tenancy/external",
        "component/cp",
        "env/prod",
        "foo",
      ]),
    );
    expect(ls.filter((l) => l === "source/mcp-filed").length).toBe(1);
  });
});

describe("handleCreateIssue", () => {
  it("returns AUTH_ERROR when no Gitea token is set (no fetch)", async () => {
    delete process.env.GITEA_ISSUE_TOKEN;
    delete process.env.GITEA_TOKEN;
    const r = textOf(await handleCreateIssue({ title: "t", description: "d" }));
    expect(r.error).toBe("AUTH_ERROR");
  });

  it("rejects a malformed repo", async () => {
    const r = textOf(
      await handleCreateIssue({ title: "t", description: "d", repo: "bad repo" }),
    );
    expect(r.error).toBe("VALIDATION_ERROR");
  });

  it("requires a target repo when GITEA_ISSUE_REPO is unset", async () => {
    delete process.env.GITEA_ISSUE_REPO;
    const r = textOf(await handleCreateIssue({ title: "t", description: "d" }));
    expect(r.error).toBe("CONFIG_ERROR");
  });

  it("resolves label ids and POSTs the issue to the right repo", async () => {
    global.fetch = mockFetchSequence([
      { body: [{ id: 5, name: "severity/high" }, { id: 7, name: "source/mcp-filed" }] },
      {
        body: {
          number: 42,
          html_url: "https://git.example/molecule-ai/triage/issues/42",
          title: "t",
        },
      },
    ]) as unknown as typeof fetch;

    const r = textOf(await handleCreateIssue({ title: "t", description: "d", severity: "high" }));
    expect(r.ok).toBe(true);
    expect(r.number).toBe(42);
    expect(r.labels_applied).toEqual(
      expect.arrayContaining(["severity/high", "source/mcp-filed"]),
    );

    const postCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(postCall[0]).toContain("/repos/molecule-ai/triage/issues");
    const sentBody = JSON.parse(postCall[1].body);
    expect(sentBody.labels).toEqual(expect.arrayContaining([5, 7]));
    expect(sentBody.title).toBe("t");
    expect(sentBody.body).toContain("## Description");
  });

  it("reports unmatched labels rather than silently dropping them", async () => {
    global.fetch = mockFetchSequence([
      { body: [{ id: 7, name: "source/mcp-filed" }] },
      { body: { number: 1, html_url: "u", title: "t" } },
    ]) as unknown as typeof fetch;
    const r = textOf(await handleCreateIssue({ title: "t", description: "d", severity: "low" }));
    expect(r.labels_unmatched).toContain("severity/low");
  });

  it("surfaces a Gitea POST error verbatim", async () => {
    global.fetch = mockFetchSequence([
      { body: [] },
      { ok: false, status: 403, body: "forbidden" },
    ]) as unknown as typeof fetch;
    const r = textOf(await handleCreateIssue({ title: "t", description: "d" }));
    expect(r.error).toBe("AUTH_ERROR");
  });
});
