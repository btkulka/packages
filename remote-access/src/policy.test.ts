import assert from "node:assert/strict";
import { test } from "node:test";
import type { Person } from "./people.js";
import { baseTool, definePolicy, describe, mayCall, mayChange, mayHear, mayReachPort, seesNotice, usesTool } from "./policy.js";

const owner: Person = { id: "owner", name: "Ben", role: "owner", tools: [], createdAt: "" };
const kourtney: Person = { id: "g_1", name: "Kourtney", role: "guest", tools: ["fridge-planner", "candybar"], createdAt: "" };

const policy = definePolicy({
  calls: { owner: ["config:get", "mail:send", "services:start", "settings:set"], guest: ["config:get", "services:start", "settings:set"] },
  settings: { owner: ["notify", "homePanels"], guest: ["notify"] },
  events: { guest: ["services", "notices"] },
  toolCalls: ["services:start"],
});

test("calls follow the role's list, and a guest's tool calls only their tools", () => {
  assert.deepEqual(mayCall(policy, owner, "mail:send"), { ok: true });
  assert.deepEqual(mayCall(policy, kourtney, "mail:send"), { ok: false, reason: "call" });
  assert.deepEqual(mayCall(policy, kourtney, "services:start", ["fridge-planner"]), { ok: true });
  assert.deepEqual(mayCall(policy, kourtney, "services:start", ["habit-tracker"]), { ok: false, reason: "tool" });
  assert.deepEqual(mayCall(policy, kourtney, "services:start", []), { ok: false, reason: "tool" });
  assert.deepEqual(mayCall(policy, owner, "services:start", ["habit-tracker"]), { ok: true });
  assert.deepEqual(mayCall(policy, owner, "lock:unlock"), { ok: false, reason: "call" }, "nothing outside the lists, even for the owner");
});

test("settings: every key in the patch must be allowed", () => {
  assert.ok(mayChange(policy, owner, { notify: {}, homePanels: [] }));
  assert.ok(mayChange(policy, kourtney, { notify: {} }));
  assert.ok(!mayChange(policy, kourtney, { notify: {}, homePanels: [] }));
  assert.ok(!mayChange(policy, owner, {}));
  assert.ok(!mayChange(policy, owner, null));
  assert.ok(!mayChange(policy, owner, ["notify"]));
});

test("events: a role without a list hears everything", () => {
  assert.ok(mayHear(policy, owner, "chat:stream"));
  assert.ok(mayHear(policy, kourtney, "notices"));
  assert.ok(!mayHear(policy, kourtney, "chat:stream"));
});

test("tools and their variants", () => {
  assert.equal(baseTool("candybar@web"), "candybar");
  assert.ok(usesTool(kourtney, "candybar@web"));
  assert.ok(usesTool(kourtney, "fridge-planner"));
  assert.ok(!usesTool(kourtney, "habit-tracker"));
  assert.ok(usesTool(owner, "anything"));
});

test("ports: a guest reaches only their tools' ports", () => {
  const tools = [
    { id: "fridge-planner", ports: [4878] },
    { id: "habit-tracker", ports: [42248] },
    { id: "candybar@web", ports: [7792] },
  ];
  assert.ok(mayReachPort(kourtney, 4878, tools));
  assert.ok(mayReachPort(kourtney, 7792, tools));
  assert.ok(!mayReachPort(kourtney, 42248, tools));
  assert.ok(!mayReachPort(kourtney, 9999, tools));
  assert.ok(mayReachPort(owner, 42248, tools));
  assert.ok(mayReachPort(owner, 9999, tools));
});

test("notices: a guest sees their tools' and those that open their tools", () => {
  assert.ok(seesNotice(kourtney, { app: "fridge-planner" }));
  assert.ok(seesNotice(kourtney, { app: "claude", actions: [{ action: "open-tool:fridge-planner" }] }));
  assert.ok(!seesNotice(kourtney, { app: "claude", actions: [{ action: "open-tool:habit-tracker" }] }));
  assert.ok(!seesNotice(kourtney, { app: "todoist" }));
  assert.ok(seesNotice(owner, { app: "todoist" }));
});

const computer: Person = { id: "p_1", name: "Other computers", role: "peer", tools: [], createdAt: "" };

test("a peer makes only the peer calls, on any tool, hears and sees nothing it isn't given, and reaches only tools' ports", () => {
  const withPeer = definePolicy({
    calls: { owner: ["mail:send", "services:start"], guest: ["services:start"], peer: ["services:start", "services:logs"] },
    settings: { owner: ["notify"], guest: [] },
    events: { guest: ["notices"] },
    toolCalls: ["services:start"],
  });
  assert.deepEqual(mayCall(withPeer, computer, "services:start", ["habit-tracker"]), { ok: true });
  assert.deepEqual(mayCall(withPeer, computer, "services:logs", ["toejam"]), { ok: true });
  assert.deepEqual(mayCall(withPeer, computer, "mail:send"), { ok: false, reason: "call" });
  assert.ok(!mayChange(withPeer, computer, { notify: {} }));
  assert.ok(!mayHear(withPeer, computer, "notices"));
  assert.ok(mayHear(withPeer, owner, "chat:stream"), "the owner, left out, still hears everything");
  // A policy that names no peer lists gives a peer nothing at all.
  assert.deepEqual(mayCall(policy, computer, "config:get"), { ok: false, reason: "call" });
  assert.ok(!mayHear(policy, computer, "services"));
  assert.ok(usesTool(computer, "habit-tracker"));
  const tools = [{ id: "habit-tracker", ports: [42248] }];
  assert.ok(mayReachPort(computer, 42248, tools));
  assert.ok(!mayReachPort(computer, 9999, tools), "not a port no tool answers on, which the owner may");
  assert.ok(!seesNotice(computer, { app: "habit-tracker" }));
  assert.deepEqual(describe({ ...computer, key: "secret" } as Person), { id: "p_1", name: "Other computers", role: "peer", tools: [] });
});

test("describe never carries a key", () => {
  const withKey = { ...kourtney, key: "secret" } as Person;
  assert.deepEqual(Object.keys(describe(withKey)).sort(), ["id", "name", "role", "tools"]);
  assert.deepEqual(describe(owner).tools, []);
});
