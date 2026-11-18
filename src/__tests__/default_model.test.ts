/**
 * Unit tests for src/tools/default_model.ts: the platform default model a new
 * workspace gets when the caller names none.
 */

import {
  offeredModelsPath,
  resolvePlatformDefaultModel,
  unresolvedDefaultModelMessage,
  type OfferedModelsAnswer,
} from "../tools/default_model.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MOLECULE_LLM_DEFAULT_MODEL;
  delete process.env.MOLECULE_MODEL;
  delete process.env.MODEL;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const never = async (): Promise<OfferedModelsAnswer> => {
  throw new Error("the tenant must not be asked");
};
const answering = (answer: OfferedModelsAnswer) => {
  const asked: Array<string | undefined> = [];
  return {
    asked,
    fetch: async (runtime: string | undefined) => {
      asked.push(runtime);
      return answer;
    },
  };
};

describe("resolvePlatformDefaultModel", () => {
  it("takes MOLECULE_LLM_DEFAULT_MODEL first, trimmed, without asking the tenant", async () => {
    process.env.MOLECULE_LLM_DEFAULT_MODEL = "  google/gemini-4-hydrogen ";
    await expect(resolvePlatformDefaultModel("hermes", never)).resolves.toEqual({
      kind: "model",
      model: "google/gemini-4-hydrogen",
      source: "MOLECULE_LLM_DEFAULT_MODEL",
    });
  });

  it("treats a blank MOLECULE_LLM_DEFAULT_MODEL as unset", async () => {
    process.env.MOLECULE_LLM_DEFAULT_MODEL = "   ";
    const t = answering({ ok: true, body: { default_model: "google/gemini-4-hydrogen" } });
    await expect(resolvePlatformDefaultModel("claude-code", t.fetch)).resolves.toMatchObject({
      kind: "model",
      model: "google/gemini-4-hydrogen",
      source: "offered-models",
    });
    expect(t.asked).toEqual(["claude-code"]);
  });

  it("never falls back to the caller's own model or to any built-in model", async () => {
    process.env.MOLECULE_MODEL = "minimax/MiniMax-M2.7";
    process.env.MODEL = "minimax/MiniMax-M2.7";
    const t = answering({ ok: true, body: { runtime: "hermes", default_model: "  ", models: [] } });
    const out = await resolvePlatformDefaultModel("hermes", t.fetch);
    expect(out.kind).toBe("unresolved");
    expect(JSON.stringify(out)).not.toContain("MiniMax");
  });

  it("reports a 404 unknown runtime as no default to apply (send no model)", async () => {
    const t = answering({ ok: false, status: 404, body: '{"error":"unknown runtime","runtime":"external"}', detail: "x" });
    await expect(resolvePlatformDefaultModel("external", t.fetch)).resolves.toMatchObject({ kind: "none" });
  });

  it("a 404 that is not core's unknown-runtime answer is a failure, not a pass", async () => {
    const t = answering({ ok: false, status: 404, body: "404 page not found", detail: "404 page not found" });
    const out = await resolvePlatformDefaultModel("hermes", t.fetch);
    expect(out).toMatchObject({ kind: "unresolved" });
    expect(out.kind === "unresolved" && out.detail).toContain("HTTP 404");
  });

  it("caps the tenant's answer it quotes", async () => {
    const t = answering({ ok: false, status: 502, body: "x".repeat(5000), detail: "x".repeat(5000) });
    const out = await resolvePlatformDefaultModel("hermes", t.fetch);
    expect(out.kind === "unresolved" && out.detail.length).toBeLessThan(500);
  });
});

describe("helpers", () => {
  it("offeredModelsPath adds ?runtime= only for a runtime", () => {
    expect(offeredModelsPath("claude-code")).toBe("/admin/llm/offered-models?runtime=claude-code");
    expect(offeredModelsPath(" ")).toBe("/admin/llm/offered-models");
    expect(offeredModelsPath(undefined)).toBe("/admin/llm/offered-models");
    expect(offeredModelsPath("a b&c")).toBe("/admin/llm/offered-models?runtime=a%20b%26c");
  });

  it("the error says nothing was created and how to pick a model", () => {
    const msg = unresolvedDefaultModelMessage("why");
    expect(msg).toContain("why");
    expect(msg).toContain("Nothing was created");
    expect(msg).toContain("/admin/llm/offered-models?runtime=<runtime>");
  });
});
