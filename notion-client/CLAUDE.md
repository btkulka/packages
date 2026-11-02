# notion-client

A Notion API client for Ben's apps: token in, search, pages, databases, blocks to text, built on http-kit

Started 2026-11-01 from Benhäus's New app screen; this file is the brief. BPM lists it on its own (every folder in `D:/source/packages` with a package.json is a package there).

## Brief
What Ben asked for:
> A Notion API client for Ben's apps: token in, search, pages, databases, blocks to text, built on http-kit
Decisions from the interview:

- What kind of thing is it? → package
- Where does it live? → personal

## Build on the shared packages (BPM)
Ben's shared code lives in `D:/source/packages` (BPM in Benhäus; `benhaus list_packages` and `search_code` over MCP). This package depends on:
- `@btkulka/http-kit` — The fetch plumbing Ben's API clients share: FetchLike types and a default fetch, a typed HttpError, one request with a per-attempt timeout and AbortSignal that reads text first and parses JSON when it can, retries (429 waits Retry-After, 5xx and network errors back off, never an abort), an abortable sleep, UTF-8 safe base64, a Basic auth header and form encoding. Browser-safe: no node:* imports, no Buffer. No runtime dependencies.
Rules:
- Before writing anything that could be shared (processes and ports, SQLite, LLM calls, media, MCP plumbing, Electron scaffolding, API clients), look in BPM first and use the package. Link one that isn't here yet with `"@btkulka/<name>": "file:../<name>"` and `npm install`.
- When something here turns out to be reusable, make it a package in `D:/source/packages` (the dual ESM+CJS layout the others have, an `icon.svg` in the Benhäus app-icon style designed with Claude Design) and depend on it here. Delete the copy it replaces in the same change.
- Packages load from their `dist/`: run `npm run build` in `D:/source/packages` after changing one.
## Icon
`icon.svg` is a page with a folded corner on the Benhäus app-icon plate, tinted for the personal vertical; BPM draws it. Review it with Claude Design (the Benhäus design system's app-icon style) when the package icons get their next pass.
## State
Built 2026-11-01 (the same day): `src/client.ts` (the client on http-kit, `NotionError`/`NotionAuthError`, `notShared`), `src/text.ts` (titles, properties, schema and blocks as text), `src/ids.ts` (ids from notion.so addresses), `src/types.ts`, tests beside each against a fake fetch. README.md is the reference. First consumer: Benhäus (`src/main/notion.ts`: Settings › Accounts › Notion, the `search_notion` and `read_notion` MCP tools). The Godspeed Talent Notion work (Task Sync, FM Internal) goes through Claude's own Notion connector, not this package.