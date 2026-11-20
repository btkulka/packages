// MeshyError: every failed call, with the HTTP status, Meshy's message, and a category an app can branch on.
// Meshy's error body is `{ "message": "..." }` (docs.meshy.ai/api/errors). A task that fails is not an HTTP error:
// it answers 200 with status FAILED and a `task_error` of `{ type, code?, message, doc_url? }`, which `wait` turns
// into a MeshyError of category `task_failed` with that object on `taskError`.

import { HttpError, retryAfterSeconds, type HttpErrorInit, type SendResult } from "@btkulka/http-kit";

/**
 * This package's codes: `missing_api_key`, `invalid_request` (refused before sending), `task_failed`,
 * `task_canceled`, `no_model` (succeeded without the file asked for), `wait_timeout`, `insecure_url`, and
 * `timeout`, `network`, `aborted` for calls that got no answer. For an HTTP error, `code` is null and
 * `status` says it; for a failed task, `taskError.type` and `taskError.code` are Meshy's own.
 */
export type MeshyErrorCode =
  | "missing_api_key"
  | "invalid_request"
  | "task_failed"
  | "task_canceled"
  | "no_model"
  | "wait_timeout"
  | "insecure_url"
  | "timeout"
  | "network"
  | "aborted"
  | (string & {});

/**
 * What an app does about a failure (docs.meshy.ai/api/errors, read 2026-11-19):
 * - `auth`: no key, or Meshy doesn't know it (401). Fix the key.
 * - `credits`: 402: not enough credits, a credit limit on the key, or a Free plan (no API). Buy credits or a plan.
 * - `forbidden`: 403: the key's IP allowlist, the plan lacks this endpoint, content moderation, an inactive team
 *   member's key, a banned account. Meshy's message says which.
 * - `validation`: 400 or 422 (or this package refused it before sending). Fix the request.
 * - `not_found`: 404. No such task.
 * - `conflict`: 409: deleting a task that is still IN_PROGRESS.
 * - `rate_limit`: 429: too many requests a second (Retry-After), or too many tasks queued or running
 *   ("NoMorePendingTasks", no Retry-After: wait for one to finish).
 * - `task_failed`: the task ended FAILED or CANCELED. Its credits are refunded. `taskError.type` says whether
 *   making it again can help (`timeout`, `service_unavailable`, `server_error`) or not (`invalid_input`).
 * - `other`: 5xx, a timeout, a dropped connection, an abort, a wait that ran out.
 */
export type MeshyErrorCategory = "auth" | "credits" | "forbidden" | "validation" | "not_found" | "conflict" | "rate_limit" | "task_failed" | "other";

/** A FAILED task's `task_error`. */
export interface TaskError {
  /** Always there: `invalid_input`, `timeout`, `service_unavailable`, `server_error` (Meshy may add more). */
  type?: string;
  /** A documented problem, when Meshy names one (`image_too_complex`…). */
  code?: string;
  message?: string;
  doc_url?: string;
}

/** Failed-task types Meshy says to retry by creating the task again (docs.meshy.ai/api/errors). */
export const RETRYABLE_TASK_ERRORS: readonly string[] = ["timeout", "service_unavailable", "server_error"];

/** The category for an HTTP status and this package's code. */
export function categoryOf(status: number, code: string | null | undefined): MeshyErrorCategory {
  const c = code ?? "";
  if (c === "missing_api_key" || status === 401) return "auth";
  if (c === "task_failed" || c === "task_canceled") return "task_failed";
  if (c === "invalid_request" || c === "insecure_url") return "validation";
  if (status === 402) return "credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "validation";
  return "other";
}

type MeshyErrorInit = HttpErrorInit & { code?: MeshyErrorCode | null; category?: MeshyErrorCategory; taskError?: TaskError | null; taskId?: string | null };

/** Any failed Meshy call or task. `status` is the HTTP status (0 when no answer came, or for a failed task). */
export class MeshyError extends HttpError {
  readonly code: MeshyErrorCode | null;
  readonly category: MeshyErrorCategory;
  /** A failed task's `task_error`, as Meshy sent it. */
  readonly taskError: TaskError | null;
  /** The task this is about, when it is about one. */
  readonly taskId: string | null;
  constructor(message: string, init: MeshyErrorInit = {}) {
    super(message, init);
    this.name = "MeshyError";
    this.code = init.code ?? null;
    this.taskError = init.taskError ?? null;
    this.taskId = init.taskId ?? null;
    this.category = init.category ?? categoryOf(this.status, this.code);
  }
  /** A failed task that Meshy says may work if created again (its type is timeout, service_unavailable or server_error). */
  get worthRetrying(): boolean {
    return this.category === "task_failed" && !!this.taskError?.type && RETRYABLE_TASK_ERRORS.includes(this.taskError.type);
  }
}

/** True for a MeshyError, and of `category` when one is given: `isMeshyError(err, "credits")`. */
export function isMeshyError(err: unknown, category?: MeshyErrorCategory): err is MeshyError {
  return err instanceof MeshyError && (category === undefined || err.category === category);
}

/** A request this package refuses before sending it. */
export function invalid(message: string): MeshyError {
  return new MeshyError(message, { code: "invalid_request", category: "validation" });
}

/** An answer that wasn't 2xx, as a MeshyError: Meshy's `message`, the status, its Retry-After. */
export function meshyError(r: SendResult, url: string, label: string): MeshyError {
  const j = r.json && typeof r.json === "object" ? (r.json as { message?: unknown }) : undefined;
  const status = r.res.status;
  const said = typeof j?.message === "string" && j.message ? j.message : r.text.slice(0, 300) || r.res.statusText || `HTTP ${status}`;
  const after = retryAfterSeconds(r.res);
  return new MeshyError(`${label} failed (${status}): ${said}`, { status, body: r.json ?? r.text, url, retryAfterMs: after == null ? undefined : after * 1000 });
}

/** A failure that got no answer (http-kit's timeout, network or aborted) as a MeshyError of the same kind. */
export function wrap(err: unknown): MeshyError {
  if (err instanceof MeshyError) return err;
  if (err instanceof HttpError) {
    return new MeshyError(err.message, { kind: err.kind, status: err.status, url: err.url, body: err.body, cause: err, code: err.kind === "http" ? null : err.kind, retryAfterMs: err.retryAfterMs });
  }
  return new MeshyError(err instanceof Error ? err.message : String(err), { kind: "network", code: "network", cause: err });
}
