// @btkulka/resend-client: Resend's API for Ben's apps. An API key in; emails, domains, global
// contacts with an upsert by email, segments and their members, and broadcasts sent as drafts first.
// Built on @btkulka/http-kit. Browser-safe: no node:* imports, no Buffer.
// Source imports use .js extensions; no import.meta or top-level await (the CommonJS build needs neither).

export { createResendClient, RESEND_API_URL, USER_AGENT, type ResendClient, type ResendClientOptions } from "./client.js";
export { MAX_LIMIT, type CallOptions, type ListOptions, type ResendList } from "./call.js";
export {
  categoryOf,
  isResendError,
  ResendAuthError,
  ResendError,
  type ResendErrorCategory,
  type ResendErrorCode,
} from "./errors.js";
export {
  MAX_BATCH,
  type Email,
  type EmailAttachment,
  type EmailEvent,
  type EmailsApi,
  type EmailTag,
  type SendBatchOptions,
  type SendBatchResult,
  type SendEmailInput,
  type SendEmailOptions,
} from "./emails.js";
export {
  type CreateDomainInput,
  type Domain,
  type DomainCapabilities,
  type DomainRecord,
  type DomainRegion,
  type DomainsApi,
  type DomainStatus,
} from "./domains.js";
export {
  type Contact,
  type ContactsApi,
  type CreateContactInput,
  type ListContactsOptions,
  type UpdateContactInput,
  type UpsertContactResult,
} from "./contacts.js";
export { type Segment, type SegmentsApi } from "./segments.js";
export {
  type Broadcast,
  type BroadcastsApi,
  type BroadcastStatus,
  type BroadcastSummary,
  type CreateBroadcastInput,
  type SendBroadcastOptions,
  type UpdateBroadcastInput,
} from "./broadcasts.js";
export { createThrottle, DEFAULT_REQUESTS_PER_SECOND, type Throttle, type ThrottleOptions } from "./throttle.js";
export { mergeTag, RESEND_UNSUBSCRIBE_URL, type ContactField } from "./personalize.js";
export type { FetchLike, FetchLikeInit, FetchLikeResponse } from "@btkulka/http-kit";
