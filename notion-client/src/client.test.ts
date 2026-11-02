import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotionClient, NotionAuthError, NotionError, notShared, type FetchLike, type FetchLikeInit } from "./index.js";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Replies in order; the last reply repeats. */
function fake(replies: Reply[]) {
  const calls: { url: string; init: FetchLikeInit }[] = [];
  let i = 0;
  const fetch: FetchLike = (url, init = {}) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) return Promise.reject(r);
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const text = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
      text: async () => text,
    });
  };
  return { fetch, calls };
}

const client = (f: FetchLike, extra: Partial<Parameters<typeof createNotionClient>[0]> = {}) => createNotionClient({ token: "ntn_test", fetch: f, baseDelayMs: 0, ...extra });
const body = (c: { init: FetchLikeInit }) => JSON.parse(c.init.body ?? "{}") as Record<string, unknown>;

const PAGE = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const PAGE_ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const B1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1";
const B2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2";
const list = (results: unknown[], next?: string) => ({ status: 200, body: { object: "list", results, has_more: Boolean(next), next_cursor: next ?? null } });
const rt = (s: string) => [{ type: "text", plain_text: s }];

test("me sends the token and the version and parses the integration's user", async () => {
  const { fetch, calls } = fake([
    { status: 200, body: { object: "user", id: "u", type: "bot", name: "Benhäus", bot: { owner: { type: "workspace", workspace: true }, workspace_name: "Ben's Notion" } } },
  ]);
  const me = await client(fetch).me();
  assert.equal(me.name, "Benhäus");
  assert.equal(me.bot?.workspace_name, "Ben's Notion");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.notion.com/v1/users/me");
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.headers?.Authorization, "Bearer ntn_test");
  assert.equal(calls[0]!.init.headers?.["Notion-Version"], "2022-06-28");
  assert.equal(calls[0]!.init.body, undefined);
});

test("no token: NotionAuthError before any request", async () => {
  const { fetch, calls } = fake([{ status: 200, body: {} }]);
  await assert.rejects(createNotionClient({ token: "  ", fetch }).me(), (e: unknown) => e instanceof NotionAuthError && e.code === "missing_token" && e.status === 0);
  assert.equal(calls.length, 0);
});

test("401: NotionAuthError with Notion's code and message, never retried", async () => {
  const { fetch, calls } = fake([{ status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." } }]);
  const err = await client(fetch).me().catch((e: unknown) => e);
  assert.ok(err instanceof NotionAuthError);
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthorized");
  assert.match(err.message, /Notion GET \/users\/me failed \(401 unauthorized\): API token is invalid\./);
  assert.equal(calls.length, 1);
});

test("429 waits out Retry-After and tries again", async () => {
  const { fetch, calls } = fake([
    { status: 429, headers: { "Retry-After": "0" }, body: { object: "error", status: 429, code: "rate_limited", message: "Rate limited" } },
    { status: 200, body: { object: "user", id: "u" } },
  ]);
  const me = await client(fetch).me();
  assert.equal(me.id, "u");
  assert.equal(calls.length, 2);
});

test("a 400 is thrown once, with the code", async () => {
  const { fetch, calls } = fake([{ status: 400, body: { object: "error", status: 400, code: "validation_error", message: "body failed validation" } }]);
  const err = await client(fetch).search({ query: "x" }).catch((e: unknown) => e);
  assert.ok(err instanceof NotionError && !(err instanceof NotionAuthError));
  assert.equal(err.code, "validation_error");
  assert.equal(calls.length, 1);
});

test("404 object_not_found reads as not shared", async () => {
  const { fetch } = fake([{ status: 404, body: { object: "error", status: 404, code: "object_not_found", message: "Could not find page with ID: …" } }]);
  const err = await client(fetch).page(PAGE).catch((e: unknown) => e);
  assert.ok(err instanceof NotionError && !(err instanceof NotionAuthError));
  assert.equal(err.code, "object_not_found");
  assert.ok(notShared(err));
  assert.ok(!notShared(new Error("x")));
});

test("a dropped connection becomes a NotionError of kind network once the attempts run out", async () => {
  const { fetch, calls } = fake([new Error("socket hang up")]);
  const err = await client(fetch, { attempts: 2 }).me().catch((e: unknown) => e);
  assert.ok(err instanceof NotionError);
  assert.equal(err.kind, "network");
  assert.equal(err.code, "network");
  assert.equal(err.status, 0);
  assert.equal(calls.length, 2);
});

test("page takes a notion.so address and calls the dashed id", async () => {
  const { fetch, calls } = fake([{ status: 200, body: { object: "page", id: PAGE_ID, properties: {} } }]);
  const page = await client(fetch).page(`https://www.notion.so/ben/Reading-list-${PAGE}?pvs=4`);
  assert.equal(page.id, PAGE_ID);
  assert.equal(calls[0]!.url, `https://api.notion.com/v1/pages/${PAGE_ID}`);
});

test("something that isn't an id fails before any request", async () => {
  const { fetch, calls } = fake([{ status: 200, body: {} }]);
  await assert.rejects(client(fetch).page("not an id"), (e: unknown) => e instanceof NotionError && e.code === "validation_error");
  assert.equal(calls.length, 0);
});

test("search posts the filter and sort; searchAll follows cursors up to the limit", async () => {
  const page = (n: number, next?: string) => list([{ object: "page", id: `p${n}` }, { object: "page", id: `q${n}` }], next);
  const { fetch, calls } = fake([page(1, "c1"), page(2, "c2"), page(3)]);
  const all = await client(fetch).searchAll({ query: "notes", kind: "page", sort: "descending" }, 5);
  assert.equal(all.length, 5);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, "https://api.notion.com/v1/search");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers?.["Content-Type"], "application/json");
  const first = body(calls[0]!);
  assert.equal(first.query, "notes");
  assert.deepEqual(first.filter, { property: "object", value: "page" });
  assert.deepEqual(first.sort, { direction: "descending", timestamp: "last_edited_time" });
  assert.equal(first.page_size, 100);
  assert.equal(first.start_cursor, undefined);
  assert.equal(body(calls[1]!).start_cursor, "c1");
  assert.equal(body(calls[2]!).start_cursor, "c2");
});

test("an empty search sends neither query nor filter", async () => {
  const { fetch, calls } = fake([list([])]);
  await client(fetch).search();
  assert.deepEqual(body(calls[0]!), {});
});

test("queryDatabase sends the filter, sorts and a clamped page size", async () => {
  const { fetch, calls } = fake([list([{ object: "page", id: "r1" }])]);
  const filter = { property: "Done", checkbox: { equals: false } };
  const sorts = [{ property: "Due", direction: "ascending" }];
  const rows = await client(fetch).queryDatabase(PAGE, { filter, sorts, pageSize: 500 });
  assert.equal(rows.results.length, 1);
  assert.equal(calls[0]!.url, `https://api.notion.com/v1/databases/${PAGE_ID}/query`);
  assert.deepEqual(body(calls[0]!), { filter, sorts, page_size: 100 });
});

test("blocks reads the tree, never enters child pages, and pageText renders it", async () => {
  const { fetch, calls } = fake([
    list([
      { object: "block", id: B1, type: "heading_1", has_children: false, heading_1: { rich_text: rt("Title") } },
      { object: "block", id: B2, type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: rt("Parent") } },
      { object: "block", id: "cp", type: "child_page", has_children: true, child_page: { title: "Sub page" } },
      { object: "block", id: "td", type: "to_do", has_children: false, to_do: { rich_text: rt("Done"), checked: true } },
    ]),
    list([{ object: "block", id: "c", type: "paragraph", has_children: false, paragraph: { rich_text: rt("Child") } }]),
  ]);
  const text = await client(fetch).pageText(PAGE);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `https://api.notion.com/v1/blocks/${PAGE_ID}/children?page_size=100`);
  assert.equal(calls[1]!.url, `https://api.notion.com/v1/blocks/${B2}/children?page_size=100`);
  assert.equal(text, "# Title\n- Parent\n  Child\n[Page] Sub page\n- [x] Done");
});

test("blocks stops at depth and at the block limit", async () => {
  const deep = (id: string, more: boolean) => list([{ object: "block", id, type: "toggle", has_children: more, toggle: { rich_text: rt(id) } }]);
  const { fetch, calls } = fake([deep(B1, true), deep(B2, true), deep("x", true)]);
  const tree = await client(fetch).blocks(PAGE, { depth: 2 });
  assert.equal(calls.length, 2);
  assert.equal(tree[0]!.children?.[0]!.id, B2);
  assert.equal(tree[0]!.children?.[0]!.children, undefined);

  const many = list(Array.from({ length: 5 }, (_, i) => ({ object: "block", id: `b${i}`, type: "paragraph", has_children: true, paragraph: { rich_text: rt(`${i}`) } })));
  const { fetch: f2, calls: c2 } = fake([many]);
  const capped = await client(f2).blocks(PAGE, { limit: 3 });
  assert.equal(capped.length, 3);
  assert.equal(c2.length, 1);
});

test("createPage, updatePage and appendBlocks post what they're given", async () => {
  const { fetch, calls } = fake([{ status: 200, body: { object: "page", id: PAGE_ID } }, { status: 200, body: { object: "page", id: PAGE_ID } }, list([])]);
  const n = client(fetch);
  await n.createPage({ parent: { database_id: PAGE_ID }, properties: { Name: { title: rt("New") } } });
  await n.updatePage(PAGE, { archived: true });
  await n.appendBlocks(PAGE, [{ object: "block", type: "paragraph", paragraph: { rich_text: rt("Hi") } }]);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.url, "https://api.notion.com/v1/pages");
  assert.deepEqual(body(calls[0]!).parent, { database_id: PAGE_ID });
  assert.equal(calls[1]!.init.method, "PATCH");
  assert.equal(calls[1]!.url, `https://api.notion.com/v1/pages/${PAGE_ID}`);
  assert.deepEqual(body(calls[1]!), { archived: true });
  assert.equal(calls[2]!.url, `https://api.notion.com/v1/blocks/${PAGE_ID}/children`);
  assert.equal((body(calls[2]!).children as unknown[]).length, 1);
});

test("request reaches any other endpoint under /v1", async () => {
  const { fetch, calls } = fake([list([])]);
  await client(fetch).request("get", "users");
  assert.equal(calls[0]!.url, "https://api.notion.com/v1/users");
  assert.equal(calls[0]!.init.method, "GET");
});

test("the caller's signal aborts and is never retried", async () => {
  const ac = new AbortController();
  const fetch: FetchLike = (_url, init) => new Promise((_res, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const pending = client(fetch).me({ signal: ac.signal });
  ac.abort();
  const err = await pending.catch((e: unknown) => e);
  assert.ok(err instanceof NotionError);
  assert.equal(err.kind, "aborted");
});
