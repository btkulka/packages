// TwilioError: every failed call, with the HTTP status and Twilio's own error code and message, so an
// app can branch on the code (21610: the recipient texted STOP) without reading the text.

import { HttpError, retryAfterSeconds, type HttpErrorInit, type SendResult } from "@btkulka/http-kit";

export interface TwilioErrorInit extends HttpErrorInit {
  /** Twilio's error code (20003, 21211, 21610…), from its error body. */
  code?: number | null;
  /** What Twilio said, without this package's "Twilio <status>: " in front. */
  twilioMessage?: string | null;
  /** Twilio's page about the code (`more_info`). */
  moreInfo?: string | null;
}

/**
 * Any failed Twilio call. `status` is the HTTP status (0 when no answer came: a timeout, a dropped
 * connection, an abort, or missing credentials), `code` Twilio's error code when it sent one.
 * The message is `Twilio <status>: <what Twilio said>`.
 */
export class TwilioError extends HttpError {
  /** Twilio's error code: 21610 means the recipient texted STOP, 21211 an invalid To number, 20003 a refused sign-in. */
  readonly code: number | null;
  readonly twilioMessage: string | null;
  readonly moreInfo: string | null;
  constructor(message: string, init: TwilioErrorInit = {}) {
    super(message, init);
    this.name = "TwilioError";
    this.code = init.code ?? null;
    this.twilioMessage = init.twilioMessage ?? null;
    this.moreInfo = init.moreInfo ?? null;
  }
}

/** No credentials, or Twilio refused them (401, or code 20003). Never retried. */
export class TwilioAuthError extends TwilioError {
  constructor(message: string, init: TwilioErrorInit = {}) {
    super(message, init);
    this.name = "TwilioAuthError";
  }
}

/** True for a TwilioError, and with Twilio's error `code` when one is given: `isTwilioError(err, 21610)`. */
export function isTwilioError(err: unknown, code?: number): err is TwilioError {
  return err instanceof TwilioError && (code === undefined || err.code === code);
}

/** A request this package refuses before sending it. */
export function invalid(message: string): TwilioError {
  return new TwilioError(message);
}

/** Twilio's error body is `{ code, message, more_info, status }`. */
export function twilioError(r: SendResult, url: string): TwilioError {
  const body = r.json && typeof r.json === "object" ? (r.json as { code?: unknown; message?: unknown; more_info?: unknown }) : undefined;
  const status = r.res.status;
  const code = typeof body?.code === "number" ? body.code : null;
  const twilioMessage = typeof body?.message === "string" && body.message ? body.message : null;
  const said = twilioMessage ?? (r.text.slice(0, 200) || r.res.statusText || `HTTP ${status}`);
  const after = retryAfterSeconds(r.res);
  const init: TwilioErrorInit = {
    status,
    code,
    twilioMessage,
    moreInfo: typeof body?.more_info === "string" ? body.more_info : null,
    body: r.json ?? r.text,
    url,
    retryAfterMs: after == null ? undefined : after * 1000,
  };
  const message = `Twilio ${status}: ${said}`;
  return status === 401 || code === 20003 ? new TwilioAuthError(message, init) : new TwilioError(message, init);
}

/** A failure that got no answer (http-kit's timeout, network or aborted) as a TwilioError of the same kind. */
export function wrap(err: unknown): TwilioError {
  if (err instanceof TwilioError) return err;
  if (err instanceof HttpError) return new TwilioError(err.message, { kind: err.kind, status: err.status, url: err.url, body: err.body, cause: err });
  return new TwilioError(err instanceof Error ? err.message : String(err), { kind: "network", cause: err });
}
