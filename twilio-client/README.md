# @btkulka/twilio-client

Twilio's REST API for Ben's apps: an Account SID with its Auth Token (or an API key and secret) in, and the calls they make:

- **texts**: send one (from a number or through a Messaging Service), list a page or several, the texts that came in to a number since an instant, and every text to and from one number;
- **calls**: list a page;
- **the account**: get it, which is also the cheap way to check the credentials;
- **webhooks**: make and check Twilio's `X-Twilio-Signature`.

The credentials are passed in; the package never reads env or `.env` (`twilioFromEnv` reads the map an app hands it). Nothing sends unless the app calls `messages.send`. It is built on [`@btkulka/http-kit`](../http-kit): a per-attempt timeout, the caller's `AbortSignal`, a 429 that waits out `Retry-After`, a 5xx or a dropped connection that backs off, and an abort or another 4xx never retried. A send retries only a 429: Twilio has no idempotency key, so after a timeout or a 5xx the text may already be on its way. Browser-safe: no `node:*` imports, no `Buffer` (Basic auth through http-kit's helper; the signature's SHA-1 and HMAC are written out in `src/signature.ts`). ESM and CommonJS builds.

```json
"dependencies": { "@btkulka/twilio-client": "file:../packages/twilio-client" }
```

Build it first (`npm run build` here, or in the packages home); apps load `dist/`. An Electron app bundles it into main like its other `@btkulka` packages (Orange Friction's `electron.vite.config.ts`).

**Icon: still to come.** Ben designs package icons with Claude Design, so there is no `icon.svg` yet; `benhaus.config.json` already points `logos.twilio-client` at `D:/source/packages/twilio-client/icon.svg` for when it lands.

## The credential, from Benhäus

`package.json` declares the credential (`benhaus.credential`), so Benhäus offers **Twilio** in Settings › Credentials › Add with these fields (each with its environment variable, which `TWILIO_ENV` lists too):

| Field | Env | |
|---|---|---|
| `accountSid` | `TWILIO_ACCOUNT_SID` | `AC…`, on the Twilio Console's home page |
| `authToken` | `TWILIO_AUTH_TOKEN` | secret; signs in, and checks webhook signatures |
| `apiKey` | `TWILIO_API_KEY` | optional, `SK…`; with `apiSecret` it signs in instead of the Auth Token |
| `apiSecret` | `TWILIO_API_SECRET` | optional, secret |
| `from` | `TWILIO_FROM` | the number texts go out from, E.164 |
| `messagingServiceSid` | `TWILIO_MESSAGING_SERVICE_SID` | optional, `MG…`; texts go through the service instead of the number |

Its Test is `GET https://api.twilio.com/2010-04-01/Accounts/{accountSid}.json` with Basic auth `accountSid:authToken` (200 means it works; a read costs nothing). It tests the Auth Token only, never the API key. Its hints name a refused sign-in (401) and an unknown SID (404).

An app reads it with [`@btkulka/benhaus-client`](../benhaus-client)'s `loadCredential`, which falls back to the environment when Benhäus is closed. The field names are the client's option names, so the fields go straight in:

```ts
import { loadCredential } from "@btkulka/benhaus-client";
import { createTwilioClient, TWILIO_ENV } from "@btkulka/twilio-client";

const cred = await loadCredential("twilio/<app>", { app: "<app>", env: TWILIO_ENV, required: ["accountSid"] });
const twilio = createTwilioClient({ ...cred?.fields, accountSid: cred?.fields.accountSid });
```

Neither app uses Benhäus for it yet: Honeycomber reads `.env` (`twilioFromEnv(process.env)`), Orange Friction keeps the token in its own settings, encrypted with `safeStorage`. Without credentials the client still makes; every call then throws `TwilioAuthError` without a request.

## API

```ts
import { createTwilioClient, isTwilioError, messageDate, validTwilioSignature } from "@btkulka/twilio-client";

const twilio = createTwilioClient({ accountSid, authToken, from: "+18885550100" });

await twilio.messages.send({ to: "+15125550111", body: "Hi from Honeycomber" });   // from the client's number

const texts = await twilio.messages.inbound("+18885550100", since);               // came in since `since`, oldest first
const thread = await twilio.messages.thread("+15125550111");                      // both ways, oldest first

try {
  await twilio.messages.send({ to, body });
} catch (err) {
  if (isTwilioError(err, 21610)) { /* they texted STOP */ }
}

// A webhook: the exact URL Twilio called and the POST fields.
if (!validTwilioSignature(authToken, url, fields, req.headers["x-twilio-signature"])) { /* 403 */ }
```

Twilio's own field names stay as Twilio writes them in what comes back (`date_sent`, `num_media`, `next_page_uri`), so its API reference reads straight across; this package's options are camelCase and become Twilio's parameters (`to` → `To`, `pageSize` → `PageSize`, `dateSentAfter` → `DateSent>`). Twilio's dates are RFC 2822 (`"Fri, 23 Oct 2026 15:00:00 +0000"`); `messageDate(m)` and `callDate(c)` give ISO 8601, or `""` when there's none.

`createTwilioClient(options)`

| Option | Default | |
|---|---|---|
| `accountSid` | required | Empty: every call throws `TwilioAuthError` without a request. |
| `authToken` | | Basic auth as `accountSid:authToken`, unless the API key and secret are both there. |
| `apiKey`, `apiSecret` | | Basic auth as `apiKey:apiSecret`. |
| `from` | | The sender when a send names none. |
| `messagingServiceSid` | | The sender when a send names none; used over `from`. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, headers?, text() }>`. |
| `baseUrl` | `https://api.twilio.com` | |
| `timeoutMs` | 20 000 | Per attempt. |
| `attempts` | 3 | In all, for a 429, a 5xx, a timeout or a dropped connection; a send counts only 429s. `1` turns retries off (Orange Friction, where a screen waits). |
| `baseDelayMs` | 1 000 | The first backoff wait, doubled each retry; a 429's `Retry-After` replaces it. |

Calls (every call takes `{ signal }`):

| Call | Twilio | |
|---|---|---|
| `messages.send({ to, body, from?, messagingServiceSid? })` | `POST /Messages.json` | With neither sender, the client's `messagingServiceSid`, else its `from`. Sends `To` and `Body` as given. Only a 429 is retried. |
| `messages.list({ to?, from?, dateSentAfter?, pageSize? })` | `GET /Messages.json` | One page, newest first. `dateSentAfter` is a day, on or after (a Date's UTC day, or `YYYY-MM-DD`). `pageSize` 1 to 1000; Twilio's default is 50. |
| `messages.listAll({ …list's, maxPages = 5 })` | | Follows `next_page_uri`, only on Twilio's own host. |
| `messages.inbound(number, since, { pageSize = 100, maxPages = 5 })` | | Texts sent to `number` on or after `since`'s UTC day, then only the inbound ones at or after `since`, oldest first. What Honeycomber polls. |
| `messages.thread(number, { pageSize = 100 })` | two `GET /Messages.json` | One page `From` and one `To` the number, read at once, each text once, oldest first. A blank number asks nothing and gives `[]`. |
| `calls.list({ pageSize? })` | `GET /Calls.json` | One page, newest first. |
| `account.get()` | `GET /Accounts/{sid}.json` | `friendly_name`, `status`, `type`. |

Paths are under `/2010-04-01/Accounts/{accountSid}`. Lists always come back with their array (`messages`, `calls`) and `next_page_uri` (null on the last page), even when Twilio leaves them out.

Helpers: `twilioFromEnv(env)` (the credential's fields from an environment map, trimmed, blanks left out), `twilioAuth(fields)` (the Basic-auth user and password they make, or undefined), `hasTwilioAuth(fields)`, `TWILIO_ENV`, `API_VERSION`, `TWILIO_API_URL`, `MAX_PAGE_SIZE`.

## Webhook signatures

`twilioSignature(authToken, url, fields)` is Twilio's `X-Twilio-Signature`: HMAC-SHA1 keyed with the Auth Token over the full URL Twilio called followed by each POST field's name and value, names sorted, in base64. `validTwilioSignature(authToken, url, fields, signature)` compares in constant time. Both are synchronous and match Twilio's documented example and node:crypto (the tests check every length around SHA-1's block edges). The URL must be the one Twilio called, exactly as configured (Honeycomber's `TWILIO_WEBHOOK_URL`); the package doesn't try the variants with and without a port, and doesn't handle JSON bodies (`bodySHA256`), since neither app takes those.

## Errors

Every failure is a `TwilioError` (an `HttpError` from http-kit, so `status`, `body`, `url`, `retryAfterMs` and `kind` are there). Its message is `Twilio <status>: <what Twilio said>` (or the first 200 characters of a body that isn't JSON), and it carries:

- `status`: the HTTP status, or 0 when no answer came (`kind` `timeout`, `network` or `aborted`) or there were no credentials;
- `code`: Twilio's error code, or null: 21610 the recipient texted STOP, 21211 an invalid To number, 21408 a region not enabled, 20003 a refused sign-in, 20429 too many requests;
- `twilioMessage` and `moreInfo`: Twilio's `message` and `more_info`, as it sent them.

A 401, or code 20003, and missing credentials are a `TwilioAuthError`. `isTwilioError(err, 21610)` checks the class and the code in one go.

## Left out

Only what Honeycomber and Orange Friction call is here. Not covered: number lookups (the Lookup API; neither app calls it; Honeycomber's `src/phone.ts` formats US numbers to E.164 locally), MMS media (`MediaUrl` on a send, the Media subresource; Orange Friction only reads `num_media`), getting, updating or deleting one message, making or changing calls, status callbacks, and the signature variants above.

## Working on it

`npm run build` here (or in the packages home); `npm test` runs `src/*.test.ts` against a fake `fetch` (`src/fake-fetch.test.ts`), so nothing talks to Twilio and nothing is ever sent. Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither).

## Consumers

- **Honeycomber** (`D:/source/honeycomber`, a Node service under tsx): `src/sms/twilio.ts` is its `.env` config (`twilioFromEnv`, `hasTwilioAuth`) and the `SmsTransport` the outbox and the poller use (`messages.send`, `messages.inbound`); `src/api.ts` checks the webhook with `validTwilioSignature`; `src/outbox.ts` reads `TwilioError`'s `code` (21610) and `status`.
- **Orange Friction** (`D:/source/orange-friction`, Electron): `src/main/twilio.ts` reads the SID and token from its settings and maps `messages.list`, `messages.thread`, `messages.send`, `calls.list` and `account.get` to its IPC shapes, with `attempts: 1` and its own wording for errors.
