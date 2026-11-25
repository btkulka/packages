import assert from "node:assert/strict";
import { test } from "node:test";
import { ownPeer, parseTailscaleStatus, runsServers } from "./tailnet.js";

// `tailscale status --json` as a tailnet with a guest, a tagged server and a node shared in from elsewhere looks.
const STATUS = JSON.stringify({
  BackendState: "Running",
  CurrentTailnet: { Name: "ben@example.test" },
  Self: { HostName: "Zagreus", TailscaleIPs: ["100.102.17.49", "fd7a::1"], OS: "windows", UserID: 111 },
  Peer: {
    a: { HostName: "hermes", TailscaleIPs: ["100.64.0.2"], OS: "macOS", Online: true, UserID: 111 },
    b: { HostName: "guest-laptop", TailscaleIPs: ["100.64.0.3"], OS: "windows", Online: true, UserID: 222 },
    c: { HostName: "nas", TailscaleIPs: ["100.64.0.4"], OS: "linux", Online: true, UserID: 333, Tags: ["tag:server"] },
    d: { HostName: "friend-box", TailscaleIPs: ["100.64.0.5"], OS: "linux", Online: true, UserID: 111, ShareeNode: true },
    e: { HostName: "iphone", TailscaleIPs: ["100.64.0.6"], OS: "iOS", Online: true, UserID: 111 },
    f: { HostName: "old", TailscaleIPs: ["100.64.0.7"], OS: "linux", Online: false },
  },
  User: { "111": { LoginName: "ben@example.test" } },
});

test("parses each peer's user, tags and share, and this machine's user", () => {
  const t = parseTailscaleStatus(STATUS);
  assert.equal(t.userId, 111);
  assert.equal(t.user, "ben@example.test");
  assert.equal(t.self?.ip, "100.102.17.49");
  const by = Object.fromEntries(t.peers.map((p) => [p.name, p]));
  assert.equal(by.hermes.userId, 111);
  assert.equal(by["guest-laptop"].userId, 222);
  assert.deepEqual(by.nas.tags, ["tag:server"]);
  assert.equal(by["friend-box"].sharee, true);
  assert.equal(by.old.userId, undefined);
  assert.equal(by.hermes.tags, undefined, "untagged nodes carry no tags");
});

test("only the same user's own untagged, unshared machines are the owner's", () => {
  const t = parseTailscaleStatus(STATUS);
  const own = t.peers.filter((p) => ownPeer(t, p) && runsServers(p)).map((p) => p.name);
  assert.deepEqual(own, ["hermes"]);
  // No user known for this machine: nothing is anyone's.
  assert.equal(ownPeer({ ...t, userId: undefined }, t.peers.find((p) => p.name === "hermes")!), false);
  // This machine itself isn't a peer of its own, and its entry doesn't carry the user (the tailnet's userId does).
  assert.equal(ownPeer(t, { ...t.self!, userId: 111 }), false);
  assert.equal(t.self?.userId, undefined);
});
