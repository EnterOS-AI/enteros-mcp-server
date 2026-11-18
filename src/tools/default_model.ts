/**
 * The model a new workspace gets when the caller names none: the PLATFORM
 * default, never a model this server picks.
 *
 * Resolution, first answer wins:
 *   1. MOLECULE_LLM_DEFAULT_MODEL in this server's env. Core gives a concierge
 *      the default its tenant holds (conciergePlatformMCPEnv) and the runtime
 *      forwards it to this child.
 *   2. default_model from GET /admin/llm/offered-models?runtime=<runtime>: the
 *      same default, as the tenant reports it for that runtime.
 * When neither answers, the tool call fails with INVALID_ARGUMENTS and sends
 * nothing: a workspace must never be created on a vendor model the platform did
 * not choose. The concierge's own model (MOLECULE_MODEL / MODEL) is deliberately
 * not consulted: it may be a BYOK pick or an older default.
 *
 * One exception: a runtime the tenant's model registry does not know (404
 * "unknown runtime", e.g. external) has no platform default to apply. The
 * caller then omits the model and core decides (an external workspace needs
 * none).
 */

export const DEFAULT_MODEL_ENV = "MOLECULE_LLM_DEFAULT_MODEL";
export const OFFERED_MODELS_PATH = "/admin/llm/offered-models";
/** Most characters of the tenant's answer quoted in an error. */
const DETAIL_LIMIT = 300;

/** How a caller fetched GET /admin/llm/offered-models. */
export type OfferedModelsAnswer =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; body?: unknown; detail: string };

/** Fetches GET /admin/llm/offered-models (with ?runtime= when runtime is set). */
export type OfferedModelsFetcher = (runtime: string | undefined) => Promise<OfferedModelsAnswer>;

export type DefaultModelResolution =
  | { kind: "model"; model: string; source: typeof DEFAULT_MODEL_ENV | "offered-models" }
  /** The registry has no model menu for this runtime: send no model. */
  | { kind: "none"; reason: string }
  /** No default could be resolved: fail the call, send nothing. */
  | { kind: "unresolved"; detail: string };

/** GET /admin/llm/offered-models[?runtime=<runtime>]. */
export function offeredModelsPath(runtime: string | undefined): string {
  const rt = runtime?.trim();
  return rt ? `${OFFERED_MODELS_PATH}?runtime=${encodeURIComponent(rt)}` : OFFERED_MODELS_PATH;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON body, or a JSON string carrying one (the management client keeps error bodies as text). */
function jsonObject(v: unknown): Record<string, unknown> | undefined {
  if (isObject(v)) return v;
  if (typeof v !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(v);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function forRuntime(runtime: string | undefined): string {
  return runtime?.trim() ? `runtime ${runtime.trim()}` : "the default runtime";
}

/** Resolves the platform default for a workspace on `runtime` (see the module doc). */
export async function resolvePlatformDefaultModel(
  runtime: string | undefined,
  fetchOffered: OfferedModelsFetcher,
): Promise<DefaultModelResolution> {
  const fromEnv = process.env[DEFAULT_MODEL_ENV]?.trim();
  if (fromEnv) return { kind: "model", model: fromEnv, source: DEFAULT_MODEL_ENV };

  const path = offeredModelsPath(runtime);
  const answer = await fetchOffered(runtime);
  if (answer.ok) {
    const body = isObject(answer.body) ? answer.body : {};
    const model = typeof body.default_model === "string" ? body.default_model.trim() : "";
    if (model) return { kind: "model", model, source: "offered-models" };
    return {
      kind: "unresolved",
      detail: `${DEFAULT_MODEL_ENV} is not set and GET ${path} names no default_model for ${forRuntime(runtime)}`,
    };
  }
  const refusal = jsonObject(answer.body);
  if (answer.status === 404 && refusal?.error === "unknown runtime") {
    return { kind: "none", reason: `the model registry has no models for ${forRuntime(runtime)}` };
  }
  const status = answer.status !== undefined ? `HTTP ${answer.status}: ` : "";
  const why = answer.detail.length > DETAIL_LIMIT ? `${answer.detail.slice(0, DETAIL_LIMIT)}…` : answer.detail;
  return {
    kind: "unresolved",
    detail: `${DEFAULT_MODEL_ENV} is not set and GET ${path} failed (${status}${why})`,
  };
}

/** The INVALID_ARGUMENTS sentence for an unresolved default. */
export function unresolvedDefaultModelMessage(detail: string): string {
  return (
    "model was omitted and the platform default model could not be resolved: " +
    `${detail}. Nothing was created. Pass an explicit model id ` +
    `(GET ${OFFERED_MODELS_PATH}?runtime=<runtime> lists the models a runtime offers).`
  );
}
