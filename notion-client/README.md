# @btkulka/notion-client

Notion's API for Ben's apps: an internal integration's secret in, and the calls they make:

- **who the integration is** (`GET /v1/users/me`): its name and the workspace it lives in, which is how Benhäus's Settings › Accounts › Notion shows "Connected to Ben's Notion";
- **search** over everything shared with it, one page or every page up to a limit;
- **pages and databases**: a page, a database and its schema, a database's rows (one page or all), creating a page, changing one, appending blocks;
- **blocks as text**: a page's block tree down to a depth, and `blocksToText` turns it into plain, markdown-leaning text (headings, lists counted, to-dos, quotes, code, tables), the shape Claude reads;
- **ids**: `parseNotionId` takes a dashed or undashed id, a notion.so page or database address (view, peek and block tails ignored) or a `notion://` link.

The token is passed in; the package never reads env or `.env`. It is built on [`@btkulka/http-kit`](../http-kit): a per-attempt timeout, the caller's `AbortSignal`, a 429 that waits out `Retry-After` (Notion allows about three requests a second), a 5xx or a dropped connection that backs off, and an abort or another 4xx never retried. Browser-safe: no `node:*` imports, no `Buffer`. ESM and CommonJS builds.

```json
"dependencies": { "@btkulka/notion-client": "file:../packages/notion-client" }
```

Build it first (`npm run build` here, or in the packages home); apps load `dist/`.

## Setting Notion up, once per workspace

An integration is how Notion lets a program in. At [notion.so/profile/integrations](https://www.notion.so/profile/integrations) make a **new internal integration** in the workspace (its name is what pages show as the connection), copy its **Internal Integration Secret** (`ntn_…`), and give it the capabilities it needs (read content; write if the app writes). Then share each page or database the app may read **with the integration**: the page's `···` menu › Connections › the integration's name. A page shared with it brings its sub-pages along. Everything else is invisible to the token (`object_not_found`).

## API

```ts
import { createNotionClient, notShared, parseNotionId, summaryOf, propertiesText, blocksToText } from "@btkulka/notion-client";

const notion = createNotionClient({ token: process.env.NOTION_TOKEN });

const me = await notion.me();                         // me.name, me.bot?.workspace_name
const hits = await notion.searchAll({ query: "habits", kind: "database" }, 20);
hits.map(summaryOf);                                  // { id, kind, title, url, icon, lastEdited, parent }

const page = await notion.page("https://www.notion.so/ben/Reading-list-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d");
propertiesText(page);                                 // { Name: "Reading list", Status: "Open", … }
await notion.pageText(page.id);                       // "# Title\n- a bullet\n  its child\n- [x] done"

const db = await notion.database(dbId);               // db.properties: the schema
const rows = await notion.queryAll(dbId, { filter: { property: "Done", checkbox: { equals: false } }, sorts: [{ property: "Due", direction: "ascending" }] });

await notion.createPage({ parent: { database_id: dbId }, properties: { Name: { title: [{ text: { content: "New" } }] } } });
await notion.updatePage(pageId, { properties: { Done: { checkbox: true } } });
await notion.appendBlocks(pageId, [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "Hi" } }] } }]);
await notion.request("GET", "/users");                // anything else under /v1
```

`createNotionClient(options)`

| Option | Default | |
|---|---|---|
| `token` | required | The internal integration's secret. Empty: every call throws `NotionAuthError` (code `missing_token`) without a request, so a client can be made before the app knows whether it's configured. |
| `fetch` | global `fetch` | `(url, init) => Promise<{ ok, status, headers?, text() }>`. |
| `baseUrl` | `https://api.notion.com` | |
| `version` | `2022-06-28` | The `Notion-Version` header. |
| `timeoutMs` | 15 000 | Per attempt. |
| `attempts` | 3 | In all, for a 429, a 5xx, a timeout or a dropped connection. |
| `baseDelayMs` | 1 000 | The first backoff wait, doubled each retry; a 429's `Retry-After` replaces it. |

Calls (every `idOrUrl` takes an id or a notion.so address; every call takes `{ signal }`):

| Call | Notion | |
|---|---|---|
| `me()` | `GET /users/me` | The integration's user; `bot.workspace_name` is its workspace. |
| `search({ query?, kind?, sort?, pageSize?, cursor? })` | `POST /search` | One page. `kind` is `"page"` or `"database"`; `sort` is by last edit. |
| `searchAll(options?, limit = 100)` | | Follows cursors. |
| `page(idOrUrl)` | `GET /pages/{id}` | |
| `database(idOrUrl)` | `GET /databases/{id}` | The schema is `properties`. |
| `queryDatabase(idOrUrl, { filter?, sorts?, pageSize?, cursor? })` | `POST /databases/{id}/query` | One page of rows, Notion's filter and sort objects as they are. |
| `queryAll(idOrUrl, options?, limit = 1000)` | | Follows cursors. |
| `blockChildren(idOrUrl, { pageSize?, cursor? })` | `GET /blocks/{id}/children` | One page of direct children. |
| `blocks(idOrUrl, { depth = 4, limit = 2000 })` | | The tree: each block that has children gets `children`, down to `depth`. Child pages and databases are listed, never entered. Stops at `limit` blocks. |
| `pageText(idOrUrl, options?)` | | `blocksToText(await blocks(…))`. |
| `createPage(input)` | `POST /pages` | |
| `updatePage(idOrUrl, patch)` | `PATCH /pages/{id}` | Properties, `archived`, icon, cover. |
| `appendBlocks(idOrUrl, children)` | `PATCH /blocks/{id}/children` | |
| `request(method, path, body?)` | anything under `/v1` | |

Text helpers, all pure: `plainText(richText)`, `titleOf(pageOrDatabase)`, `iconOf(icon)`, `summaryOf(pageOrDatabase)`, `propertyText(value)` (selects by name, dates as `start – end`, checkboxes Yes/No, people by name, relations by id, formulas and rollups by their result), `propertiesText(page)` (every set property, by name), `schemaText(definition)` and `databaseSchema(database)` (types, with a select's options), `blockText(block)` and `blocksToText(blocks)`. Ids: `parseNotionId(idOrUrl)`, `dashed(id)`, `undashed(id)`, `notionUrl(id)`.

## Errors

Every failure is a `NotionError` (an `HttpError` from http-kit, so `status`, `body`, `url`, `retryAfterMs` and `kind` are there) with `code`: Notion's own (`unauthorized`, `restricted_resource`, `object_not_found`, `rate_limited`, `validation_error`, `conflict_error`, `internal_server_error`, `service_unavailable`…) or this package's when no answer came (`missing_token`, `timeout`, `network`, `aborted`). A missing or rejected token (401) is a `NotionAuthError`. `notShared(err)` is true for `object_not_found` and `restricted_resource`: the page doesn't exist, wasn't shared with the integration, or the integration lacks the capability, which is nearly always the first thing to check.

## Working on it

`npm run build` here (or in the packages home), `npm test` runs `src/*.test.ts` against a fake `fetch`; nothing talks to Notion. Source imports use `.js` extensions; no `import.meta` or top-level `await` (the CommonJS build needs neither). Benhäus (`src/main/notion.ts`) is the first consumer: Settings › Accounts › Notion checks the token with `me()`, and its `search_notion` and `read_notion` MCP tools read Ben's own workspace for Claude.
