# @btkulka/benhaus-client

Call Benhäus, Ben's desktop hub, from any local app. The main use is sharing Benhäus's Google sign-ins: Benhäus holds each account's refresh token (encrypted with the Windows user's key), and an app asks Benhäus to search Gmail, read a thread, reply, or list calendar events instead of running its own OAuth. It also posts notifications to Benhäus's center, and reads the API keys and logins kept in Benhäus's Settings › Credentials, so apps stop keeping their own copies in .env files.

It finds Benhäus through `~/.benhaus/mcp.json`, the address and token Benhäus writes each time its local endpoint starts, and calls Benhäus's MCP tools over that endpoint with plain `fetch` (stateless JSON-RPC, no MCP SDK). When Benhäus restarts on a new port or token, the next call re-reads the file.

No runtime dependencies. ESM and CommonJS builds. Node 20.3+ (`AbortSignal.any`).

```json
"dependencies": { "@btkulka/benhaus-client": "file:../packages/benhaus-client" }
```

```ts
import { createBenhausClient, isBenhausError } from "@btkulka/benhaus-client";

const benhaus = createBenhausClient();

const { threads } = await benhaus.mail.search({ account: "info@example.com", query: "in:inbox newer_than:2d", limit: 25 });
const thread = await benhaus.mail.thread({ account: "info@example.com", threadId: threads[0].id });
await benhaus.mail.send({ account: "info@example.com", replyToThreadId: thread.id, body: "Thanks for reaching out!" });

// A calendar someone shared with the account, even free/busy only (titles come back as "Busy").
const { events } = await benhaus.calendar.events({ account: "info@example.com", calendarId: "dj@example.com", from: new Date("2027-06-12T05:00:00Z"), days: 1 });

await benhaus.notify({ title: "New inquiry from Jane & John", vertical: "nhi", kind: "needs", open: "tool:honeycomber" });

try { … } catch (e) {
  if (isBenhausError(e, "offline")) … // Benhäus is closed
  if (isBenhausError(e, "tool") && e.needs === "signin") … // the Google account needs signing in again
}
```

## API

### `createBenhausClient(options?)`

| Option | Default | What it does |
|---|---|---|
| `discoveryFile` | `~/.benhaus/mcp.json` | Where Benhäus writes its address and token. |
| `discover` | reads `discoveryFile` | A stand-in returning `{ url, port, token }`, for tests. |
| `timeoutMs` | `30000` | Per call. Each call also takes `{ timeoutMs, signal }`. |
| `fetch` | global `fetch` | A stand-in, for tests. |

The client:

- `mail.search({ query, account?, limit? })`: Gmail's own search syntax, newest threads first, up to 50. Returns `{ threads, errors }`, one error per account that failed.
- `mail.thread({ account, threadId })`: every message's `from`, `to`, `cc`, raw `date` and plain `text` (HTML flattened, cut at 12,000 characters) and attachment names. Reading doesn't mark it read.
- `mail.send({ account?, to?, cc?, bcc?, subject?, body, replyToThreadId?, replyAll?, draft? })`: plain text. A reply goes to the thread's last message from someone else (its Reply-To first) with `In-Reply-To` and `References`, and its subject defaults to "Re: " the thread's. Returns `{ sent, account, message_id, thread_id, to, subject, url }`.
- `mail.modify({ account, threadIds, action })`: `archive`, `inbox`, `read`, `unread`, `star`, `unstar`, `trash` or `untrash`.
- `calendar.events({ from?, to?, days?, account?, calendarId?, query?, includeHidden? })`: events between two instants. `from`/`to` take a `Date` or ISO text. `calendarId` reads any calendar the account can see, including one shared as free/busy only, without subscribing.
- `google.accounts({ refresh? })`: Settings › Accounts › Google: the signed-in accounts, what each allowed (calendar, mail), their calendars, and any that need signing in again.
- `notify({ title, detail?, vertical?, kind?, open? })`: `kind` is `needs`, `failed` or `info`; `open` is what its button opens (`tool:<id>`, `about:<id>`, `vertical:<id>`, a https link…).
- `health()`: `GET /health` (no token). `undefined` when Benhäus isn't answering; never throws.
- `call(name, args?)`: any other Benhäus tool, its JSON text parsed (text that isn't JSON comes back as a string). `callTool(name, args?)` is the raw form: `{ text, isError, content }`, and a tool's own error doesn't throw.
- `credentials.get(id, { app? })`: one credential's values, `{ id, fields, updatedAt }`, or `undefined` when Benhäus doesn't have it. `app` (your tool id) shows on its "Read by" line in Benhäus.
- `credentials.env({ app })`: `{ env, missing }`, the variables Benhäus injects into that tool when it starts it.
- `credentials.list()`, `credentials.set(input)`: list_credentials and set_credential. Neither returns a secret field's value.
- `discovery()`: the address and token in use.

Argument names are camelCase here and mapped to Benhäus's snake_case; unset fields aren't sent. Results keep Benhäus's own field names (`thread_id`, `message_id`).

### Credentials

Benhäus keeps credentials encrypted with the Windows user's key. A credential has fields (`accountSid`, `authToken`); each field can name the environment variable it fills, and a credential lists the tools it's injected into. Benhäus sets those variables itself when it starts a tool's service or launches it, so an app started by Benhäus needs no code for this: it reads `process.env` as before. A service's `env` in `benhaus.config.json` can also say `"credential:<id>#<field>"` instead of the value.

Two helpers for apps that run without Benhäus starting them, or want a credential by name:

```ts
import { applyBenhausEnv, loadCredential } from "@btkulka/benhaus-client";

// First thing in main: what Benhäus would have injected (a .env or the shell still wins; never throws when Benhäus is closed).
await applyBenhausEnv({ app: "orson" });

// One credential, with the environment as the fallback for a closed Benhäus or a field it lacks.
const tw = await loadCredential("twilio/honeycomber", {
  app: "honeycomber",
  env: { accountSid: "TWILIO_ACCOUNT_SID", authToken: "TWILIO_AUTH_TOKEN", from: "TWILIO_FROM" },
  required: ["accountSid", "authToken"],
});
```

`loadCredential` returns `{ id, fields, source, updatedAt? }` (`source` is `benhaus`, `env` or `both`) or `undefined` when a required field is missing. Both helpers wait 3 s at most for Benhäus and only throw for a real failure inside it.

Values travel over the endpoint's own `/credentials/read` and `/credentials/env` routes, behind the same token, never through an MCP tool, so they stay out of Claude's chats. That keeps them out of transcripts and screenshots, not out of reach of other programs running as Ben.

### Errors

Everything throws `BenhausError` with a `kind`:

| `kind` | Meaning |
|---|---|
| `offline` | No discovery file, or nothing answered at its address (tried twice, re-reading the file). |
| `unauthorized` | The token was refused, after re-reading the file once. |
| `http` | Another non-2xx answer (`status`). |
| `protocol` | A 2xx answer that isn't a tool result. |
| `tool` | The tool reported an error; the message is its text. `needs` is `signin` or `connect` when it says a Google account must be signed in again or added. |
| `timeout`, `aborted` | The time limit ran out, or the caller's signal fired. |

`isBenhausError(e, kind?)` narrows to it.

## Notes

- Benhäus's endpoint takes local, non-browser callers only (no `Origin` header, a loopback `Host`), so this works from Node servers and scripts, not from a web page. A page goes through its own server.
- The shapes in `types.ts` follow Benhäus's `src/main/google.ts` and `mcp/tools.ts`. When a tool's output changes there, change it here.
- Which Google account an app reads is the app's setting; Benhäus may have several signed in.
- `credentials.*` needs a Benhäus with Settings › Credentials (Oct 29 2026 or later). An older one answers 404, which the helpers treat as closed.

## Used by

- honeycomber: Gmail intake and replies for the Intuitive Sounds inquiry inbox, DJs' shared calendars for availability, and notifications.

## Developing

```
npm run build       # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test            # builds, then node --test
```
