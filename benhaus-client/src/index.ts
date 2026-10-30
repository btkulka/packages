// @btkulka/benhaus-client: call Benhäus (Ben's desktop hub) from any local app, and share its Google sign-ins.

export { createBenhausClient, type BenhausClient, type BenhausClientOptions, type CallOptions, type ToolCallResult } from "./client.js";
export { readDiscovery, defaultDiscoveryFile, type BenhausDiscovery } from "./discovery.js";
export { BenhausError, isBenhausError, type BenhausErrorKind } from "./errors.js";
export { loadCredential, applyBenhausEnv, type LoadCredentialOptions, type LoadedCredential, type ApplyEnvOptions, type ApplyEnvResult } from "./credentials.js";
export type {
  BenhausHealth,
  BenhausVertical,
  CalendarEvent,
  CalendarEventsInput,
  CalendarEventsResult,
  CredentialEnvResult,
  CredentialSummary,
  CredentialsList,
  CredentialValues,
  GoogleAccountEntry,
  GoogleAccountsResult,
  GoogleCalendarEntry,
  MailAction,
  MailMessage,
  MailSearchResult,
  MailThreadDetail,
  MailThreadSummary,
  ModifyMailResult,
  NotifyInput,
  SendMailInput,
  SendMailResult,
  SetCredentialInput,
} from "./types.js";
