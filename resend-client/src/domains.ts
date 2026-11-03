// Domains: add one, list them, get one with its DNS records and status, ask Resend to verify it.

import { type Call, type CallOptions, type ListOptions, type ResendList, listQuery, seg } from "./call.js";

export type DomainRegion = "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";

/**
 * `not_started` (added, never verified), `pending` (Resend is checking), `verified`, `partially_verified`
 * (one capability or record still pending), `partially_failed`, `failed` (records not found within 72 hours),
 * `temporary_failure` (was verified, a record went missing; rechecked for 72 hours).
 */
export type DomainStatus = "not_started" | "pending" | "verified" | "partially_verified" | "partially_failed" | "failed" | "temporary_failure" | (string & {});

export interface DomainCapabilities {
  sending: "enabled" | "disabled";
  receiving: "enabled" | "disabled";
}

/** One DNS record to add at the domain's DNS host. */
export interface DomainRecord {
  /** What it's for: `DKIM`, `SPF`, `Tracking`… */
  record: string;
  /** The host: `resend._domainkey`, `send`… */
  name: string;
  /** `TXT`, `MX`, `CNAME`. */
  type: string;
  value: string;
  /** `"Auto"` in Resend's examples. */
  ttl: string;
  status: DomainStatus;
  /** MX only. */
  priority?: number;
}

export interface Domain {
  object?: "domain";
  id: string;
  name: string;
  status: DomainStatus;
  created_at: string;
  region: DomainRegion;
  open_tracking?: boolean;
  click_tracking?: boolean;
  tracking_subdomain?: string | null;
  capabilities?: DomainCapabilities;
  /** On create and get; not in a list. */
  records?: DomainRecord[];
}

export interface CreateDomainInput {
  /** `nhi-dj.com`, or a subdomain to send from. */
  name: string;
  /** Default us-east-1. */
  region?: DomainRegion;
  /** The return-path subdomain. Default `send` (send.nhi-dj.com). */
  custom_return_path?: string;
  open_tracking?: boolean;
  click_tracking?: boolean;
  /** `"links"` tracks through links.nhi-dj.com. */
  tracking_subdomain?: string;
  /** Default opportunistic. */
  tls?: "opportunistic" | "enforced";
  /** At least one enabled. Default sending on, receiving off. */
  capabilities?: Partial<DomainCapabilities>;
}

export interface DomainsApi {
  /** POST /domains: the domain and the records to add. */
  create(input: CreateDomainInput, options?: CallOptions): Promise<Domain>;
  /** GET /domains. */
  list(options?: ListOptions): Promise<ResendList<Domain>>;
  /** GET /domains/{id}: with its records and their status. */
  get(id: string, options?: CallOptions): Promise<Domain>;
  /** POST /domains/{id}/verify: starts a check; read the outcome later with `get`. */
  verify(id: string, options?: CallOptions): Promise<{ object: "domain"; id: string }>;
}

export function domainsApi(call: Call): DomainsApi {
  return {
    create: (input, o = {}) => call<Domain>("POST", "/domains", { body: input, signal: o.signal }),
    list: async (o = {}) => call<ResendList<Domain>>("GET", "/domains", { query: listQuery(o), signal: o.signal }),
    get: async (id, o) => call<Domain>("GET", `/domains/${seg(id, "domain id")}`, o),
    verify: async (id, o) => call<{ object: "domain"; id: string }>("POST", `/domains/${seg(id, "domain id")}/verify`, o),
  };
}
