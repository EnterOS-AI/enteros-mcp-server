/**
 * Enter OS Light tools — agents that sleep between their scheduled runs.
 *
 * A Light agent (molecule-core docs/api-protocol/light-api.md, the REST contract
 * these tools follow) is a hermes workspace whose pod is stopped while it is
 * PARKED: the control plane runs each of its schedules as a Kubernetes CronJob
 * whose run pod executes the schedule's prompt as one turn and exits. Opening
 * the agent wakes its pod for chat or editing; parking it hands the schedules
 * back. The tools below wrap the client routes under /workspaces/{id}/light, and
 * light_create_agent does the whole setup of a new Light agent in one call.
 *
 * MODES. Registered in the management registry (the concierge and partner apps,
 * Org API Key) and in the default workspace registry (coding tools,
 * MOLECULE_API_KEY). NOT in self mode: core refuses a workspace's own token on
 * the Light management routes (403 LIGHT_SELF_FORBIDDEN), and self mode offers
 * only the schedule tools. The credential follows the registry: management mode
 * sends the Org API Key exactly like the other management tools
 * (management/client.ts::managementHeaders); workspace mode sends
 * api.ts::authHeaders(), which never emits the org key outside management mode.
 * No request carries X-Workspace-ID: core reads it as "the workspace itself".
 *
 * ERRORS. A refusal returns core's error body unchanged — `error` (core's
 * sentence), `code` (branch on it) and its named extras (light_state, status,
 * active_tasks, is_busy, runtime, field, run_id, key, invalid) — plus
 * `http_status` and, when the platform sent Retry-After, `retry_after_seconds`.
 * `status` in a refusal is core's extra (the workspace's status), never the
 * HTTP status. An error body without a code gets AUTH_ERROR (401/403),
 * RATE_LIMITED (429) or PLATFORM_ERROR, keeping the platform's sentence.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PLATFORM_URL, authHeaders, isApiError, toMcpResult } from "../api.js";
import { isManagementMode } from "../mode.js";
import { error as logError } from "../utils/logger.js";
import { validate } from "../utils/validation.js";
import { managementHeaders, managementUrl } from "./management/client.js";
import { defaultProvisionWorkspaceModel } from "./management/index.js";

export const LIGHT_TOOL_NAMES = [
  "light_status",
  "light_enable",
  "light_disable",
  "light_park",
  "light_open",
  "light_run_now",
  "light_runs",
  "light_create_agent",
] as const;

/**
 * The refusals light-api.md says to retry after a few seconds: another Light
 * operation is running, the agent is working, it is not online, or its pod is
 * still stopping. Any 503 (LIGHT_BACKEND_UNAVAILABLE, with Retry-After) is
 * transient too.
 */
export const LIGHT_TRANSIENT_CODES: readonly string[] = [
  "LIGHT_TRANSITION_IN_PROGRESS",
  "LIGHT_AGENT_BUSY",
  "LIGHT_AGENT_NOT_AWAKE",
  "LIGHT_AGENT_AWAKE",
];
const TRANSIENT = new Set(LIGHT_TRANSIENT_CODES);
/** last_error codes that mean "still in progress", not a failure. */
const IN_PROGRESS_ERRORS = new Set(["LIGHT_OPEN_INCOMPLETE", "LIGHT_PARK_INCOMPLETE"]);
const AWAKE = new Set(["online", "degraded"]);
const TERMINAL = new Set(["failed", "paused", "removed"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "Poll every few seconds" (light-api.md). */
const POLL_INTERVAL_MS = 3_000;
/** Backoff of a retried refusal: 2 s doubling to 30 s; Retry-After replaces it. */
const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Per request: core bounds the synchronous part of a park or open at 3 minutes. */
const REQUEST_TIMEOUT_MS = 200_000;
const DEFAULT_SETUP_TIMEOUT_S = 1_800;
const RAW_BODY_LIMIT = 512;
/** The schedule grid's limits (SDK contracts/schedule). */
const MAX_SCHEDULES = 100;
const MAX_SCHEDULE_NAME = 128;
const MAX_CRON = 128;
const MAX_PROMPT_BYTES = 16_384;
const SCHEDULE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A Light tool's failure: core's error body unchanged, plus where it came from. */
export type LightFailure = {
  /** Core's sentence, or this server's when the platform gave none. */
  error: string;
  /** Core's code: branch on it, never on `error`. */
  code: string;
  http_status?: number;
  retry_after_seconds?: number;
  /** The start of an answer that was not JSON. */
  detail?: string;
  /** Core's named extras, unchanged. */
  [extra: string]: unknown;
};

type Answer =
  | { ok: true; status: number; body: unknown }
  | { ok: false; failure: LightFailure; network: boolean };
type Refused = Extract<Answer, { ok: false }>;

/** The clock light_create_agent polls and backs off with; tests inject a fake one. */
export interface LightClock {
  now(): number;
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemLightClock: LightClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

type ProgressNotification = {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; message?: string };
};

/** The parts of the MCP SDK's per-call `extra` these tools use. */
export interface LightToolExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Connection =
  | { ok: true; base: string; headers: Record<string, string> }
  | { ok: false; failure: LightFailure };

/** Where the request goes and with which credential, by registry (see MODES). */
function connection(): Connection {
  if (isManagementMode()) {
    const headers = managementHeaders();
    if (isApiError(headers)) {
      return { ok: false, failure: { error: headers.detail ?? headers.error, code: "AUTH_ERROR" } };
    }
    return { ok: true, base: managementUrl(), headers };
  }
  return {
    ok: true,
    base: PLATFORM_URL,
    headers: { "Content-Type": "application/json", ...authHeaders() },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): { value: unknown } | undefined {
  if (text === "") return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined; // a gateway page or a proxy's plain-text error
  }
}

/** Seconds from a Retry-After value: delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function fallbackCode(status: number): string {
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 429) return "RATE_LIMITED";
  return "PLATFORM_ERROR";
}

/** A non-2xx answer as a LightFailure: core's body unchanged plus http_status. */
function refusal(
  status: number,
  text: string,
  json: { value: unknown } | undefined,
  retryAfter: string | null,
  now: number,
): LightFailure {
  const body = json && isObject(json.value) ? json.value : undefined;
  const { error, code, ...extras } = body ?? {};
  const failure: LightFailure = {
    error: typeof error === "string" && error !== "" ? error : `HTTP ${status}`,
    code: typeof code === "string" && code !== "" ? code : fallbackCode(status),
    ...extras,
    http_status: status,
  };
  if (!body && text !== "") failure.detail = text.slice(0, RAW_BODY_LIMIT);
  const seconds = parseRetryAfter(retryAfter, now);
  if (seconds !== undefined) failure.retry_after_seconds = seconds;
  return failure;
}

interface LightRequestOptions {
  /** JSON body; omitted means the request has none (the Light POSTs take none). */
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Clock for Retry-After dates. */
  now?: () => number;
}

const CANCELLED_FAILURE: LightFailure = { error: "the call was cancelled", code: "CANCELLED" };

/** One request to the tenant. Never throws. */
async function lightRequest(
  method: "GET" | "POST",
  path: string,
  opts: LightRequestOptions = {},
): Promise<Answer> {
  if (opts.signal?.aborted) return { ok: false, failure: { ...CANCELLED_FAILURE }, network: false };
  const conn = connection();
  if (!conn.ok) return { ok: false, failure: conn.failure, network: false };

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const search = params.toString();
  const url = `${conn.base}${path}${search ? `?${search}` : ""}`;

  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onCallerAbort = () => timeout.abort();
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let status: number;
  let retryAfter: string | null;
  let text: string;
  try {
    const res = await fetch(url, {
      method,
      headers: conn.headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: timeout.signal,
    });
    status = res.status;
    retryAfter = res.headers.get("Retry-After");
    text = await res.text();
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, failure: { ...CANCELLED_FAILURE }, network: false };
    const detail = timeout.signal.aborted
      ? `no answer within ${Math.round(timeoutMs / 1000)} s`
      : err instanceof Error
        ? err.message
        : String(err);
    logError(err, `Light API error (${method} ${path})`, { url: conn.base });
    return {
      ok: false,
      failure: { error: `Platform unreachable at ${conn.base}`, code: "PLATFORM_ERROR", detail },
      network: true,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }

  const json = parseJson(text);
  if (status < 200 || status > 299) {
    const now = (opts.now ?? Date.now)();
    return { ok: false, failure: refusal(status, text, json, retryAfter, now), network: false };
  }
  if (json === undefined) {
    const failure: LightFailure = {
      error: `the platform answered ${status} without a JSON body`,
      code: "PLATFORM_ERROR",
      http_status: status,
    };
    if (text !== "") failure.detail = text.slice(0, RAW_BODY_LIMIT);
    return { ok: false, failure, network: false };
  }
  return { ok: true, status, body: json.value };
}

const lightPath = (workspaceId: string, route?: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/light${route ? `/${route}` : ""}`;

/** Core's answer unchanged on success; the LightFailure (an MCP error) otherwise. */
function toResult(answer: Answer) {
  return toMcpResult(answer.ok ? answer.body : answer.failure);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const workspaceId = z
  .string()
  .uuid()
  .describe("Workspace UUID of the Light agent (from list_workspaces or light_create_agent).");

const WorkspaceArgs = z.object({ workspace_id: workspaceId });

const RunNowArgs = z.object({
  workspace_id: workspaceId,
  schedule: z
    .string()
    .min(1)
    .max(MAX_SCHEDULE_NAME)
    .describe("Name of the schedule to run, as light_status lists it."),
});

const RunsArgs = z.object({
  workspace_id: workspaceId,
  limit: z.number().int().min(1).max(100).optional().describe("Runs per page, 1 to 100 (default 20)."),
  schedule: z.string().min(1).max(MAX_SCHEDULE_NAME).optional().describe("Only this schedule's runs."),
  before: z
    .string()
    .min(1)
    .optional()
    .describe("The next_before of the previous page (or an RFC 3339 time), for older runs."),
});

const LightScheduleArgs = z.object({
  name: z
    .string()
    .max(MAX_SCHEDULE_NAME)
    .regex(SCHEDULE_NAME_RE, "must be a lowercase slug: a-z, 0-9 and single hyphens")
    .describe("Unique schedule name: a lowercase slug (a-z, 0-9, single hyphens), at most 128 characters."),
  cron: z
    .string()
    .trim()
    .min(1)
    .max(MAX_CRON)
    // Core's parser is the standard five-field one: no seconds field, no
    // @-descriptors. Checked here so a bad cron is refused before the agent exists.
    .refine(
      (c) => c.split(/\s+/).length === 5,
      "must have five fields (minute hour day-of-month month day-of-week), e.g. '0 9 * * *'",
    )
    .describe("Five-field cron expression, e.g. '0 9 * * *' for 09:00 every day."),
  timezone: z
    .string()
    .trim()
    .min(1)
    .describe("IANA time zone the cron runs in, e.g. 'America/Vancouver'."),
  prompt: z
    .string()
    .refine((p) => p.trim() !== "", "must not be empty")
    .refine((p) => Buffer.byteLength(p, "utf8") <= MAX_PROMPT_BYTES, `must be at most ${MAX_PROMPT_BYTES} bytes`)
    .describe("What the agent is asked to do on each run, as one turn (at most 16 KiB)."),
  enabled: z.boolean().optional().describe("false keeps the schedule without running it (default true)."),
});

const CreateLightAgentArgs = z.object({
  name: z.string().trim().min(1).describe("The agent's display name."),
  schedules: z
    .array(LightScheduleArgs)
    .min(1)
    .max(MAX_SCHEDULES)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      list.forEach((s, i) => {
        if (seen.has(s.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "name"],
            message: `schedule name "${s.name}" is used twice`,
          });
        }
        seen.add(s.name);
      });
    })
    .describe("What the agent does and when: 1 to 100 schedules, each run as one turn."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("LLM model id. Omit unless the user named a model; omitted values use the platform default."),
  secrets: z
    .record(z.string())
    .optional()
    .describe("Workspace secrets stored encrypted at creation (env var name to value), e.g. API keys the prompts need."),
  timeout_seconds: z
    .number()
    .int()
    .min(60)
    .max(3600)
    .optional()
    .describe(`Time limit for the whole setup, 60 to 3600 seconds (default ${DEFAULT_SETUP_TIMEOUT_S}).`),
});

export type CreateLightAgentInput = z.infer<typeof CreateLightAgentArgs>;

// ---------------------------------------------------------------------------
// Route tools
// ---------------------------------------------------------------------------

/** light_status — GET /workspaces/{id}/light. */
export async function handleLightStatus(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, WorkspaceArgs);
  return toResult(await lightRequest("GET", lightPath(p.workspace_id), { signal: extra?.signal }));
}

/** light_enable — POST /workspaces/{id}/light/enable (no body). */
export async function handleLightEnable(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, WorkspaceArgs);
  return toResult(await lightRequest("POST", lightPath(p.workspace_id, "enable"), { signal: extra?.signal }));
}

/** light_disable — POST /workspaces/{id}/light/disable (no body). */
export async function handleLightDisable(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, WorkspaceArgs);
  return toResult(await lightRequest("POST", lightPath(p.workspace_id, "disable"), { signal: extra?.signal }));
}

/** light_park — POST /workspaces/{id}/light/park (no body); 202 parking or 200 unchanged. */
export async function handleLightPark(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, WorkspaceArgs);
  return toResult(await lightRequest("POST", lightPath(p.workspace_id, "park"), { signal: extra?.signal }));
}

/** light_open — POST /workspaces/{id}/light/open (no body); 202 opening or 200 unchanged. */
export async function handleLightOpen(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, WorkspaceArgs);
  return toResult(await lightRequest("POST", lightPath(p.workspace_id, "open"), { signal: extra?.signal }));
}

/** light_run_now — POST /workspaces/{id}/light/run with exactly {"schedule": name}. */
export async function handleLightRunNow(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, RunNowArgs);
  return toResult(
    await lightRequest("POST", lightPath(p.workspace_id, "run"), {
      body: { schedule: p.schedule },
      signal: extra?.signal,
    }),
  );
}

/** light_runs — GET /workspaces/{id}/light/runs?limit=&schedule=&before=; answers {runs, next_before}. */
export async function handleLightRuns(args: unknown, extra?: LightToolExtra) {
  const p = validate(args, RunsArgs);
  return toResult(
    await lightRequest("GET", lightPath(p.workspace_id, "runs"), {
      query: { limit: p.limit, schedule: p.schedule, before: p.before },
      signal: extra?.signal,
    }),
  );
}

// ---------------------------------------------------------------------------
// light_create_agent
// ---------------------------------------------------------------------------

/** The steps of light_create_agent, in order (named in progress and in failures). */
export type LightSetupStep =
  | "create"
  | "wait-online"
  | "create-schedules"
  | "enable"
  | "wait-restart"
  | "park"
  | "wait-parked";

const STEP_MESSAGES: Record<LightSetupStep, string> = {
  create: "creating the hermes workspace",
  "wait-online": "waiting for the agent to come online",
  "create-schedules": "creating the schedules",
  enable: "enabling Light",
  "wait-restart": "waiting for the restart that applies Light, then for the agent to be online and idle",
  park: "parking the agent",
  "wait-parked": "waiting until the agent is parked",
};

export interface CreateLightAgentOptions {
  clock?: LightClock;
  signal?: AbortSignal;
  onStep?: (step: LightSetupStep) => void;
}

type WorkspaceView = { status: string; activeTasks: number; lastSampleError: string };

function readWorkspace(body: unknown): WorkspaceView {
  const w = isObject(body) ? body : {};
  return {
    status: typeof w.status === "string" ? w.status : "",
    activeTasks: typeof w.active_tasks === "number" ? w.active_tasks : 0,
    lastSampleError: typeof w.last_sample_error === "string" ? w.last_sample_error : "",
  };
}

const isAwake = (w: WorkspaceView) => AWAKE.has(w.status);
const isIdle = (w: WorkspaceView) => isAwake(w) && w.activeTasks === 0;

function lastErrorOf(info: Record<string, unknown>): { code: string; message: string } | undefined {
  const le = info.last_error;
  if (!isObject(le) || typeof le.code !== "string" || le.code === "") return undefined;
  return { code: le.code, message: typeof le.message === "string" ? le.message : "" };
}

/** Light calls are idempotent: retry the doc's transient refusals and a request that got no answer. */
const lightRetryable = (a: Refused) =>
  a.network || a.failure.http_status === 503 || TRANSIENT.has(a.failure.code);
/**
 * Schedule create: the scheduler is starting (core answers 503 once its own
 * forward retries are spent), a gateway timeout, or no answer (core makes a
 * repeated identical create idempotent). A 502 is a refusal core relayed.
 */
const scheduleCreateRetryable = (a: Refused) =>
  a.network || a.failure.http_status === 503 || a.failure.http_status === 504;
/** Reads worth another poll: no answer, a 5xx or a 429. */
const transientRead = (a: Refused) =>
  a.network || (a.failure.http_status ?? 0) >= 500 || a.failure.http_status === 429;

function retryDelay(attempt: number, failure: LightFailure): number {
  const seconds = failure.retry_after_seconds;
  if (typeof seconds === "number" && seconds > 0) return seconds * 1000;
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** attempt);
}

const attemptsField = (attempts: number) => (attempts > 1 ? { attempts } : {});

/** What a failed setup left behind, and what the caller can do next. */
function setupNote(step: LightSetupStep, workspaceId: string): string {
  const remove = isManagementMode() ? "deprovision_workspace" : "delete_workspace";
  const enabled = step === "wait-restart" || step === "park" || step === "wait-parked";
  return enabled
    ? `Workspace ${workspaceId} was created and Light is enabled, but it is not parked (light_status shows its state). ` +
        `It was kept: fix the cause and call light_park, or delete it with ${remove}.`
    : `Workspace ${workspaceId} was created but is not a Light agent yet: it is an ordinary 24/7 agent. ` +
        `It was kept: fix the cause and continue with light_enable and light_park, or delete it with ${remove}.`;
}

type StepResult<T> = { ok: true; value: T } | { ok: false; result: Record<string, unknown> };

const CANCELLED = Symbol("cancelled");

class CreateLightAgentFlow {
  private step: LightSetupStep = "create";
  private workspaceId: string | undefined;

  constructor(
    private readonly clock: LightClock,
    private readonly deadline: number,
    private readonly signal: AbortSignal | undefined,
    private readonly onStep: ((step: LightSetupStep) => void) | undefined,
  ) {}

  async run(input: CreateLightAgentInput): Promise<Record<string, unknown>> {
    try {
      return await this.steps(input);
    } catch (err) {
      if (err === CANCELLED) return this.fail({ ...CANCELLED_FAILURE });
      throw err;
    }
  }

  private async steps(input: CreateLightAgentInput): Promise<Record<string, unknown>> {
    const model = input.model ?? defaultProvisionWorkspaceModel();

    this.enter("create");
    const createBody: Record<string, unknown> = { name: input.name, runtime: "hermes", model };
    if (input.secrets !== undefined) createBody.secrets = input.secrets;
    // Not retried: a create is not idempotent. Its answer also carries the new
    // workspace's own token (auth_token), which is never kept or returned.
    const created = await this.request("POST", "/workspaces", createBody);
    if (!created.ok) return this.fail(created.failure);
    const id = isObject(created.body) ? created.body.id : undefined;
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      return this.fail({
        error: "the workspace create answer carries no workspace id",
        code: "PLATFORM_ERROR",
        http_status: created.status,
      });
    }
    this.workspaceId = id;
    const wsPath = `/workspaces/${encodeURIComponent(id)}`;

    this.enter("wait-online");
    const online = await this.waitForWorkspace(wsPath, "the agent online", isAwake);
    if (!online.ok) return online.result;

    this.enter("create-schedules");
    for (const s of input.schedules) {
      const body = { name: s.name, cron_expr: s.cron, timezone: s.timezone, prompt: s.prompt, enabled: s.enabled ?? true };
      const { answer, attempts } = await this.retrying(
        () => this.request("POST", `${wsPath}/schedules`, body),
        scheduleCreateRetryable,
      );
      if (!answer.ok) return this.fail(answer.failure, { schedule: s.name, ...attemptsField(attempts) });
    }

    this.enter("enable");
    const { answer: enabled, attempts: enableAttempts } = await this.retrying(
      () => this.request("POST", lightPath(id, "enable")),
      lightRetryable,
    );
    if (!enabled.ok) return this.fail(enabled.failure, attemptsField(enableAttempts));

    // Park only once the restart enable started is done: a park before it would
    // copy an env without MOLECULE_LIGHT=1 and be refused (LIGHT_RESTART_REQUIRED).
    // A restart may be pending when enable started one, and also when it
    // answered unchanged: on the agent this flow just created, that means an
    // earlier enable call (retried because its answer was lost) did the enable.
    this.enter("wait-restart");
    const answer = isObject(enabled.body) ? enabled.body : {};
    let restarted = !(answer.restart === "started" || answer.status === "unchanged");
    const idle = await this.waitForWorkspace(
      wsPath,
      restarted ? "the agent online and idle" : "the restart that applies Light, then the agent online and idle",
      (w) => {
        if (!restarted) {
          restarted = !isAwake(w);
          return false;
        }
        return isIdle(w);
      },
    );
    if (!idle.ok) return idle.result;

    const parked = await this.parkAndWait(id);
    if (!parked.ok) return parked.result;
    return { workspace_id: id, name: input.name, model, light_state: "parked", light: parked.value };
  }

  /**
   * Parks and waits for parked. Retries the transient refusals and a park undone
   * after its 202 because the agent was working (open + LIGHT_AGENT_BUSY).
   */
  private async parkAndWait(id: string): Promise<StepResult<Record<string, unknown>>> {
    for (let attempt = 0; ; attempt += 1) {
      this.enter("park");
      const answer = await this.request("POST", lightPath(id, "park"));
      let failure: LightFailure;
      if (!answer.ok) {
        if (!lightRetryable(answer)) {
          return { ok: false, result: this.fail(answer.failure, attemptsField(attempt + 1)) };
        }
        failure = answer.failure;
      } else {
        this.enter("wait-parked");
        const waited = await this.waitForParked(id);
        if (waited.kind === "parked") return { ok: true, value: waited.info };
        if (waited.kind === "failed") return { ok: false, result: waited.result };
        failure = waited.failure;
      }
      const delay = retryDelay(attempt, failure);
      if (delay > this.remaining()) {
        return { ok: false, result: this.fail(failure, attemptsField(attempt + 1)) };
      }
      await this.sleep(delay);
    }
  }

  /** Polls GET /light until parked, or until the agent settles elsewhere with a last_error. */
  private async waitForParked(
    id: string,
  ): Promise<
    | { kind: "parked"; info: Record<string, unknown> }
    | { kind: "busy"; failure: LightFailure }
    | { kind: "failed"; result: Record<string, unknown> }
  > {
    let last: Record<string, unknown> | undefined;
    for (;;) {
      const answer = await this.request("GET", lightPath(id));
      if (answer.ok) {
        last = isObject(answer.body) ? answer.body : {};
        const state = last.light_state;
        if (state === "parked") return { kind: "parked", info: last };
        if (state === null) {
          return {
            kind: "failed",
            result: this.fail({
              error: "the agent is no longer a Light agent (light_state is null)",
              code: "LIGHT_NOT_ENABLED",
              light_state: null,
            }),
          };
        }
        const lastError = lastErrorOf(last);
        if (state !== "parking" && state !== "opening" && lastError && !IN_PROGRESS_ERRORS.has(lastError.code)) {
          const settled: LightFailure = {
            error: lastError.message || `the agent settled in light_state ${String(state)}`,
            code: lastError.code,
            light_state: state,
            last_error: last.last_error,
          };
          if (state === "open" && lastError.code === "LIGHT_AGENT_BUSY") return { kind: "busy", failure: settled };
          return { kind: "failed", result: this.fail(settled) };
        }
      } else if (!transientRead(answer)) {
        return { kind: "failed", result: this.fail(answer.failure) };
      }
      const remaining = this.remaining();
      if (remaining <= 0) {
        const seen = last ? { light_state: last.light_state ?? null, last_error: last.last_error ?? null } : {};
        return {
          kind: "failed",
          result: this.fail({
            error: "timed out waiting for light_state parked",
            code: "LIGHT_SETUP_TIMEOUT",
            waiting_for: "light_state parked",
            ...seen,
          }),
        };
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  /** Polls GET /workspaces/{id} until `ready`; fails at once when the agent failed, was paused or removed. */
  private async waitForWorkspace(
    wsPath: string,
    waitingFor: string,
    ready: (w: WorkspaceView) => boolean,
  ): Promise<StepResult<WorkspaceView>> {
    let last: WorkspaceView | undefined;
    for (;;) {
      const answer = await this.request("GET", wsPath);
      if (answer.ok) {
        last = readWorkspace(answer.body);
        if (TERMINAL.has(last.status)) {
          const failure: LightFailure = {
            error: `the agent is ${last.status}${last.lastSampleError ? `: ${last.lastSampleError}` : ""}`,
            code: "LIGHT_SETUP_AGENT_FAILED",
            workspace_status: last.status,
          };
          if (last.lastSampleError) failure.last_sample_error = last.lastSampleError;
          return { ok: false, result: this.fail(failure) };
        }
        if (ready(last)) return { ok: true, value: last };
      } else if (!transientRead(answer)) {
        return { ok: false, result: this.fail(answer.failure) };
      }
      const remaining = this.remaining();
      if (remaining <= 0) {
        const seen = last ? { workspace_status: last.status, active_tasks: last.activeTasks } : {};
        return {
          ok: false,
          result: this.fail({
            error: `timed out waiting for ${waitingFor}`,
            code: "LIGHT_SETUP_TIMEOUT",
            waiting_for: waitingFor,
            ...seen,
          }),
        };
      }
      await this.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  /** Runs `send` until it succeeds or `retryable` refuses; gives up when the next wait would pass the limit. */
  private async retrying(
    send: () => Promise<Answer>,
    retryable: (a: Refused) => boolean,
  ): Promise<{ answer: Answer; attempts: number }> {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await send();
      if (answer.ok || !retryable(answer)) return { answer, attempts: attempt + 1 };
      const delay = retryDelay(attempt, answer.failure);
      if (delay > this.remaining()) return { answer, attempts: attempt + 1 };
      await this.sleep(delay);
    }
  }

  private enter(step: LightSetupStep): void {
    this.step = step;
    this.onStep?.(step);
  }

  private remaining(): number {
    return this.deadline - this.clock.now();
  }

  private async sleep(ms: number): Promise<void> {
    try {
      await this.clock.sleep(ms, this.signal);
    } catch (err) {
      if (this.signal?.aborted) throw CANCELLED;
      throw err;
    }
  }

  private request(method: "GET" | "POST", path: string, body?: unknown): Promise<Answer> {
    return lightRequest(method, path, {
      body,
      signal: this.signal,
      timeoutMs: Math.max(1_000, Math.min(REQUEST_TIMEOUT_MS, this.remaining())),
      now: () => this.clock.now(),
    });
  }

  /** The failure as light_create_agent returns it: core's code and message, the step, and the workspace once it exists. */
  private fail(failure: LightFailure, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const out: Record<string, unknown> = { ...failure, ...extra, step: this.step };
    if (this.workspaceId !== undefined) {
      out.workspace_id = this.workspaceId;
      out.note = setupNote(this.step, this.workspaceId);
    }
    return out;
  }
}

/**
 * The light_create_agent flow: POST /workspaces (runtime hermes) → wait online →
 * create each schedule → enable → wait out the restart until online and idle →
 * park → wait parked. Retries the doc's transient refusals (and 503 with
 * Retry-After) with backoff within the total time limit; any other failure stops
 * the flow with core's code and message, the step, and the workspace id once it
 * exists (the workspace is kept). Never throws for a platform failure.
 */
export async function createLightAgent(
  input: CreateLightAgentInput,
  opts: CreateLightAgentOptions = {},
): Promise<Record<string, unknown>> {
  const clock = opts.clock ?? systemLightClock;
  const timeoutMs = (input.timeout_seconds ?? DEFAULT_SETUP_TIMEOUT_S) * 1000;
  return new CreateLightAgentFlow(clock, clock.now() + timeoutMs, opts.signal, opts.onStep).run(input);
}

/** MCP progress for each step when the caller sent a progressToken. Best effort. */
function progressReporter(extra?: LightToolExtra): ((message: string) => void) | undefined {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || send === undefined) return undefined;
  let progress = 0;
  return (message) => {
    progress += 1;
    try {
      send({ method: "notifications/progress", params: { progressToken: token, progress, message } }).catch(
        () => undefined,
      );
    } catch {
      // A lost progress notification must not fail the setup.
    }
  };
}

/** light_create_agent — the one-call Light agent setup (see createLightAgent). */
export async function handleLightCreateAgent(args: unknown, extra?: LightToolExtra) {
  const input = validate(args, CreateLightAgentArgs);
  const report = progressReporter(extra);
  const out = await createLightAgent(input, {
    signal: extra?.signal,
    onStep: report ? (step) => report(`${step}: ${STEP_MESSAGES[step]}`) : undefined,
  });
  return toMcpResult(out);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLightTools(srv: McpServer) {
  srv.tool(
    "light_create_agent",
    "Enter OS Light: create a Light agent, a hermes agent that sleeps between scheduled runs and costs no " +
      "compute while idle. Choose Light over a 24/7 agent when the work is a known set of recurring tasks " +
      "(e.g. a social post every morning, an SEO scan every evening) and nobody needs to chat with the agent " +
      "between runs; use provision_workspace for an agent that must answer people or other agents at any time. " +
      "One call does the whole setup and returns once the agent is parked (usually several minutes): creates " +
      "the workspace, waits until it is online, creates the schedules, enables Light, waits out the restart and " +
      "parks it. Transient refusals are retried with backoff until timeout_seconds; any other failure returns " +
      "core's code and message plus step and workspace_id (the workspace is kept, not deleted). A parked agent " +
      "refuses chat: light_open it first.",
    CreateLightAgentArgs.shape,
    handleLightCreateAgent,
  );
  srv.tool(
    "light_status",
    "Enter OS Light: get a Light agent's state. light_state is null for an ordinary 24/7 agent, open = awake " +
      "(chat works, its schedules are paused), parking, parked = asleep (its schedules run on time without it), " +
      "or opening. Also last_error (why a background step failed), refresh_pending, and the schedules as of " +
      "its last park with next_run_at and suspension (a schedule whose last three runs failed is suspended). " +
      "After light_park or light_open, poll this every few seconds until light_state is parked or open.",
    WorkspaceArgs.shape,
    handleLightStatus,
  );
  srv.tool(
    "light_enable",
    "Enter OS Light: make an existing hermes workspace a Light agent (light_state open). Core stores " +
      "MOLECULE_LIGHT=1 and restarts the agent; wait until get_workspace shows it online and idle again, then " +
      "light_park (a park before the restart is done is refused with LIGHT_RESTART_REQUIRED). Hermes agents on " +
      "Kubernetes tenants only (LIGHT_RUNTIME_UNSUPPORTED, LIGHT_UNSUPPORTED). For a new agent use " +
      "light_create_agent, which does every step.",
    WorkspaceArgs.shape,
    handleLightEnable,
  );
  srv.tool(
    "light_disable",
    "Enter OS Light: turn a Light agent back into an ordinary 24/7 agent, from any Light state. Deletes its " +
      "scheduled jobs, restores its 24/7 setting and restarts or wakes it. Its run history (light_runs) is kept.",
    WorkspaceArgs.shape,
    handleLightDisable,
  );
  srv.tool(
    "light_park",
    "Enter OS Light: park an open Light agent so it sleeps and its schedules run on time without it. Answers " +
      "light_state parking at once; poll light_status until parked (usually within a minute). Parking also " +
      "resumes schedules core suspended after failed runs. A parked agent refuses chat, delegation and restarts " +
      "with 409 LIGHT_AGENT_PARKED: open it first. Retry later on LIGHT_AGENT_BUSY (it is working), " +
      "LIGHT_AGENT_NOT_AWAKE (not online) or LIGHT_TRANSITION_IN_PROGRESS.",
    WorkspaceArgs.shape,
    handleLightPark,
  );
  srv.tool(
    "light_open",
    "Enter OS Light: wake a parked Light agent for chat or editing. Pauses its schedules (runs not started yet " +
      "are cancelled) and starts its pod; answers light_state opening at once, so poll light_status until open " +
      "(as long as the agent's boot). Schedule edits need open, edit, park: open it, change its schedules with " +
      "create_schedule / update_schedule / delete_schedule, then light_park so its runs use them. An open agent " +
      "parks itself after 30 minutes without activity.",
    WorkspaceArgs.shape,
    handleLightOpen,
  );
  srv.tool(
    "light_run_now",
    "Enter OS Light: run one schedule of a parked Light agent now, outside its cron times; it runs even when " +
      "the schedule is off or suspended (to try a fix). Returns run_id; the run shows in light_runs once it " +
      "starts. Refused with LIGHT_NOT_PARKED unless the agent is parked.",
    RunNowArgs.shape,
    handleLightRunNow,
  );
  srv.tool(
    "light_runs",
    "Enter OS Light: list a Light agent's runs, newest first: schedule, status (running, succeeded, failed, " +
      "timed_out, cancelled), scheduled_for, started_at, finished_at, output (its last 64 KiB) and error. For " +
      "older runs pass next_before back as before; it is null on the last page.",
    RunsArgs.shape,
    handleLightRuns,
  );
}
