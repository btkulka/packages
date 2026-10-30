import { type BenhausDiscovery, defaultDiscoveryFile, readDiscovery } from "./discovery.js";
import { BenhausError, needsFrom } from "./errors.js";
import type {
  BenhausHealth,
  CalendarEventsInput,
  CalendarEventsResult,
  CredentialEnvResult,
  CredentialSummary,
  CredentialsList,
  CredentialValues,
  GoogleAccountsResult,
  MailAction,
  MailSearchResult,
  MailThreadDetail,
  ModifyMailResult,
  NotifyInput,
  SendMailInput,
  SendMailResult,
  SetCredentialInput,
} from "./types.js";

export interface BenhausClientOptions {
  /** Where Benhäus writes its address and token. Default ~/.benhaus/mcp.json. */
  discoveryFile?: string;
  /** A stand-in for reading the discovery file (tests, or an app that knows the address another way). */
  discover?: () => BenhausDiscovery | undefined;
  /** Default time limit per call, ms. Default 30 s. */
  timeoutMs?: number;
  /** A stand-in for global fetch. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolCallResult {
  /** The text parts, joined. */
  text: string;
  isError: boolean;
  content: { type: string; text?: string; [k: string]: unknown }[];
}

export interface BenhausClient {
  /** The address and token in use (re-read from the file when a call finds Benhäus moved). */
  discovery(): BenhausDiscovery | undefined;
  /** GET /health. Undefined when Benhäus isn't answering. Never throws. */
  health(opts?: CallOptions): Promise<BenhausHealth | undefined>;
  /** Any Benhäus tool, raw. Throws only for transport problems, not for a tool's own error. */
  callTool(name: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<ToolCallResult>;
  /** Any Benhäus tool, its text parsed as JSON (or the text itself when it isn't JSON). A tool error throws `tool`. */
  call<T = unknown>(name: string, args?: Record<string, unknown>, opts?: CallOptions): Promise<T>;

  google: {
    /** Settings › Accounts › Google. */
    accounts(o?: { refresh?: boolean }, opts?: CallOptions): Promise<GoogleAccountsResult>;
  };
  mail: {
    /** Gmail search syntax, newest threads first (limit up to 50). */
    search(o: { query: string; account?: string; limit?: number }, opts?: CallOptions): Promise<MailSearchResult>;
    /** Every message's headers and text. Reading doesn't mark it read. */
    thread(o: { account: string; threadId: string }, opts?: CallOptions): Promise<MailThreadDetail>;
    send(o: SendMailInput, opts?: CallOptions): Promise<SendMailResult>;
    modify(o: { account: string; threadIds: string[]; action: MailAction }, opts?: CallOptions): Promise<ModifyMailResult>;
  };
  calendar: {
    events(o?: CalendarEventsInput, opts?: CallOptions): Promise<CalendarEventsResult>;
  };
  /** A notification in Benhäus's center (and on the desktop, per Ben's rules). */
  notify(o: NotifyInput, opts?: CallOptions): Promise<unknown>;

  /**
   * Settings › Credentials. get and env return values, over the endpoint's /credentials routes (never an MCP
   * tool); list and set go through list_credentials and set_credential and never return secret values.
   */
  credentials: {
    /** One credential's values, or undefined when Benhäus doesn't have it. `app` (your tool id) shows on its Read by line. */
    get(id: string, o?: { app?: string }, opts?: CallOptions): Promise<CredentialValues | undefined>;
    /** The variables Benhäus injects into `app` (a tool id) when it starts it. */
    env(o: { app: string }, opts?: CallOptions): Promise<CredentialEnvResult>;
    list(opts?: CallOptions): Promise<CredentialsList>;
    set(o: SetCredentialInput, opts?: CallOptions): Promise<CredentialSummary>;
  };
}

const iso = (v?: Date | string) => (v instanceof Date ? v.toISOString() : v);

/** Drops undefined values so Benhäus's argument checks see only what was given. */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function createBenhausClient(options: BenhausClientOptions = {}): BenhausClient {
  const file = options.discoveryFile ?? defaultDiscoveryFile();
  const discover = options.discover ?? (() => readDiscovery(file));
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs ?? 30_000;
  let current: BenhausDiscovery | undefined;
  let nextId = 1;

  const locate = (fresh = false) => {
    if (fresh || !current) current = discover();
    return current;
  };

  async function request(d: BenhausDiscovery, name: string, args: Record<string, unknown>, opts: CallOptions): Promise<Response> {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? defaultTimeout)];
    if (opts.signal) signals.push(opts.signal);
    return doFetch(d.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${d.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.any(signals),
    });
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<ToolCallResult> {
    let res: Response | undefined;
    // Two tries: the second re-reads the discovery file, for a Benhäus that restarted on a new port or token.
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = locate(attempt > 0);
      if (!d) throw new BenhausError("offline", `Benhäus isn't running (no ${file}).`, { tool: name });
      try {
        res = await request(d, name, args, opts);
      } catch (e) {
        if (opts.signal?.aborted) throw new BenhausError("aborted", `Benhäus call ${name} was cancelled.`, { tool: name, cause: e });
        if ((e as Error)?.name === "TimeoutError") throw new BenhausError("timeout", `Benhäus took too long to answer ${name}.`, { tool: name, cause: e });
        if (attempt === 0) continue;
        throw new BenhausError("offline", `Benhäus isn't answering at ${d.url}.`, { tool: name, cause: e });
      }
      if (res.status === 401 && attempt === 0) continue;
      break;
    }
    if (!res) throw new BenhausError("offline", "Benhäus isn't answering.", { tool: name });
    const raw = await res.text();
    if (res.status === 401) throw new BenhausError("unauthorized", "Benhäus refused the token.", { status: 401, tool: name });
    if (!res.ok) throw new BenhausError("http", `Benhäus answered ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, tool: name });
    let body: { result?: { content?: ToolCallResult["content"]; isError?: boolean }; error?: { message?: string } };
    try {
      body = JSON.parse(sseData(raw));
    } catch {
      throw new BenhausError("protocol", `Benhäus answered ${name} with something that isn't JSON.`, { tool: name });
    }
    if (body.error) throw new BenhausError("protocol", body.error.message ?? `Benhäus rejected ${name}.`, { tool: name });
    const content = body.result?.content;
    if (!Array.isArray(content)) throw new BenhausError("protocol", `Benhäus answered ${name} without a tool result.`, { tool: name });
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    return { text, isError: Boolean(body.result?.isError), content };
  }

  async function call<T>(name: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const r = await callTool(name, args, opts);
    if (r.isError) throw new BenhausError("tool", r.text || `${name} failed.`, { tool: name, needs: needsFrom(r.text) });
    try {
      return JSON.parse(r.text) as T;
    } catch {
      return r.text as T;
    }
  }

  /** POST JSON to one of the endpoint's own routes (beside /mcp), with the token. 404 is undefined. */
  async function post<T>(route: string, body: Record<string, unknown>, opts: CallOptions = {}): Promise<T | undefined> {
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = locate(attempt > 0);
      if (!d) throw new BenhausError("offline", `Benhäus isn't running (no ${file}).`, { tool: route });
      const signals = [AbortSignal.timeout(opts.timeoutMs ?? defaultTimeout)];
      if (opts.signal) signals.push(opts.signal);
      try {
        res = await doFetch(new URL(route, d.url), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${d.token}` },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
      } catch (e) {
        if (opts.signal?.aborted) throw new BenhausError("aborted", `Benhäus call ${route} was cancelled.`, { tool: route, cause: e });
        if ((e as Error)?.name === "TimeoutError") throw new BenhausError("timeout", `Benhäus took too long to answer ${route}.`, { tool: route, cause: e });
        if (attempt === 0) continue;
        throw new BenhausError("offline", `Benhäus isn't answering at ${d.url}.`, { tool: route, cause: e });
      }
      if (res.status === 401 && attempt === 0) continue;
      break;
    }
    if (!res) throw new BenhausError("offline", "Benhäus isn't answering.", { tool: route });
    const raw = await res.text();
    if (res.status === 401) throw new BenhausError("unauthorized", "Benhäus refused the token.", { status: 401, tool: route });
    // An older Benhäus without the route answers 404 "not found"; a missing credential is 404 "missing".
    if (res.status === 404) {
      if (/"missing"/.test(raw)) return undefined;
      throw new BenhausError("http", `This Benhäus has no ${route} (update it).`, { status: 404, tool: route });
    }
    if (!res.ok) throw new BenhausError("http", `Benhäus answered ${res.status}: ${raw.slice(0, 300)}`, { status: res.status, tool: route });
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BenhausError("protocol", `Benhäus answered ${route} with something that isn't JSON.`, { tool: route });
    }
  }

  async function health(opts: CallOptions = {}): Promise<BenhausHealth | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = locate(attempt > 0);
      if (!d) return undefined;
      try {
        const res = await doFetch(new URL("/health", d.url), { signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
        if (res.ok) return (await res.json()) as BenhausHealth;
      } catch {
        /* try the file again */
      }
    }
    return undefined;
  }

  return {
    discovery: () => locate(),
    health,
    callTool,
    call,
    google: {
      accounts: (o = {}, opts) => call<GoogleAccountsResult>("list_google_accounts", clean({ refresh: o.refresh }), opts),
    },
    mail: {
      search: (o, opts) => call<MailSearchResult>("search_mail", clean({ query: o.query, account: o.account, limit: o.limit }), opts),
      thread: (o, opts) => call<MailThreadDetail>("get_mail_thread", { account: o.account, thread_id: o.threadId }, opts),
      send: (o, opts) =>
        call<SendMailResult>(
          "send_mail",
          clean({
            account: o.account,
            to: o.to,
            cc: o.cc,
            bcc: o.bcc,
            subject: o.subject,
            body: o.body,
            reply_to_thread_id: o.replyToThreadId,
            reply_all: o.replyAll,
            draft: o.draft,
          }),
          opts,
        ),
      modify: (o, opts) => call<ModifyMailResult>("modify_mail", { account: o.account, thread_ids: o.threadIds, action: o.action }, opts),
    },
    calendar: {
      events: (o = {}, opts) =>
        call<CalendarEventsResult>(
          "list_events",
          clean({
            from: iso(o.from),
            to: iso(o.to),
            days: o.days,
            account: o.account,
            calendar_id: o.calendarId,
            query: o.query,
            include_hidden: o.includeHidden,
          }),
          opts,
        ),
    },
    notify: (o, opts) => call("post_notification", clean({ ...o }), opts),
    credentials: {
      get: (id, o = {}, opts) => post<CredentialValues>("/credentials/read", clean({ id, app: o.app }), opts),
      env: async (o, opts) => (await post<CredentialEnvResult>("/credentials/env", { app: o.app }, opts)) ?? { env: {}, missing: [] },
      list: (opts) => call<CredentialsList>("list_credentials", {}, opts),
      set: (o, opts) => call<CredentialSummary>("set_credential", clean({ ...o }), opts),
    },
  };
}

/** A Streamable HTTP answer is JSON, or (if the server ever streams) SSE frames: take the last data line. */
function sseData(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("{")) return t;
  const lines = t.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  return lines.length ? lines[lines.length - 1].slice(5).trim() : t;
}
