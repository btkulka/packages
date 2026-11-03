// Segments: the lists broadcasts go to (Resend's replacement for Audiences). Contacts are global;
// a segment is a named set of them, joined and left through the contact's own path.

import { type Call, type CallOptions, type ListOptions, type ResendList, listQuery, seg } from "./call.js";

export interface Segment {
  object?: "segment";
  id: string;
  name: string;
  created_at?: string;
}

export interface SegmentsApi {
  /** POST /segments. */
  create(input: { name: string }, options?: CallOptions): Promise<{ object: "segment"; id: string; name: string }>;
  /** GET /segments. */
  list(options?: ListOptions): Promise<ResendList<Segment>>;
  /** GET /segments/{id}. */
  get(id: string, options?: CallOptions): Promise<Segment>;
  /** DELETE /segments/{id}. The contacts stay; only the segment goes. */
  delete(id: string, options?: CallOptions): Promise<{ object: "segment"; id: string; deleted: boolean }>;
  /** POST /contacts/{contact}/segments/{id}: the contact by id or email. */
  addContact(segmentId: string, contactIdOrEmail: string, options?: CallOptions): Promise<{ id: string }>;
  /** DELETE /contacts/{contact}/segments/{id}: the contact by id or email. The contact itself stays. */
  removeContact(segmentId: string, contactIdOrEmail: string, options?: CallOptions): Promise<{ object: "contact_segment"; id: string; deleted: boolean }>;
}

/** The membership path: `/contacts/{contact}/segments/{segment}`. */
export const membership = (contact: string, segmentId: string) => `/contacts/${seg(contact, "contact id or email")}/segments/${seg(segmentId, "segment id")}`;

export function segmentsApi(call: Call): SegmentsApi {
  return {
    create: (input, o = {}) => call("POST", "/segments", { body: { name: input.name }, signal: o.signal }),
    list: async (o = {}) => call<ResendList<Segment>>("GET", "/segments", { query: listQuery(o), signal: o.signal }),
    get: async (id, o) => call<Segment>("GET", `/segments/${seg(id, "segment id")}`, o),
    delete: async (id, o) => call("DELETE", `/segments/${seg(id, "segment id")}`, o),
    addContact: async (segmentId, contact, o) => call("POST", membership(contact, segmentId), o),
    removeContact: async (segmentId, contact, o) => call("DELETE", membership(contact, segmentId), o),
  };
}
