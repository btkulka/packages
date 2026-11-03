# @btkulka/resend-client

Resend's API for Ben's apps: an API key in, and the calls they make:

- **emails**: send one (with an `Idempotency-Key`), send a batch of up to 100, get one by id;
- **domains**: add one, list them, get one with its DNS records and status, ask Resend to verify it;
- **contacts**, global now that Resend replaced Audiences with Segments: create, get by id or email, update, delete, list (every contact or one segment's, by cursor), and `upsert`, which creates or updates by email so a sync can run again and again;
- **segments**: create, list, get, delete, and add a contact to one or remove it;
- **broadcasts**: create a draft for a segment, get, list, update, send now or at `scheduled_at`, delete;
- **helpers**: `RESEND_UNSUBSCRIBE_URL` (`{{{RESEND_UNSUBSCRIBE_URL}}}`), `mergeTag("first_name", "there")` (`{{{contact.first_name|there}}}`), and a throttle that spaces requests (2 a second unless told otherwise) so a bulk contact sync stays under Resend's rate limit.

The key is passed in; the package never reads env or `.env`. Nothing sends unless the app calls `emails.send`, `emails.batch` or `broadcasts.send`: `broadcasts.create` only ever makes a draft. It is built on [`@btkulka/http-kit`](../http-kit): a per-attempt timeout, the caller's `AbortSignal`, a 429 that waits out `Retry-After`, a 5xx or a dropped connection that backs off, and an abort or another 4xx never retried. Browser-safe: no `node:*` imports, no `Buffer`. ESM and CommonJS builds.

```json
"dependencies": { "@btkulka/resend-client": "file:../packages/resend-client" }
```

Build it first (`npm run build` here, or in the packages home); apps load `dist/`.

## The key, from Benhäus Credentials

Keep the key in Benhäus (Settings › Credentials) and read it with [`@btkulka/benhaus-client`](../benhaus-client)'s `loadCredential`, which falls back to the environment when Benhäus is closed. For the NHI list the credential is `resend/nhi`, field `apiKey`, env `RESEND_API_KEY`:

```ts
import { loadCredential } from "@btkulka/benhaus-client";
import { createResendClient } from "@btkulka/resend-client";

const cred = await loadCredential("resend/nhi", { app: "nhi-dash", env: { apiKey: "RESEND_API_KEY" }, required: ["apiKey"] });
const resend = createResendClient({ apiKey: cred?.fields.apiKey });
```

Without a key the client still makes; every call then throws `ResendAuthError` (code `missing_api_key`) without a request, so the app can say "Resend isn't set up" instead of crashing at start. The key needs **full access**: a "sending access" key can only send emails, and Resend rejects contacts, segments and broadcasts with it (`restricted_api_key`).

## Setting Resend up, once

1. **API key**: [resend.com/api-keys](https://resend.com/api-keys) › Create API key, full access. Save it in Benhäus as above.
2. **Domain**: `domains.create({ name: "nhi-dj.com" })` returns the DNS records (`records`: DKIM and SPF, MX and TXT on `send`); add them at the DNS host, then `domains.verify(id)` and read `domains.get(id).status` until it's `verified`. The dashboard does the same. Until then Resend refuses mail from the domain (403 `validation_error`).
3. **Segment**: `segments.create({ name: "NHI fans" })` once; keep its id. Contacts are global; a segment is the list a broadcast goes to.

Unsubscribes need nothing from the app: put `RESEND_UNSUBSCRIBE_URL` in each broadcast's footer and Resend's hosted page handles the click and marks the contact `unsubscribed`, which no broadcast reaches again. `contacts.upsert` never sets `unsubscribed` back on an existing contact, so a re-sync can't undo it.

## API

```ts
import { createResendClient, mergeTag, RESEND_UNSUBSCRIBE_URL, isResendError } from "@btkulka/resend-client";

const resend = createResendClient({ apiKey });

// A sync: create or update each fan and put them in the segment. Spaced at 2 a second by the throttle.
for (const fan of fans) {
  await resend.contacts.upsert({ email: fan.email, first_name: fan.firstName, segments: [FANS] });
}

// A broadcast: a draft first, sent when the app says.
const { id } = await resend.broadcasts.create({
  segment_id: FANS,
  from: "NHI <news@nhi-dj.com>",
  subject: "New flip out Friday",
  html: `<p>Hi ${mergeTag("first_name", "there")},</p> … <a href="${RESEND_UNSUBSCRIBE_URL}">Unsubscribe</a>`,
});
await resend.broadcasts.send(id, { scheduled_at: "2026-11-06T15:00:00Z" });   // or no scheduled_at: now

// One email, safe to repeat under the same key for 24 hours.
await resend.emails.send({ from: "NHI <hello@nhi-dj.com>", to: "ben@nhi-dj.com", subject: "Test", text: "Hi" }, { idempotencyKey: "test/1" });

try {
  await resend.contacts.get("nobody@x.com");
} catch (err) {
  if (isResendError(err, "not_found")) { /* … */ }
}
```

Resend's own field names stay as Resend writes them (`first_name`, `segment_id`, `reply_to`, `scheduled_at`), so its API reference reads straight across; this package's options are camelCase (`signal`, `idempotencyKey`, `validation`). Timestamps come back the way Resend writes them, with a space: `"2026-10-06 23:47:56.678+00"`.

`createResendClient(options)`

| Option | Default | |
|---|---|---|
| `apiKey` | required | Empty: every call throws `ResendAuthError` (code `missing_api_key`) without a request. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, headers?, text() }>`. |
| `baseUrl` | `https://api.resend.com` | |
| `userAgent` | `btkulka-resend-client/0.1.0` | Resend refuses a request without one (403). |
| `timeoutMs` | 15 000 | Per attempt. Waiting for a throttle slot doesn't count. |
| `attempts` | 3 | In all, for a 429, a 5xx, a timeout or a dropped connection. |
| `baseDelayMs` | 1 000 | The first backoff wait, doubled each retry; a 429's `Retry-After` replaces it. |
| `requestsPerSecond` | 2 | This client's throttle. `Infinity` turns it off. |
| `throttle` | its own | A `createThrottle()` shared with other clients on the same Resend team, so they share the rate. |

Calls (every call takes `{ signal }`; every list takes `{ limit, after, before }`, `limit` 1 to 100, cursors by id, one of `after` and `before`):

| Call | Resend | |
|---|---|---|
| `emails.send(input, { idempotencyKey? })` | `POST /emails` | `from`, `to` (up to 50), `subject`, `html`/`text`, `cc`, `bcc`, `reply_to`, `headers`, `attachments` (Base64 `content` or a URL `path`), `tags`, `scheduled_at` (a Date, ISO 8601 or "in 1 hour"; up to 30 days), `topic_id`. Without a key the client makes one per call, so its own retries can't send twice. |
| `emails.batch(inputs, { idempotencyKey?, validation? })` | `POST /emails/batch` | 1 to 100, refused before any request otherwise; no attachments. `validation: "permissive"` sends the good ones and lists the rest in `errors` by index. |
| `emails.get(id)` | `GET /emails/{id}` | With `last_event` (`delivered`, `bounced`, `opened`…). |
| `domains.create({ name, region?, custom_return_path?, open_tracking?, click_tracking?, tracking_subdomain?, tls?, capabilities? })` | `POST /domains` | The domain and its `records`. |
| `domains.list()` | `GET /domains` | |
| `domains.get(id)` | `GET /domains/{id}` | `status` (`not_started`, `pending`, `verified`, `partially_verified`, `failed`, `temporary_failure`…) and `records`, each with its own status. |
| `domains.verify(id)` | `POST /domains/{id}/verify` | Starts a check; read the outcome with `get`. |
| `contacts.create({ email, first_name?, last_name?, unsubscribed?, properties?, segments? })` | `POST /contacts` | `segments` as ids or `{ id }`. |
| `contacts.get(idOrEmail)` | `GET /contacts/{id or email}` | |
| `contacts.update(idOrEmail, { first_name?, last_name?, unsubscribed?, properties? })` | `PATCH /contacts/{id or email}` | null clears a field. Segments change through `segments.addContact`/`removeContact`. |
| `contacts.delete(idOrEmail)` | `DELETE /contacts/{id or email}` | |
| `contacts.list({ segment_id?, limit?, after?, before? })` | `GET /contacts`, or `GET /segments/{id}/contacts` | One page. Left without `limit`, the full list returns 20 and a segment's returns all. |
| `contacts.listAll(options?, limit = 10000)` | | Follows `after` cursors, 100 a page. |
| `contacts.upsert(input)` | | Gets the contact by email; creates it (in `segments`) when it's missing; otherwise patches `first_name`, `last_name` and `properties` that differ and adds it to the `segments` it isn't in. Never touches an existing contact's `unsubscribed`. `{ id, created, updated, addedTo }`. |
| `segments.create({ name })` | `POST /segments` | |
| `segments.list()` | `GET /segments` | |
| `segments.get(id)` | `GET /segments/{id}` | |
| `segments.delete(id)` | `DELETE /segments/{id}` | The contacts stay. |
| `segments.addContact(segmentId, contactIdOrEmail)` | `POST /contacts/{contact}/segments/{segment}` | |
| `segments.removeContact(segmentId, contactIdOrEmail)` | `DELETE /contacts/{contact}/segments/{segment}` | |
| `broadcasts.create({ segment_id, from, subject, reply_to?, html?, text?, name?, preview_text?, topic_id? })` | `POST /broadcasts` | Always a draft: only these fields are sent, never Resend's `send` or `scheduled_at`. |
| `broadcasts.get(id)` | `GET /broadcasts/{id}` | `status`: `draft`, `scheduled`, `queued`, `sent`, `canceled`. |
| `broadcasts.list()` | `GET /broadcasts` | Summaries: no from, subject or body. |
| `broadcasts.update(id, patch)` | `PATCH /broadcasts/{id}` | A draft's fields. |
| `broadcasts.send(id, { scheduled_at? })` | `POST /broadcasts/{id}/send` | Now, or at a Date, ISO 8601 or "in 1 hour". Only a 429 is retried: after a timeout or a 5xx the broadcast may have gone out, so check `get` before sending again. |
| `broadcasts.delete(id)` | `DELETE /broadcasts/{id}` | A draft, or a scheduled one (which cancels it); not once queued or sent. |

Paths take a contact's email as it is (`@` and `+` kept), escaping only what would break the path.

## Personalizing a broadcast

`mergeTag(field, fallback?)` builds `{{{contact.<field>|<fallback>}}}`, which Resend fills per recipient: `first_name`, `last_name`, `email`, or a custom property's key (letters, digits and `_`, up to 50). The fallback is what a contact without the field gets; it can't hold `|`, `{` or `}`. `RESEND_UNSUBSCRIBE_URL` is the per-recipient link to Resend's unsubscribe page.

## The throttle

Every request takes a slot from the client's throttle before it starts, retries included, and the wait comes before the attempt's timeout, so a queue of 500 upserts never times out while it waits. The default, 2 requests a second, is Ben's choice for a sync: Resend's documented limit is 10 a second, but it's per team, shared by every key and app on it. Pass `requestsPerSecond` to change it, or one `createThrottle({ requestsPerSecond })` as `throttle` to several clients so they share it. `throttle.run(fn)` and `throttle.wait(signal)` work outside a client too.

## Errors

Every failure is a `ResendError` (an `HttpError` from http-kit, so `status`, `body`, `url`, `retryAfterMs` and `kind` are there). `status` is Resend's `statusCode`, `code` its error `name` (`validation_error`, `missing_required_field`, `rate_limit_exceeded`, `daily_quota_exceeded`…; the error's own `name` stays `ResendError`) or this package's when no answer came (`timeout`, `network`, `aborted`), and `category` is what to do about it:

| `category` | When | |
|---|---|---|
| `auth` | 401; `restricted_api_key`, `suspended_api_key`, `invalid_permission`; a `validation_error` about the API key | A `ResendAuthError`. Fix the key. Never retried. |
| `validation` | Any other 4xx: a bad field, an unverified domain (403), an `Idempotency-Key` reused with another body (409); and a request this package refuses before sending (a batch over 100, an empty id) | Fix the request. Not retried. |
| `not_found` | 404 | No such email, domain, contact, segment or broadcast. |
| `rate_limit` | 429 | `rate_limit_exceeded` is retried (waiting out `Retry-After`); `daily_quota_exceeded` and `monthly_quota_exceeded` aren't, since nothing changes until the quota resets. |
| `other` | 5xx, a timeout, a dropped connection, an abort | Retried, except an abort. |

`isResendError(err, "not_found")` checks the class and the category in one go. Two 409s are retried as Resend asks: `concurrent_idempotent_requests` (the same key still running) and `resource_locked`.

## Working on it

`npm run build` here (or in the packages home), `npm test` runs `src/*.test.ts` against a fake `fetch` (`src/fake-fetch.test.ts`); nothing talks to Resend. The throttle tests run on real timers, so they take a couple of seconds. Every path and body was checked against [resend.com/docs/api-reference](https://resend.com/docs/api-reference) and Resend's own Node SDK (2026-11-02); the SDK settled the names the docs pages leave out (`segment_id`, `reply_to`, `topic_id` and `preview_text` on broadcasts, `custom_return_path` and the tracking fields on domains, `properties` as a plain map, `x-batch-validation`). Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither).

## First consumer: nhi-dash

nhi-dash (`D:/source/nhi-dashboard`, CommonJS) uses it for the NHI fan list, sent as broadcasts from nhi-dj.com. nhi-dash is local and can't host an unsubscribe page, which is why every broadcast carries `RESEND_UNSUBSCRIBE_URL` and Resend's hosted page does the work. To wire it:

1. `package.json`: `"@btkulka/resend-client": "file:../packages/resend-client"` and `"@btkulka/benhaus-client": "file:../packages/benhaus-client"`, then `npm install`.
2. Add the credential `resend/nhi` (field `apiKey`, a full-access key) in Benhäus Settings › Credentials, or `RESEND_API_KEY` in the environment. Load it as in "The key" above (`require` works too) and make one client for the app.
3. Verify nhi-dj.com (`domains.create`, the DNS records, `domains.verify`) and make the `NHI fans` segment once; store its id in nhi-dash's settings.
4. Sync fans with `contacts.upsert({ email, first_name, segments: [fansId] })`. It's idempotent and leaves unsubscribes alone, so it can run on every change; the throttle keeps it at 2 a second.
5. A release mail is `broadcasts.create` (a draft nhi-dash can show and edit with `update`), then `broadcasts.send` when Ben says, now or `scheduled_at` a release's Friday. Every body carries `RESEND_UNSUBSCRIBE_URL`; greet with `mergeTag("first_name", "there")`.
