import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyChat, applyChats, applyStream, diffItems } from "./patch.js";
import type { ChatItem, ChatState } from "./types.js";

const you = (id: string, text = id): ChatItem => ({ kind: "you", id, text });
const tool = (id: string, state: "running" | "done" = "running"): ChatItem => ({ kind: "tool", id, name: "Bash", state });
const chat = (items: ChatItem[]): ChatState => ({ id: "c1", title: "t", status: "ready", folder: "D:/x", pickedModel: "", mode: "default", items, asks: [] });

/** What a screen holding `sent` has after main sends the change to `now`. */
function roundTrip(sent: ChatItem[], now: ChatItem[]) {
  const { items: _, ...rest } = chat(now);
  return applyChat(chat(sent), { ...rest, ...diffItems(sent, now) }).items;
}

describe("diffItems / applyChat", () => {
  it("sends nothing when the rows are the same array", () => {
    const a = [you("1")];
    assert.deepEqual(diffItems(a, a), {});
  });

  it("sends only new rows when one is pushed", () => {
    const a = [you("1"), you("2")];
    const b = [...a, you("3")];
    assert.deepEqual(diffItems(a, b), { upsert: [b[2]], count: 3 });
    assert.deepEqual(roundTrip(a, b), b);
  });

  it("sends a row replaced in place, and keeps the others' identity", () => {
    const a = [you("1"), tool("t1")];
    const b = [a[0], tool("t1", "done")];
    assert.deepEqual(diffItems(a, b), { upsert: [b[1]], count: 2 });
    const got = applyChat(chat(a), { ...chat(b), items: undefined, ...diffItems(a, b) }).items;
    assert.equal(got[0], a[0]);
    assert.deepEqual(got[1], b[1]);
  });

  it("drops the oldest when the conversation is trimmed", () => {
    const a = [you("1"), you("2"), you("3")];
    const b = [a[1], a[2], you("4")];
    assert.deepEqual(diffItems(a, b), { upsert: [b[2]], count: 3 });
    assert.deepEqual(roundTrip(a, b), b);
  });

  it("sends everything when the rows were read in again", () => {
    const a = [you("1"), you("2")];
    const b = [you("x"), you("y"), you("1")];
    assert.equal(diffItems(a, b).items, b);
    assert.deepEqual(roundTrip(a, b), b);
    assert.deepEqual(roundTrip([], b), b);
    assert.deepEqual(roundTrip(a, []), []);
  });

  it("sends everything when rows moved", () => {
    const a = [you("1"), you("2"), you("3")];
    const b = [a[0], a[2], a[1]];
    assert.equal(diffItems(a, b).items, b);
  });
});

describe("applyChats", () => {
  it("keeps chats it has and takes new ones whole", () => {
    const one = chat([you("1")]);
    const two = { ...chat([]), id: "c2" };
    const got = applyChats({ current: "c1", chats: [one], models: [] }, { current: "c2", ids: ["c2", "c1"], chats: [two], models: [] });
    assert.deepEqual(got?.chats.map((c) => c.id), ["c2", "c1"]);
    assert.equal(got?.chats[1], one);
    assert.equal(got?.current, "c2");
  });

  it("gives up on a chat it never had", () => {
    assert.equal(applyChats(undefined, { current: "c1", ids: ["c1"], chats: [], models: [] }), undefined);
  });
});

describe("applyStream", () => {
  it("grows, starts again, and refuses a gap", () => {
    assert.equal(applyStream(undefined, { id: "c", at: 0, text: "He" }), "He");
    assert.equal(applyStream("He", { id: "c", at: 2, text: "llo" }), "Hello");
    assert.equal(applyStream("Hello", { id: "c", at: 0, text: "" }), "");
    assert.equal(applyStream("He", { id: "c", at: 5, text: "x" }), undefined);
  });
});
