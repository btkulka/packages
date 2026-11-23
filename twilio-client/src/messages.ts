// Texts: send one, list a page or several, the texts that came in to a number since an instant, and
// every text to and from one number. `POST` and `GET /2010-04-01/Accounts/{sid}/Messages.json`.

import { day, isoDate, pageSize, type Call, type CallOptions, type TwilioPage } from "./call.js";

export type TwilioMessageDirection = "inbound" | "outbound-api" | "outbound-call" | "outbound-reply" | (string & {});
export type TwilioMessageStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "delivered"
  | "undelivered"
  | "receiving"
  | "received"
  | "accepted"
  | "scheduled"
  | "read"
  | "partially_delivered"
  | "canceled"
  | (string & {});

/** A Message resource as Twilio sends it. Dates are RFC 2822 ("Wed, 18 Aug 2010 20:01:40 +0000"); `messageDate` reads one. */
export interface TwilioMessage {
  sid: string;
  account_sid?: string;
  messaging_service_sid?: string | null;
  from: string;
  to: string;
  body: string | null;
  status: TwilioMessageStatus;
  direction: TwilioMessageDirection;
  date_sent?: string | null;
  date_created?: string;
  date_updated?: string;
  /** A count, sent as a string ("0"). */
  num_media?: string | number;
  num_segments?: string | number;
  error_code?: number | null;
  error_message?: string | null;
  price?: string | null;
  price_unit?: string | null;
  uri?: string;
}

/** One page of texts. */
export interface MessagePage extends TwilioPage {
  messages: TwilioMessage[];
}

export interface SendMessageInput {
  /** E.164 (+15125550100). Sent as it is. */
  to: string;
  body: string;
  /** The number it goes out from. With neither this nor `messagingServiceSid`: the client's `messagingServiceSid`, else its `from`. */
  from?: string;
  /** A Messaging Service (MG…) to send through instead of one number. */
  messagingServiceSid?: string;
}

export interface ListMessagesOptions extends CallOptions {
  /** Texts sent to this number. */
  to?: string;
  /** Texts sent from this number. */
  from?: string;
  /** Sent on or after this day, GMT (`DateSent>`): a Date (its UTC day) or YYYY-MM-DD. */
  dateSentAfter?: Date | string;
  /** 1 to 1000. Left out, Twilio sends 50. */
  pageSize?: number;
}

export interface ListAllMessagesOptions extends ListMessagesOptions {
  /** Pages to read at most, following `next_page_uri`. Default 5. */
  maxPages?: number;
}

export interface InboundOptions extends CallOptions {
  /** Default 100. */
  pageSize?: number;
  /** Default 5. */
  maxPages?: number;
}

export interface ThreadOptions extends CallOptions {
  /** Texts read each way (one page of each). Default 100. */
  pageSize?: number;
}

export interface MessagesApi {
  /**
   * Sends a text: `POST /Messages.json` with To, Body and From or MessagingServiceSid. Only a 429 is
   * retried: after a timeout or a 5xx the text may have gone out, and Twilio has no idempotency key.
   */
  send(input: SendMessageInput, options?: CallOptions): Promise<TwilioMessage>;
  /** One page, newest first (Twilio's order). */
  list(options?: ListMessagesOptions): Promise<MessagePage>;
  /** Pages one after another, following `next_page_uri`, up to `maxPages`. Newest first. */
  listAll(options?: ListAllMessagesOptions): Promise<TwilioMessage[]>;
  /**
   * Texts that came in to `number` at or after `since`, oldest first. Twilio filters by day
   * (`DateSent>` the UTC day of `since`); the rest of the day and the outbound texts are filtered here.
   */
  inbound(number: string, since: Date, options?: InboundOptions): Promise<TwilioMessage[]>;
  /** Every text to or from `number` (one page each way, read at once), each once, oldest first. A blank number: []. */
  thread(number: string, options?: ThreadOptions): Promise<TwilioMessage[]>;
}

/** When a text was sent (`date_sent`, else `date_created`) as ISO 8601, or "" when Twilio gave neither or it's unreadable. */
export function messageDate(m: Pick<TwilioMessage, "date_sent" | "date_created">): string {
  return isoDate(m.date_sent ?? m.date_created);
}

const page = (p: Partial<MessagePage> | null | undefined): MessagePage => ({ ...p, messages: p?.messages ?? [], next_page_uri: p?.next_page_uri ?? null });

const byDate = (a: TwilioMessage, b: TwilioMessage) => messageDate(a).localeCompare(messageDate(b));

export function messagesApi(call: Call, defaults: { from?: string; messagingServiceSid?: string }): MessagesApi {
  const query = (o: ListMessagesOptions) => ({
    To: o.to || undefined,
    From: o.from || undefined,
    "DateSent>": day(o.dateSentAfter),
    PageSize: pageSize(o.pageSize),
  });

  const list = async (o: ListMessagesOptions = {}) => page(await call<MessagePage>("GET", "/Messages.json", { query: query(o), signal: o.signal }));

  const listAll = async (o: ListAllMessagesOptions = {}) => {
    const maxPages = Math.max(1, Math.floor(o.maxPages ?? 5));
    let p = await list(o);
    const out = [...p.messages];
    for (let n = 1; p.next_page_uri && n < maxPages; n++) {
      p = page(await call<MessagePage>("GET", p.next_page_uri, { signal: o.signal }));
      out.push(...p.messages);
    }
    return out;
  };

  return {
    async send(input, options = {}) {
      const form: Record<string, string> = { To: input.to, Body: input.body };
      if (input.from || input.messagingServiceSid) {
        if (input.messagingServiceSid) form.MessagingServiceSid = input.messagingServiceSid;
        if (input.from) form.From = input.from;
      } else if (defaults.messagingServiceSid) form.MessagingServiceSid = defaults.messagingServiceSid;
      else if (defaults.from) form.From = defaults.from;
      return call<TwilioMessage>("POST", "/Messages.json", { form, signal: options.signal, retry: "rate_limit" });
    },

    list,
    listAll,

    async inbound(number, since, o = {}) {
      const all = await listAll({ to: number, dateSentAfter: since, pageSize: o.pageSize ?? 100, maxPages: o.maxPages ?? 5, signal: o.signal });
      return all
        .filter((m) => (m.direction ?? "").startsWith("inbound") && !(new Date(m.date_sent ?? m.date_created ?? "").getTime() < since.getTime()))
        .sort(byDate);
    },

    async thread(number, o = {}) {
      const n = number.trim();
      if (!n) return [];
      const size = o.pageSize ?? 100;
      const [inbound, outbound] = await Promise.all([list({ from: n, pageSize: size, signal: o.signal }), list({ to: n, pageSize: size, signal: o.signal })]);
      const seen = new Set<string>();
      return [...inbound.messages, ...outbound.messages].filter((m) => (seen.has(m.sid) ? false : (seen.add(m.sid), true))).sort(byDate);
    },
  };
}
