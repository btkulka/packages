import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createPeople, type SecretStore } from "./people.js";

function memory(init: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, get: (n) => data[n], set: (n, v) => void (data[n] = v) };
}

const OWNER_KEY = "owner-key-123456";

test("the owner signs in with the host's key; a wrong key gets nothing", () => {
  const people = createPeople({ store: memory(), ownerKey: () => OWNER_KEY, ownerName: "Ben" });
  const s = people.signIn(OWNER_KEY)!;
  assert.equal(s.person.role, "owner");
  assert.equal(s.person.name, "Ben");
  assert.equal(people.personFor(s.token)?.id, "owner");
  assert.equal(people.signIn("nope"), undefined);
  assert.equal(people.signIn(""), undefined);
  assert.equal(people.personFor("not-a-session"), undefined);
});

test("a guest gets a key of their own, and signs in as themselves with only their tools", () => {
  const store = memory();
  const people = createPeople({ store, ownerKey: () => OWNER_KEY });
  const k = people.add({ name: "  Kourtney ", tools: ["fridge-planner", "fridge-planner", " "] });
  assert.equal(k.name, "Kourtney");
  assert.deepEqual(k.tools, ["fridge-planner"]);
  assert.match(k.id, /^g_/);
  assert.ok(k.key.length >= 20);
  const s = people.signIn(k.key)!;
  assert.equal(s.person.role, "guest");
  assert.deepEqual(people.personFor(s.token)?.tools, ["fridge-planner"]);
  // Kept across a restart, keys and all.
  const again = createPeople({ store, ownerKey: () => OWNER_KEY });
  assert.equal(again.personFor(s.token)?.name, "Kourtney");
  assert.throws(() => people.add({ name: "kourtney", tools: [] }), /already here/);
  assert.throws(() => people.add({ name: "  ", tools: [] }), /needs a name/);
});

test("sessions are stored as hashes; the owner's in the old shape", () => {
  const store = memory();
  const people = createPeople({ store, ownerKey: () => OWNER_KEY });
  const o = people.signIn(OWNER_KEY)!;
  const g = people.add({ name: "K", tools: [] });
  const gs = people.signIn(g.key)!;
  const raw = JSON.parse(store.data.remoteSessions) as unknown[][];
  const hash = (t: string) => createHash("sha256").update(t).digest("hex");
  assert.deepEqual(raw[0], [hash(o.token), raw[0][1]]);
  assert.deepEqual(raw[1], [hash(gs.token), raw[1][1], g.id]);
  assert.ok(!store.data.remoteSessions.includes(o.token));
});

test("sessions from before people read as the owner's", () => {
  const token = "legacy-token";
  const hash = createHash("sha256").update(token).digest("hex");
  const store = memory({ remoteSessions: JSON.stringify([[hash, Date.now()]]) });
  const people = createPeople({ store, ownerKey: () => OWNER_KEY });
  assert.equal(people.personFor(token)?.role, "owner");
});

test("a key works as a bearer token, and the owner's old cookie (the key) still signs in", () => {
  const people = createPeople({ store: memory(), ownerKey: () => OWNER_KEY });
  const g = people.add({ name: "K", tools: ["a"] });
  assert.equal(people.personFor(OWNER_KEY)?.role, "owner");
  assert.equal(people.personFor(g.key)?.id, g.id);
});

test("a new key, removing someone and signing out end the right sessions", () => {
  const people = createPeople({ store: memory(), ownerKey: () => OWNER_KEY });
  const o = people.signIn(OWNER_KEY)!;
  const k = people.add({ name: "K", tools: [] });
  const kOld = people.signIn(k.key)!;
  const oldKey = k.key;
  people.newKey(k.id);
  assert.equal(people.personFor(kOld.token), undefined, "their phones sign out");
  assert.equal(people.signIn(oldKey), undefined, "their old link stops working");
  assert.equal(people.personFor(o.token)?.role, "owner", "the owner's phones stay");
  const kNew = people.signIn(people.get(k.id)! && (people.get(k.id) as { key: string }).key)!;
  assert.ok(people.signOut(kNew.token));
  assert.equal(people.personFor(kNew.token), undefined);
  const k2 = people.signIn((people.get(k.id) as { key: string }).key)!;
  assert.ok(people.remove(k.id));
  assert.equal(people.personFor(k2.token), undefined);
  assert.equal(people.remove(k.id), false);
  people.endSessions();
  assert.equal(people.personFor(o.token), undefined);
});

test("each person keeps their newest sessions; old ones expire", () => {
  let t = 1_000_000;
  const people = createPeople({ store: memory(), ownerKey: () => OWNER_KEY, maxSessions: 2, sessionDays: 1, now: () => t });
  const a = people.signIn(OWNER_KEY)!;
  const b = people.signIn(OWNER_KEY)!;
  const k = people.add({ name: "K", tools: [] });
  const ks = people.signIn(k.key)!;
  const c = people.signIn(OWNER_KEY)!;
  assert.equal(people.personFor(a.token), undefined, "the owner's oldest went");
  assert.equal(people.personFor(b.token)?.role, "owner");
  assert.equal(people.personFor(ks.token)?.id, k.id, "another person's session isn't touched");
  t += 86_400_000 + 1;
  assert.equal(people.personFor(c.token), undefined, "past its life");
});

test("list shows the owner first, guests with their phones, and update changes name and tools", () => {
  const people = createPeople({ store: memory(), ownerKey: () => OWNER_KEY, ownerName: "Ben" });
  const k = people.add({ name: "Kourtney", tools: ["fridge-planner"] });
  people.signIn(k.key);
  people.signIn(k.key);
  const list = people.list();
  assert.deepEqual(
    list.map((p) => [p.name, p.role, p.sessions]),
    [
      ["Ben", "owner", 0],
      ["Kourtney", "guest", 2],
    ],
  );
  const u = people.update(k.id, { tools: ["fridge-planner", "letterfold"], name: "Kourt" });
  assert.deepEqual(u.tools, ["fridge-planner", "letterfold"]);
  assert.equal(u.name, "Kourt");
  assert.throws(() => people.update("g_missing", { name: "x" }), /No such person/);
  assert.ok(list[1].lastSeen, "signing in counts as being seen");
});

test("names and pictures: everyone's, the owner's too, for apps to show who did what", () => {
  const store = memory();
  const people = createPeople({ store, ownerKey: () => "owner-key", ownerName: "Ben" });
  const pic = "data:image/png;base64,iVBORw0KGgo=";
  const k = people.add({ name: "Kourtney", tools: ["fridge-planner"], avatar: pic });
  assert.equal(k.avatar, pic);
  assert.deepEqual(people.profiles(), [
    { id: "owner", name: "Ben", role: "owner" },
    { id: k.id, name: "Kourtney", role: "guest", avatar: pic },
  ]);
  // The owner names themselves and gets a picture; it's kept, and signing in carries it.
  const me = people.update("owner", { name: "Benjamin", avatar: pic });
  assert.equal(me.name, "Benjamin");
  assert.equal(createPeople({ store, ownerKey: () => "owner-key", ownerName: "Ben" }).owner().avatar, pic);
  assert.equal(people.signIn("owner-key")?.person.name, "Benjamin");
  // null takes a picture away; a picture that isn't one is refused.
  assert.equal(people.update(k.id, { avatar: null }).avatar, undefined);
  assert.throws(() => people.update(k.id, { avatar: "javascript:alert(1)" }), /PNG, JPEG, WebP or GIF/);
  assert.throws(() => people.update(k.id, { avatar: `data:image/png;base64,${"A".repeat(400_001)}` }), /under 300 KB/);
  assert.throws(() => people.update("owner", { name: "  " }), /needs a name/);
  assert.ok(!JSON.stringify(people.profiles()).includes(k.key), "profiles never carry a key");
});
