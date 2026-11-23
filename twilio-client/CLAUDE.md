# twilio-client

A shared, browser-safe Twilio REST client for Ben's apps: texts, calls, the account and webhook signatures, with the credentials passed in, and a Benhäus credential adapter (`package.json` › `benhaus.credential`). README.md is the reference.

Built 2026-11-23 from the stub left on 2026-10-29 (an empty `src/` and the two tsconfigs). BPM lists it on its own (every folder in `D:/source/packages` with a package.json is a package there).

## Brief

What Ben asked for: a shared `@btkulka/twilio-client`, then Honeycomber and Orange Friction moved onto it, since each hand-rolled Twilio (`honeycomber/src/sms/twilio.ts`, `orange-friction/src/main/twilio.ts`). Built the way resend-client and notion-client are: dual ESM+CJS, http-kit its only dependency, browser-safe (no `node:*`, no `Buffer`), node:test tests against a fake fetch, a typed TwilioError, a credential adapter (accountSid, authToken and the rest the apps use). Only the calls the two apps make. Behaviour in both apps kept the same. Never send a real text or call a Twilio write endpoint to test.

## Build on the shared packages (BPM)

Ben's shared code lives in `D:/source/packages` (BPM in Benhäus; `benhaus list_packages` and `search_code` over MCP). This package depends on:

- `@btkulka/http-kit` — The fetch plumbing Ben's API clients share: FetchLike types and a default fetch, a typed HttpError, one request with a per-attempt timeout and AbortSignal that reads text first and parses JSON when it can, retries (429 waits Retry-After, 5xx and network errors back off, never an abort), an abortable sleep, UTF-8 safe base64, a Basic auth header and form encoding. Browser-safe: no node:* imports, no Buffer. No runtime dependencies.

Rules:

- Before writing anything that could be shared, look in BPM first and use the package. Link one that isn't here yet with `"@btkulka/<name>": "file:../<name>"` and `npm install` (one install at a time here: the `.npm-lock` folder).
- Keep it free of app paths, settings and secrets: the app passes them in. Nothing sends unless the app calls `messages.send`.
- Packages load from their `dist/`: run `npm run build` here after changing it.

## Icon

Still to come: Ben designs package icons with Claude Design. `benhaus.config.json` already has `logos.twilio-client` pointing at `D:/source/packages/twilio-client/icon.svg`.

## State

`src/client.ts` (the client on http-kit: Basic auth with the API key and secret over the Auth Token, a send retried only on a 429, `next_page_uri` followed only on Twilio's host, `account.get`), `src/errors.ts` (`TwilioError` with `status`, Twilio's `code`, `twilioMessage`, `moreInfo`; `TwilioAuthError`; `isTwilioError`), `src/call.ts` (paging, days, dates), `src/messages.ts` (`send`, `list`, `listAll`, `inbound`, `thread`, `messageDate`), `src/calls.ts` (`list`, `callDate`), `src/credential.ts` (`TWILIO_ENV`, `twilioFromEnv`, `twilioAuth`, `hasTwilioAuth`), `src/signature.ts` (SHA-1 and HMAC written out, so the check is synchronous and runs anywhere), tests beside each against `src/fake-fetch.test.ts` (34, all passing). Message format `Twilio <status>: <Twilio's message>` is Honeycomber's old one; Orange Friction rewords errors in its own `src/main/twilio.ts`.

Left out on purpose (neither app calls them): the Lookup API, MMS media, one message's get/update/delete, making calls, status callbacks, signature URL variants and `bodySHA256`. Neither app reads the Benhäus credential yet (Honeycomber reads `.env`, Orange Friction its encrypted settings).
