// Broadcasts: an email to a segment. `create` only ever makes a draft (Resend's `send` flag is never
// passed), so nothing goes out until the app calls `send`, now or at `scheduled_at`.

import { type Call, type CallOptions, type ListOptions, type ResendList, listQuery, seg, when } from "./call.js";

/** `draft` (editable, deletable), `scheduled` (deletable, which cancels it), `queued` (going out), `sent`, `canceled`. */
export type BroadcastStatus = "draft" | "scheduled" | "queued" | "sent" | "canceled" | (string & {});

export interface Broadcast {
  object?: "broadcast";
  id: string;
  name: string | null;
  segment_id: string | null;
  /** The old name for segment_id, still in Resend's answers. */
  audience_id?: string | null;
  from: string | null;
  subject: string | null;
  reply_to: string | string[] | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  status: BroadcastStatus;
  created_at: string;
  scheduled_at: string | null;
  sent_at: string | null;
  topic_id?: string | null;
}

/** What a list gives for each broadcast: no from, subject or body. */
export type BroadcastSummary = Pick<Broadcast, "id" | "name" | "segment_id" | "audience_id" | "status" | "created_at" | "scheduled_at" | "sent_at">;

export interface CreateBroadcastInput {
  /** The segment it goes to. */
  segment_id: string;
  /** `"NHI <news@nhi-dj.com>"`, on a verified domain. */
  from: string;
  subject: string;
  reply_to?: string | string[];
  /** Merge tags (`mergeTag`) and the unsubscribe link (`RESEND_UNSUBSCRIBE_URL`) go here. */
  html?: string;
  /** Made from `html` when left out; `""` to send none. */
  text?: string;
  /** Only for finding it again in Resend. */
  name?: string;
  /** The inbox preview line. */
  preview_text?: string;
  /** Scope it to a topic: only contacts opted in get it. Left out: every subscribed contact in the segment. */
  topic_id?: string;
}

export type UpdateBroadcastInput = Partial<CreateBroadcastInput>;

export interface SendBroadcastOptions extends CallOptions {
  /** Left out: now. A Date, ISO 8601, or natural language ("in 1 hour", "tomorrow at 9am"). */
  scheduled_at?: string | Date;
}

export interface BroadcastsApi {
  /** POST /broadcasts, as a draft. */
  create(input: CreateBroadcastInput, options?: CallOptions): Promise<{ object: "broadcast"; id: string }>;
  /** GET /broadcasts/{id}. */
  get(id: string, options?: CallOptions): Promise<Broadcast>;
  /** GET /broadcasts. */
  list(options?: ListOptions): Promise<ResendList<BroadcastSummary>>;
  /** PATCH /broadcasts/{id}: a draft's fields. */
  update(id: string, patch: UpdateBroadcastInput, options?: CallOptions): Promise<{ object: "broadcast"; id: string }>;
  /**
   * POST /broadcasts/{id}/send: now, or at `scheduled_at`. Only a 429 is retried (Resend refused it
   * outright); a timeout or a 5xx is thrown as it is, because the broadcast may have gone out: check
   * its status with `get` before sending again.
   */
  send(id: string, options?: SendBroadcastOptions): Promise<{ id: string }>;
  /** DELETE /broadcasts/{id}: a draft, or a scheduled one (which cancels it). Not once it's queued or sent. */
  delete(id: string, options?: CallOptions): Promise<{ object: "broadcast"; id: string; deleted: boolean }>;
}

const FIELDS = ["segment_id", "from", "subject", "reply_to", "html", "text", "name", "preview_text", "topic_id"] as const;

/** Only a draft's fields, so a stray `send` or `scheduled_at` from a caller can't reach Resend. */
function draft(input: UpdateBroadcastInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (input[k] !== undefined) out[k] = input[k];
  return out;
}

export function broadcastsApi(call: Call): BroadcastsApi {
  const path = (id: string) => `/broadcasts/${seg(id, "broadcast id")}`;
  return {
    create: (input, o = {}) => call("POST", "/broadcasts", { body: draft(input), signal: o.signal }),
    get: async (id, o) => call<Broadcast>("GET", path(id), o),
    list: async (o = {}) => call<ResendList<BroadcastSummary>>("GET", "/broadcasts", { query: listQuery(o), signal: o.signal }),
    update: async (id, patch, o = {}) => call("PATCH", path(id), { body: draft(patch), signal: o.signal }),
    send: async (id, o = {}) => call("POST", `${path(id)}/send`, { body: { scheduled_at: when(o.scheduled_at) }, retry: "rate_limit", signal: o.signal }),
    delete: async (id, o) => call("DELETE", path(id), o),
  };
}
