// Contacts: global now that Resend replaced Audiences with Segments. Each is addressed by id or by
// email. `upsert` makes a sync idempotent: it creates the contact, or brings an existing one up to
// date and into its segments, and never re-subscribes someone who unsubscribed.

import { type Call, type CallOptions, type ListOptions, type ResendList, MAX_LIMIT, listQuery, seg } from "./call.js";
import { invalid, isResendError } from "./errors.js";
import { type Segment, membership } from "./segments.js";

export interface Contact {
  object?: "contact";
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  /** True: the contact gets no broadcasts at all (Resend's hosted unsubscribe page sets it). */
  unsubscribed: boolean;
  /** Custom properties, on get: `{ city: { value: "Austin", type: "string" } }`. */
  properties?: Record<string, { value: unknown; type?: string }>;
}

export interface CreateContactInput {
  email: string;
  first_name?: string;
  last_name?: string;
  /** True: no broadcasts at all. Default false. */
  unsubscribed?: boolean;
  /** Custom properties (defined in Resend first), by key. */
  properties?: Record<string, string | number | null>;
  /** Segments to join: ids, or `{ id }` as Resend takes them. */
  segments?: Array<string | { id: string }>;
}

export interface UpdateContactInput {
  /** null clears it. */
  first_name?: string | null;
  last_name?: string | null;
  unsubscribed?: boolean;
  /** Only the keys given change; null clears one. */
  properties?: Record<string, string | number | boolean | null>;
}

export interface ListContactsOptions extends ListOptions {
  /** Only this segment's contacts (GET /segments/{id}/contacts). Left out: every contact. */
  segment_id?: string;
}

export interface UpsertContactResult {
  id: string;
  /** No contact had the email, so one was made. */
  created: boolean;
  /** An existing contact's names or properties changed. */
  updated: boolean;
  /** Segments it was added to: all of `segments` for a new contact, only the missing ones for an existing one. */
  addedTo: string[];
}

export interface ContactsApi {
  /** POST /contacts. */
  create(input: CreateContactInput, options?: CallOptions): Promise<{ object: "contact"; id: string }>;
  /** GET /contacts/{id or email}. */
  get(idOrEmail: string, options?: CallOptions): Promise<Contact>;
  /** PATCH /contacts/{id or email}. Segments change through `segments.addContact` and `removeContact`. */
  update(idOrEmail: string, patch: UpdateContactInput, options?: CallOptions): Promise<{ object: "contact"; id: string }>;
  /** DELETE /contacts/{id or email}. */
  delete(idOrEmail: string, options?: CallOptions): Promise<{ object: "contact"; contact: string; deleted: boolean }>;
  /** GET /contacts, or GET /segments/{id}/contacts with `segment_id`: one page. */
  list(options?: ListContactsOptions): Promise<ResendList<Contact>>;
  /** Every contact (of a segment, with `segment_id`) up to `limit` (default 10 000), 100 a page. */
  listAll(options?: ListContactsOptions, limit?: number): Promise<Contact[]>;
  /**
   * Creates the contact, or updates the one with that email: first_name, last_name and properties
   * when they differ, then adds it to any of `segments` it isn't in. An existing contact's
   * `unsubscribed` is never touched (they may have left on Resend's unsubscribe page); change that
   * with `update` on purpose. Two to three requests for an existing contact, two for a new one.
   */
  upsert(input: CreateContactInput, options?: CallOptions): Promise<UpsertContactResult>;
}

const segmentIds = (s: CreateContactInput["segments"]) => (s ?? []).map((x) => (typeof x === "string" ? x : x.id)).filter(Boolean);

/** A property value as Resend stores it against one an app sends: "3" and 3 are the same. */
const same = (a: unknown, b: unknown) => a === b || (a != null && b != null && String(a) === String(b));

export function contactsApi(call: Call): ContactsApi {
  const path = (idOrEmail: string) => `/contacts/${seg(idOrEmail, "contact id or email")}`;

  const create = (input: CreateContactInput, o: CallOptions = {}) => {
    const segments = input.segments === undefined ? undefined : segmentIds(input.segments).map((id) => ({ id }));
    return call<{ object: "contact"; id: string }>("POST", "/contacts", { body: { ...input, segments }, signal: o.signal });
  };
  const get = async (idOrEmail: string, o?: CallOptions) => call<Contact>("GET", path(idOrEmail), o);
  const update = async (idOrEmail: string, patch: UpdateContactInput, o: CallOptions = {}) =>
    call<{ object: "contact"; id: string }>("PATCH", path(idOrEmail), { body: patch, signal: o.signal });
  const list = async (o: ListContactsOptions = {}) =>
    call<ResendList<Contact>>("GET", o.segment_id ? `/segments/${seg(o.segment_id, "segment id")}/contacts` : "/contacts", { query: listQuery(o), signal: o.signal });

  async function listAll(o: ListContactsOptions = {}, limit = 10_000): Promise<Contact[]> {
    const out: Contact[] = [];
    let after = o.after;
    while (out.length < limit) {
      const page = await list({ ...o, after, before: undefined, limit: o.limit ?? MAX_LIMIT });
      out.push(...page.data);
      const last = page.data[page.data.length - 1];
      if (!page.has_more || !last) break;
      after = last.id;
    }
    return out.length > limit ? out.slice(0, limit) : out;
  }

  async function upsert(input: CreateContactInput, o: CallOptions = {}): Promise<UpsertContactResult> {
    const email = (input.email ?? "").trim();
    if (!email) throw invalid("A contact needs an email.");
    const segments = segmentIds(input.segments);
    let found: Contact | undefined;
    try {
      found = await get(email, o);
    } catch (err) {
      if (!isResendError(err, "not_found")) throw err;
    }
    if (!found) {
      const made = await create({ ...input, email }, o);
      return { id: made.id, created: true, updated: false, addedTo: segments };
    }

    const existing = found;
    const patch: UpdateContactInput = {};
    if (input.first_name !== undefined && input.first_name !== existing.first_name) patch.first_name = input.first_name;
    if (input.last_name !== undefined && input.last_name !== existing.last_name) patch.last_name = input.last_name;
    const changed = Object.entries(input.properties ?? {}).filter(([k, v]) => !same(existing.properties?.[k]?.value ?? null, v));
    if (changed.length) patch.properties = Object.fromEntries(changed);
    const updated = Object.keys(patch).length > 0;
    if (updated) await update(existing.id, patch, o);

    const addedTo: string[] = [];
    if (segments.length) {
      const have = new Set((await call<ResendList<Segment>>("GET", `${path(existing.id)}/segments`, { signal: o.signal })).data.map((s) => s.id));
      for (const id of segments) {
        if (have.has(id)) continue;
        await call("POST", membership(existing.id, id), { signal: o.signal });
        addedTo.push(id);
      }
    }
    return { id: existing.id, created: false, updated, addedTo };
  }

  return {
    create,
    get,
    update,
    delete: async (idOrEmail, o) => call("DELETE", path(idOrEmail), o),
    list,
    listAll,
    upsert,
  };
}
