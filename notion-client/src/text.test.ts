import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksToText, dashed, databaseSchema, notionUrl, parseNotionId, propertiesText, propertyText, summaryOf, titleOf, undashed, type NotionBlock, type NotionDatabase, type NotionPage } from "./index.js";

const HEX = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const ID = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const rt = (s: string) => [{ type: "text", plain_text: s }];

test("parseNotionId reads ids and addresses", () => {
  assert.equal(parseNotionId(ID), ID);
  assert.equal(parseNotionId(ID.toUpperCase()), ID);
  assert.equal(parseNotionId(HEX), ID);
  assert.equal(parseNotionId(`https://www.notion.so/ben/Reading-list-${HEX}`), ID);
  assert.equal(parseNotionId(`https://www.notion.so/ben/Reading-list-${HEX}?pvs=4#deadbeefdeadbeefdeadbeefdeadbeef`), ID, "the block in the fragment isn't the page");
  assert.equal(parseNotionId(`https://www.notion.so/${HEX}?v=00000000000000000000000000000000`), ID, "a database view: the database, not the view");
  assert.equal(parseNotionId(`https://www.notion.so/ben/Some-page-00000000000000000000000000000000?p=${HEX}&pm=s`), ID, "a peek address: the peeked page");
  assert.equal(parseNotionId(`notion://www.notion.so/ben/Title-${HEX}`), ID);
  assert.equal(parseNotionId(`https://ben.notion.site/Title-${HEX}`), ID);
  assert.equal(parseNotionId("https://www.notion.so/ben"), undefined);
  assert.equal(parseNotionId("not an id"), undefined);
  assert.equal(parseNotionId(""), undefined);
});

test("dashed, undashed and notionUrl", () => {
  assert.equal(dashed(HEX), ID);
  assert.equal(dashed(ID), ID);
  assert.equal(undashed(ID), HEX);
  assert.equal(notionUrl(ID), `https://www.notion.so/${HEX}`);
});

test("propertyText reads each property type", () => {
  assert.equal(propertyText({ type: "title", title: rt("A name") }), "A name");
  assert.equal(propertyText({ type: "rich_text", rich_text: [...rt("Two "), ...rt("parts")] }), "Two parts");
  assert.equal(propertyText({ type: "number", number: 0 }), "0");
  assert.equal(propertyText({ type: "number", number: null }), "");
  assert.equal(propertyText({ type: "select", select: { name: "Daily" } }), "Daily");
  assert.equal(propertyText({ type: "select", select: null }), "");
  assert.equal(propertyText({ type: "status", status: { name: "In progress" } }), "In progress");
  assert.equal(propertyText({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] }), "a, b");
  assert.equal(propertyText({ type: "date", date: { start: "2026-11-01", end: null } }), "2026-11-01");
  assert.equal(propertyText({ type: "date", date: { start: "2026-11-01", end: "2026-11-03" } }), "2026-11-01 – 2026-11-03");
  assert.equal(propertyText({ type: "checkbox", checkbox: true }), "Yes");
  assert.equal(propertyText({ type: "checkbox", checkbox: false }), "No");
  assert.equal(propertyText({ type: "url", url: "https://x.y" }), "https://x.y");
  assert.equal(propertyText({ type: "people", people: [{ object: "user", id: "u1", name: "Ben" }, { object: "user", id: "u2" }] }), "Ben, u2");
  assert.equal(propertyText({ type: "files", files: [{ name: "a.pdf" }, { external: { url: "https://f" } }] }), "a.pdf, https://f");
  assert.equal(propertyText({ type: "relation", relation: [{ id: "r1" }] }), "r1");
  assert.equal(propertyText({ type: "formula", formula: { type: "string", string: "ok" } }), "ok");
  assert.equal(propertyText({ type: "formula", formula: { type: "boolean", boolean: false } }), "No");
  assert.equal(propertyText({ type: "rollup", rollup: { type: "number", number: 3 } }), "3");
  assert.equal(propertyText({ type: "rollup", rollup: { type: "array", array: [{ type: "title", title: rt("x") }, { type: "title", title: rt("y") }] } }), "x, y");
  assert.equal(propertyText({ type: "unique_id", unique_id: { prefix: "HT", number: 12 } }), "HT-12");
  assert.equal(propertyText({ type: "unique_id", unique_id: { prefix: null, number: 7 } }), "7");
  assert.equal(propertyText({ type: "created_by", created_by: { object: "user", id: "u", name: "Ben" } }), "Ben");
  assert.equal(propertyText({ type: "something_new", something_new: "raw" }), "raw");
  assert.equal(propertyText(undefined), "");
});

const page: NotionPage = {
  object: "page",
  id: ID,
  created_time: "2026-10-01T00:00:00.000Z",
  last_edited_time: "2026-11-01T12:00:00.000Z",
  archived: false,
  icon: { type: "emoji", emoji: "📚" },
  parent: { type: "database_id", database_id: "db-1" },
  url: `https://www.notion.so/Reading-list-${HEX}`,
  properties: {
    Name: { id: "title", type: "title", title: rt("Reading list") },
    Status: { id: "s", type: "status", status: { name: "Open" } },
    Empty: { id: "e", type: "rich_text", rich_text: [] },
  },
};

const db: NotionDatabase = {
  object: "database",
  id: ID,
  created_time: "2026-10-01T00:00:00.000Z",
  last_edited_time: "2026-11-01T12:00:00.000Z",
  archived: false,
  title: rt("Habits"),
  parent: { type: "workspace", workspace: true },
  url: `https://www.notion.so/${HEX}`,
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Cadence: { id: "c", name: "Cadence", type: "select", select: { options: [{ name: "Daily" }, { name: "Weekly" }] } },
    Done: { id: "d", name: "Done", type: "checkbox", checkbox: {} },
  },
};

test("titleOf, propertiesText, databaseSchema and summaryOf", () => {
  assert.equal(titleOf(page), "Reading list");
  assert.equal(titleOf({ ...page, properties: {} }), "Untitled");
  assert.equal(titleOf(db), "Habits");
  assert.deepEqual(propertiesText(page), { Name: "Reading list", Status: "Open" });
  assert.deepEqual(databaseSchema(db), { Name: "title", Cadence: "select: Daily, Weekly", Done: "checkbox" });
  assert.deepEqual(summaryOf(page), { id: ID, kind: "page", title: "Reading list", url: page.url, icon: "📚", lastEdited: page.last_edited_time, parent: { type: "database_id", id: "db-1" } });
  assert.deepEqual(summaryOf(db), { id: ID, kind: "database", title: "Habits", url: db.url, icon: undefined, lastEdited: db.last_edited_time, parent: { type: "workspace" } });
});

const block = (type: string, text: string, extra: Record<string, unknown> = {}, children?: NotionBlock[]): NotionBlock => ({
  object: "block",
  id: `${type}-${text}`,
  type,
  has_children: Boolean(children),
  [type]: { rich_text: rt(text), ...extra },
  ...(children ? { children } : {}),
});

test("blocksToText counts numbered lists, indents children and keeps tables flat", () => {
  const blocks: NotionBlock[] = [
    block("heading_2", "Plan"),
    block("numbered_list_item", "one"),
    block("numbered_list_item", "two", {}, [block("paragraph", "note")]),
    block("bulleted_list_item", "bullet"),
    block("numbered_list_item", "again"),
    block("to_do", "open", { checked: false }),
    block("quote", "said"),
    block("callout", "tip", { icon: { type: "emoji", emoji: "💡" } }),
    block("code", "x = 1", { language: "python" }),
    { object: "block", id: "div", type: "divider", has_children: false, divider: {} },
    {
      object: "block",
      id: "tbl",
      type: "table",
      has_children: true,
      table: { table_width: 2 },
      children: [
        { object: "block", id: "r1", type: "table_row", has_children: false, table_row: { cells: [rt("a"), rt("b")] } },
        { object: "block", id: "r2", type: "table_row", has_children: false, table_row: { cells: [rt("c"), rt("d")] } },
      ],
    },
    { object: "block", id: "img", type: "image", has_children: false, image: { type: "external", external: { url: "https://img" }, caption: [] } },
    { object: "block", id: "bm", type: "bookmark", has_children: false, bookmark: { url: "https://site", caption: rt("A site") } },
    { object: "block", id: "cdb", type: "child_database", has_children: false, child_database: { title: "Rows" } },
    { object: "block", id: "toc", type: "table_of_contents", has_children: false, table_of_contents: {} },
    block("paragraph", ""),
  ];
  assert.equal(
    blocksToText(blocks),
    [
      "## Plan",
      "1. one",
      "2. two",
      "  note",
      "- bullet",
      "1. again",
      "- [ ] open",
      "> said",
      "> 💡 tip",
      "```python",
      "x = 1",
      "```",
      "---",
      "| a | b |",
      "| c | d |",
      "[image] https://img",
      "A site https://site",
      "[Database] Rows",
    ].join("\n"),
  );
});
