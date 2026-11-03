// ResendError: every failed call, with Resend's status and error name, and a category an app can
// branch on without learning Resend's names (auth, validation, not_found, rate_limit, other).

import { HttpError, retryAfterSeconds, type HttpErrorInit, type SendResult } from "@btkulka/http-kit";

/**
 * Resend's error names (the `name` in its error body), plus this package's for calls that got no
 * answer: `timeout`, `network`, `aborted`.
 */
export type ResendErrorCode =
  | "missing_api_key"
  | "restricted_api_key"
  | "suspended_api_key"
  | "invalid_permission"
  | "validation_error"
  | "missing_required_field"
  | "missing_required_parameter"
  | "invalid_parameter"
  | "invalid_attachment"
  | "invalid_idempotency_key"
  | "invalid_idempotent_request"
  | "concurrent_idempotent_requests"
  | "resource_locked"
  | "email_above_quota"
  | "not_found"
  | "method_not_allowed"
  | "rate_limit_exceeded"
  | "daily_quota_exceeded"
  | "monthly_quota_exceeded"
  | "application_error"
  | "service_unavailable"
  | "timeout"
  | "network"
  | "aborted"
  | (string & {});

/**
 * What an app does about a failure:
 * - `auth`: no key, or a missing, invalid, restricted or suspended one, or one without the scope. Fix the key.
 * - `validation`: Resend refused the request as sent (any other 4xx: a bad field, an unverified domain, an Idempotency-Key reused with another body). Fix the request.
 * - `not_found`: no such email, domain, contact, segment or broadcast (404).
 * - `rate_limit`: a 429. Too many requests a second is retried; the daily or monthly sending quota isn't.
 * - `other`: Resend failed (5xx), or no answer came (timeout, network, aborted).
 */
export type ResendErrorCategory = "auth" | "validation" | "not_found" | "rate_limit" | "other";

const AUTH = new Set(["missing_api_key", "invalid_api_key", "restricted_api_key", "suspended_api_key", "invalid_permission"]);
/** The sending quotas: a 429 that retrying can't fix until the quota resets. */
export const QUOTA_CODES: ReadonlySet<string> = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);

/** The category for a status, Resend's error name and its message (Resend sends an invalid key as a `validation_error` "API key is invalid"). */
export function categoryOf(status: number, code: string | null | undefined, message = ""): ResendErrorCategory {
  const name = (code ?? "").toLowerCase();
  if (status === 401 || AUTH.has(name) || (name === "validation_error" && /\bapi key\b/i.test(message))) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "validation";
  return "other";
}

type ResendErrorInit = HttpErrorInit & { code?: ResendErrorCode | null; category?: ResendErrorCategory };

/**
 * Any failed Resend call. `status` is Resend's `statusCode` (0 when no answer came), `code` its error
 * `name` (or this package's), `category` what kind of failure it is.
 */
export class ResendError extends HttpError {
  readonly code: ResendErrorCode | null;
  readonly category: ResendErrorCategory;
  constructor(message: string, init: ResendErrorInit = {}) {
    super(message, init);
    this.name = "ResendError";
    this.code = init.code ?? null;
    this.category = init.category ?? categoryOf(this.status, this.code);
  }
}

/** A ResendError of category `auth`: no key, or Resend rejected it. Never retried. */
export class ResendAuthError extends ResendError {
  constructor(message: string, init: ResendErrorInit = {}) {
    super(message, { ...init, category: "auth" });
    this.name = "ResendAuthError";
  }
}

/** True for a ResendError, and of `category` when one is given: `isResendError(err, "not_found")`. */
export function isResendError(err: unknown, category?: ResendErrorCategory): err is ResendError {
  return err instanceof ResendError && (category === undefined || err.category === category);
}

/** A request this package refuses before sending it. */
export function invalid(message: string): ResendError {
  return new ResendError(message, { code: "validation_error", category: "validation" });
}

/** Resend's error body is `{ statusCode, name, message }`. */
export function resendError(r: SendResult, url: string, label: string): ResendError {
  const body = r.json && typeof r.json === "object" ? (r.json as { name?: unknown; message?: unknown }) : undefined;
  const status = r.res.status;
  const code = typeof body?.name === "string" && body.name ? body.name : null;
  const said = typeof body?.message === "string" && body.message ? body.message : r.text.slice(0, 300) || r.res.statusText || `HTTP ${status}`;
  const after = retryAfterSeconds(r.res);
  const category = categoryOf(status, code, said);
  const init = { status, code, category, body: r.json ?? r.text, url, retryAfterMs: after == null ? undefined : after * 1000 };
  const message = `${label} failed (${status}${code ? ` ${code}` : ""}): ${said}`;
  return category === "auth" ? new ResendAuthError(message, init) : new ResendError(message, init);
}

/** A failure that got no answer (http-kit's timeout, network or aborted) as a ResendError of the same kind. */
export function wrap(err: unknown): ResendError {
  if (err instanceof ResendError) return err;
  if (err instanceof HttpError) return new ResendError(err.message, { kind: err.kind, status: err.status, url: err.url, body: err.body, cause: err, code: err.kind === "http" ? null : err.kind });
  return new ResendError(err instanceof Error ? err.message : String(err), { kind: "network", code: "network", cause: err });
}
