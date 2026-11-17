import assert from "node:assert/strict";
import { test } from "node:test";
import { appHosts, lanAddresses, tailscaleAddresses } from "./hosts.js";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
const ifaces = {
  Loopback: [v4("127.0.0.1", true)],
  "Wi-Fi": [v4("192.168.86.249")],
  Tailscale: [v4("100.102.17.49")],
  "vEthernet (WSL)": [v4("172.30.48.1")],
  Other: [v4("100.70.1.2")],
} as unknown as Parameters<typeof appHosts>[1];

test("by default: this machine and its Tailscale addresses, never the Wi-Fi", () => {
  assert.deepEqual(appHosts(undefined, ifaces), ["127.0.0.1", "100.102.17.49", "100.70.1.2"]);
  assert.deepEqual(tailscaleAddresses(ifaces), ["100.102.17.49", "100.70.1.2"]);
  assert.deepEqual(lanAddresses(ifaces), ["192.168.86.249", "172.30.48.1"]);
});

test("HOST overrides", () => {
  assert.deepEqual(appHosts("all", ifaces), ["0.0.0.0"]);
  assert.deepEqual(appHosts("0.0.0.0", ifaces), ["0.0.0.0"]);
  assert.deepEqual(appHosts("local", ifaces), ["127.0.0.1"]);
  assert.deepEqual(appHosts("127.0.0.1", ifaces), ["127.0.0.1"]);
  assert.deepEqual(appHosts("127.0.0.1, 192.168.86.249", ifaces), ["127.0.0.1", "192.168.86.249"]);
  assert.deepEqual(appHosts("  ", ifaces), ["127.0.0.1", "100.102.17.49", "100.70.1.2"]);
});

test("no Tailscale: this machine alone", () => {
  assert.deepEqual(appHosts(undefined, { Loopback: [v4("127.0.0.1", true)], "Wi-Fi": [v4("10.0.0.5")] } as unknown as Parameters<typeof appHosts>[1]), ["127.0.0.1"]);
});
