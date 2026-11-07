// GeminiError: every failed call, with Google's HTTP status, its status name (INVALID_ARGUMENT,
// PERMISSION_DENIED…), the ErrorInfo reason when it sent one (API_KEY_INVALID, SERVICE_DISABLED…),
// and a category an app can branch on without learning Google's names.

import { HttpError, retryAfterSeconds, type HttpErrorInit, type SendResult } from "@btkulka/http-kit";

/**
 * Google's status names (the `status` in its error body), plus this package's: `missing_api_key`,
 * `retired_model`, `generation_failed`, `cancelled`, `incomplete`, `no_video`, `wait_timeout`,
 * and `timeout`, `network`, `aborted` for calls that got no answer.
 */
export type GeminiErrorCode =
  | "INVALID_ARGUMENT"
  | "FAILED_PRECONDITION"
  | "OUT_OF_RANGE"
  | "UNAUTHENTICATED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RESOURCE_EXHAUSTED"
  | "CANCELLED"
  | "INTERNAL"
  | "UNAVAILABLE"
  | "DEADLINE_EXCEEDED"
  | "missing_api_key"
  | "retired_model"
  | "generation_failed"
  | "cancelled"
  | "incomplete"
  | "no_video"
  | "wait_timeout"
  | "timeout"
  | "network"
  | "aborted"
  | (string & {});

/**
 * What an app does about a failure:
 * - `auth`: no key, or Google rejected it (invalid, expired, restricted to other APIs or sites). Fix the key.
 * - `setup`: the key is fine but its project can't do this: the Generative Language API is off, the
 *   project has no billing (video is paid-tier only), prepaid credit ran out, a spend cap was hit, or
 *   the country isn't served. Fix it in AI Studio or Google Cloud, not in the request.
 * - `validation`: Google refused the request as sent (any other 4xx), or this package did before sending.
 * - `not_found`: no such model, interaction or file (404).
 * - `rate_limit`: a 429 that waiting can fix (requests a minute). A daily quota isn't retried.
 * - `blocked`: the safety filters refused the prompt or the video, or the model finished without one.
 * - `other`: Google failed (5xx), the generation failed or was cancelled, or no answer came (timeout, network, aborted).
 */
export type GeminiErrorCategory = "auth" | "setup" | "validation" | "not_found" | "rate_limit" | "blocked" | "other";

/** ErrorInfo reasons that mean the key itself is the problem. */
const AUTH_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED",
  "API_KEY_IOS_APP_BLOCKED",
]);
/** ErrorInfo reasons that mean the key's project can't use the API yet. */
const SETUP_REASONS = new Set(["SERVICE_DISABLED", "BILLING_DISABLED", "CONSUMER_SUSPENDED", "ACCESS_TOKEN_TYPE_UNSUPPORTED"]);
/** What Google says (a 400 or 403) when the project, its billing or its country is the problem, not the request. */
const SETUP_TEXT =
  /user location is not supported|not available in your (country|region)|billing|prepa(y|id)|credit balance|spend(ing)? (cap|limit)|free tier|free_tier|paid tier/i;
/**
 * The same for a 429. Every quota 429 says "check your plan and billing details", so "billing" alone
 * means nothing here; a free-tier quota of 0 (a paid-only model on a free key), an empty prepaid
 * balance or a spend cap does.
 */
const SETUP_429_TEXT = /limit: 0\b|free_tier|free tier|prepa(y|id)|credit balance|spend(ing)? (cap|limit)|monthly (usage )?cap/i;
const SAFETY_TEXT = /\b(safety|blocked|policy|policies|prohibited|responsible ai|raiMediaFiltered|filtered)\b/i;

export interface GoogleErrorBody {
  code?: number;
  message?: string;
  status?: string;
  details?: Array<{ "@type"?: string; reason?: string; domain?: string; metadata?: Record<string, string>; violations?: Array<{ quotaId?: string; quotaMetric?: string; subject?: string; description?: string }> }>;
}

/** The category for an HTTP status, Google's status name, the ErrorInfo reason and the message. */
export function categoryOf(status: number, code: string | null | undefined, reason?: string | null, message = ""): GeminiErrorCategory {
  const c = code ?? "";
  if (c === "missing_api_key" || status === 401 || c === "UNAUTHENTICATED" || (reason && AUTH_REASONS.has(reason)) || /api key (not valid|expired|invalid)/i.test(message)) return "auth";
  if ((reason && SETUP_REASONS.has(reason)) || ((status === 400 || status === 403) && SETUP_TEXT.test(message)) || (status === 429 && SETUP_429_TEXT.test(message))) return "setup";
  if (c === "blocked" || c === "no_video") return "blocked";
  if (status === 429 || c === "RESOURCE_EXHAUSTED") return "rate_limit";
  if (status === 404 || c === "NOT_FOUND") return "not_found";
  if (status >= 400 && status < 500) return SAFETY_TEXT.test(message) && /prompt|content|video|image|output/i.test(message) ? "blocked" : "validation";
  return "other";
}

type GeminiErrorInit = HttpErrorInit & { code?: GeminiErrorCode | null; reason?: string | null; category?: GeminiErrorCategory; quotaIds?: string[] };

/**
 * Any failed Gemini call. `status` is the HTTP status (0 when no answer came), `code` Google's status
 * name (or this package's), `reason` the ErrorInfo reason when Google sent one, `category` what kind
 * of failure it is.
 */
export class GeminiError extends HttpError {
  readonly code: GeminiErrorCode | null;
  readonly reason: string | null;
  readonly category: GeminiErrorCategory;
  /** The quotas a 429 names (`GenerateRequestsPerMinutePerProjectPerModel`…), when Google listed them. */
  readonly quotaIds: string[];
  constructor(message: string, init: GeminiErrorInit = {}) {
    super(message, init);
    this.name = "GeminiError";
    this.code = init.code ?? null;
    this.reason = init.reason ?? null;
    this.quotaIds = init.quotaIds ?? [];
    this.category = init.category ?? categoryOf(this.status, this.code, this.reason, message);
  }
}

/** A GeminiError of category `auth`: no key, or Google rejected it. Never retried. */
export class GeminiAuthError extends GeminiError {
  constructor(message: string, init: GeminiErrorInit = {}) {
    super(message, { ...init, category: "auth" });
    this.name = "GeminiAuthError";
  }
}

/** True for a GeminiError, and of `category` when one is given: `isGeminiError(err, "blocked")`. */
export function isGeminiError(err: unknown, category?: GeminiErrorCategory): err is GeminiError {
  return err instanceof GeminiError && (category === undefined || err.category === category);
}

/** A request this package refuses before sending it. */
export function invalid(message: string, code: GeminiErrorCode = "INVALID_ARGUMENT"): GeminiError {
  return new GeminiError(message, { code, category: "validation" });
}

/** Google's error body is `{ error: { code, message, status, details: [{ "@type", reason, … }] } }`. */
export function geminiError(r: SendResult, url: string, label: string): GeminiError {
  const raw = r.json && typeof r.json === "object" ? (r.json as { error?: unknown }) : undefined;
  const e: GoogleErrorBody | undefined = raw?.error && typeof raw.error === "object" ? (raw.error as GoogleErrorBody) : undefined;
  const status = r.res.status;
  const code = typeof e?.status === "string" && e.status ? e.status : null;
  const details = Array.isArray(e?.details) ? e.details : [];
  const reason = details.find((d) => typeof d?.reason === "string" && d.reason)?.reason ?? null;
  const quotaIds = details.flatMap((d) => (Array.isArray(d?.violations) ? d.violations : [])).map((v) => v?.quotaId).filter((q): q is string => typeof q === "string" && !!q);
  const said = typeof e?.message === "string" && e.message ? e.message : r.text.slice(0, 300) || r.res.statusText || `HTTP ${status}`;
  const after = retryAfterSeconds(r.res);
  const category = categoryOf(status, code, reason, said);
  const init = { status, code, reason, category, quotaIds, body: r.json ?? r.text, url: redactKey(url), retryAfterMs: after == null ? undefined : after * 1000 };
  const message = `${label} failed (${status}${code ? ` ${code}` : ""}${reason ? ` ${reason}` : ""}): ${said}`;
  return category === "auth" ? new GeminiAuthError(message, init) : new GeminiError(message, init);
}

/** A failure that got no answer (http-kit's timeout, network or aborted) as a GeminiError of the same kind. */
export function wrap(err: unknown): GeminiError {
  if (err instanceof GeminiError) return err;
  if (err instanceof HttpError) {
    return new GeminiError(err.message, { kind: err.kind, status: err.status, url: redactKey(err.url), body: err.body, cause: err, code: err.kind === "http" ? null : err.kind });
  }
  return new GeminiError(err instanceof Error ? err.message : String(err), { kind: "network", code: "network", cause: err });
}

/** A `key=` query parameter never makes it into an error. */
export function redactKey(url: string): string {
  return url.replace(/([?&]key=)[^&#]*/gi, "$1***");
}
