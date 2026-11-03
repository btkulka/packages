// Emails: send one, send a batch of up to 100, get one by id.

import { type Call, type CallOptions, seg, when } from "./call.js";
import { invalid } from "./errors.js";

/** Resend's ceiling on one batch. */
export const MAX_BATCH = 100;

export interface EmailAttachment {
  /** The file's bytes as Base64. This or `path`. */
  content?: string;
  /** A URL Resend fetches the file from. This or `content`. */
  path?: string;
  filename?: string;
  /** Derived from `filename` when left out. */
  content_type?: string;
  /** For an inline image: `<img src="cid:…">` in the html. Under 128 characters. */
  content_id?: string;
}

export interface EmailTag {
  /** ASCII letters, digits, _ and -; up to 256. */
  name: string;
  value: string;
}

export interface SendEmailInput {
  /** `"NHI <hello@nhi-dj.com>"` or a bare address, on a verified domain. */
  from: string;
  /** Up to 50. */
  to: string | string[];
  subject: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  html?: string;
  /** Made from `html` when left out; `""` to send none. */
  text?: string;
  headers?: Record<string, string>;
  /** Not in a batch. */
  attachments?: EmailAttachment[];
  tags?: EmailTag[];
  /** Up to 30 days ahead: a Date, ISO 8601, or natural language ("in 1 hour"). */
  scheduled_at?: string | Date;
  topic_id?: string;
}

export interface SendEmailOptions extends CallOptions {
  /**
   * Resend sends once per key for 24 hours: the same key and body again returns the first answer,
   * another body under it is a 409. 1 to 256 characters. Left out, the client makes one for the
   * call, so its own retries can never send twice.
   */
  idempotencyKey?: string;
}

export interface SendBatchOptions extends SendEmailOptions {
  /** "strict" (Resend's default): one bad email fails the batch. "permissive": the rest send, and `errors` lists the bad ones by index. */
  validation?: "strict" | "permissive";
}

export interface SendBatchResult {
  /** In the order sent. */
  data: { id: string }[];
  /** Only with `validation: "permissive"`. */
  errors?: { index: number; message: string }[];
}

export type EmailEvent =
  | "bounced"
  | "canceled"
  | "clicked"
  | "complained"
  | "delivered"
  | "delivery_delayed"
  | "failed"
  | "opened"
  | "queued"
  | "scheduled"
  | "sent"
  | "suppressed"
  | (string & {});

export interface Email {
  object: "email";
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  /** `"2026-04-03 22:13:42.674981+00"`: Resend's timestamps have a space, not a T. */
  created_at: string;
  scheduled_at: string | null;
  last_event: EmailEvent;
  tags?: EmailTag[];
}

export interface EmailsApi {
  /** POST /emails. */
  send(input: SendEmailInput, options?: SendEmailOptions): Promise<{ id: string }>;
  /** POST /emails/batch: up to 100, in one request. No attachments. */
  batch(inputs: SendEmailInput[], options?: SendBatchOptions): Promise<SendBatchResult>;
  /** GET /emails/{id}. */
  get(id: string, options?: CallOptions): Promise<Email>;
}

/** A key per call when the app doesn't give one. randomUUID is in every current browser and Node; the fallback is for an insecure page. */
function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const id = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `resend-client/${id}`;
}

const wire = (e: SendEmailInput) => ({ ...e, scheduled_at: when(e.scheduled_at) });

export function emailsApi(call: Call): EmailsApi {
  return {
    send: (input, o = {}) => call<{ id: string }>("POST", "/emails", { body: wire(input), headers: { "Idempotency-Key": o.idempotencyKey || newKey() }, signal: o.signal }),

    batch: async (inputs, o = {}) => {
      if (!inputs.length) throw invalid("A batch needs at least one email.");
      if (inputs.length > MAX_BATCH) throw invalid(`A batch takes up to ${MAX_BATCH} emails, not ${inputs.length}: split it.`);
      const headers: Record<string, string> = { "Idempotency-Key": o.idempotencyKey || newKey() };
      if (o.validation) headers["x-batch-validation"] = o.validation;
      return call<SendBatchResult>("POST", "/emails/batch", { body: inputs.map(wire), headers, signal: o.signal });
    },

    get: async (id, o) => call<Email>("GET", `/emails/${seg(id, "email id")}`, o),
  };
}
