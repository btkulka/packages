// The shapes Benhäus's tools return (benhaus src/main/google.ts and mcp/tools.ts), in its own field names.

export type BenhausVertical = "haus" | "gt" | "fm" | "delphi" | "nhi" | "personal" | "ai" | "games" | "utilities" | "adult" | "artifacts";

/* ---------------------------------------------------------------- google */

export interface GoogleCalendarEntry {
  id: string;
  name: string;
  color?: string;
  primary?: boolean;
  /** owner, writer, reader or freeBusyReader. */
  access?: string;
  show?: boolean;
}

export interface GoogleAccountEntry {
  email: string;
  name?: string;
  access: { calendar: boolean; mail: boolean };
  calendars: GoogleCalendarEntry[];
  /** Its inbox shows on Home's Mail panel. */
  mail?: boolean;
  needsSignIn?: boolean;
  addedAt?: string;
}

export interface GoogleAccountsResult {
  /** The OAuth client is set. */
  client: boolean;
  accounts: GoogleAccountEntry[];
  icals: { id: string; name: string; show: boolean }[];
  signingIn?: boolean;
}

/* ------------------------------------------------------------------ mail */

export interface MailThreadSummary {
  account: string;
  id: string;
  /** The last message's sender, as a name. */
  from: string;
  subject: string;
  snippet: string;
  /** The last message's time, ISO. */
  date: string;
  unread: boolean;
  messages: number;
  url: string;
}

export interface MailSearchResult {
  threads: MailThreadSummary[];
  errors: { account: string; error: string }[];
}

export interface MailMessage {
  id: string;
  /** Raw header: "Sam Lee" <sam@x.com>. */
  from: string;
  to: string;
  cc?: string;
  /** Raw Date header. */
  date: string;
  unread?: boolean;
  /** Plain text (the HTML part flattened when there is no text part), cut at 12,000 characters. */
  text: string;
  attachments?: { name: string; size?: number }[];
}

export interface MailThreadDetail {
  account: string;
  id: string;
  subject: string;
  url: string;
  labels: string[];
  messages: MailMessage[];
}

export interface SendMailInput {
  /** Which account sends it. Required when more than one is connected. */
  account?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** A reply defaults to "Re: " the thread's subject. */
  subject?: string;
  /** Plain text. */
  body: string;
  /** Reply in this thread: to its last message from someone else (Reply-To first), with In-Reply-To and References. */
  replyToThreadId?: string;
  replyAll?: boolean;
  /** Save a draft instead of sending. */
  draft?: boolean;
}

export interface SendMailResult {
  sent?: boolean;
  drafted?: boolean;
  account: string;
  message_id?: string;
  draft_id?: string;
  thread_id: string;
  to: string;
  cc?: string;
  subject: string;
  url: string;
}

export type MailAction = "archive" | "inbox" | "read" | "unread" | "star" | "unstar" | "trash" | "untrash";

export interface ModifyMailResult {
  account: string;
  action: MailAction;
  done: string[];
  failed: { id: string; error: string }[];
}

/* -------------------------------------------------------------- calendar */

export interface CalendarEvent {
  id: string;
  /** "Busy" when the calendar is shared as free/busy only. */
  title: string;
  /** ISO instants; an all-day event starts at local midnight. */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  account?: string;
  calendarId: string;
  calendar?: string;
  color?: string;
  url?: string;
  response?: "accepted" | "tentative" | "declined" | "needsAction";
  description?: string;
  meet?: string;
  organizer?: string;
  attendees?: { email: string; name?: string; response?: string; organizer?: boolean }[];
  recurring?: boolean;
}

export interface CalendarEventsInput {
  /** Start: a Date or an ISO date or time. Benhäus defaults to the start of today. */
  from?: Date | string;
  to?: Date | string;
  /** Days from `from` when `to` isn't given. */
  days?: number;
  account?: string;
  /** Any Google calendar id the account can read, even one not in its list (free/busy sharing is enough), or ical:<id>. */
  calendarId?: string;
  query?: string;
  /** Also calendars switched off for Home. */
  includeHidden?: boolean;
}

export interface CalendarEventsResult {
  from: string;
  to: string;
  events: CalendarEvent[];
  errors?: { calendar?: string; account?: string; error: string }[];
}

/* --------------------------------------------------------- notifications */

export interface NotifyInput {
  /** One line, in words Ben reads. */
  title: string;
  detail?: string;
  /** Default haus (Home). */
  vertical?: BenhausVertical;
  /** needs (waiting on Ben), failed (something broke) or info. */
  kind?: "needs" | "failed" | "info";
  /** What its button opens: "tool:<id>", "about:<id>", "vertical:<id>", "home", "services", a https:// link… */
  open?: string;
}

/* ---------------------------------------------------------------- health */

export interface BenhausHealth {
  ok: boolean;
  app?: string;
  version?: string;
  pid?: number;
}

/* ------------------------------------------------------- Settings › Credentials */

/** One credential's values, as an app reads them (credentials.get). */
export interface CredentialValues {
  id: string;
  fields: Record<string, string>;
  updatedAt: string;
}

/** The variables Benhäus injects into a tool (credentials.env): what its service would get at start. */
export interface CredentialEnvResult {
  env: Record<string, string>;
  /** References Benhäus couldn't fill, in words. */
  missing: string[];
}

/** A credential as list_credentials shows it: secret fields carry no value. */
export interface CredentialSummary {
  id: string;
  label?: string;
  service: string;
  note?: string;
  owner?: string;
  fields: { name: string; secret: boolean; env?: string; value?: string }[];
  inject: string[];
  createdAt: string;
  updatedAt: string;
  usedBy: { app: string; at: string; via: "app" | "env" }[];
  references: { tool: string; env: string; field: string; ok: boolean }[];
}

export interface CredentialsList {
  encrypted: boolean;
  credentials: CredentialSummary[];
  hidden: number;
  missing: { tool: string; env: string; field: string; ok: boolean; credential: string }[];
  file?: string;
}

export interface SetCredentialInput {
  id: string;
  label?: string;
  service?: string;
  note?: string;
  owner?: string;
  /** null removes a field. */
  fields?: Record<string, string | null>;
  secret?: Record<string, boolean>;
  env?: Record<string, string | null>;
  inject?: string[];
}
