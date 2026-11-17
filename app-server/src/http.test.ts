import assert from "node:assert/strict";
import { test } from "node:test";
import { isCrossSiteWrite, num, str } from "./http.js";

const req = (method: string, headers: Record<string, string>) => ({ method, headers });

// From habit-tracker's own test, before the guard moved here.
test("a write from another site's page is refused; the app's own, and anything that is not a page, pass", () => {
  // The app itself, on this machine, through the phone remote's pass-through, and through the tailnet by name.
  for (const host of ["127.0.0.1:42248", "192.168.1.20:42248", "zagreus:42248", "[fd7a:115c::1]:42248"]) {
    assert.equal(isCrossSiteWrite(req("PUT", { host, origin: `http://${host}` })), false, host);
  }
  assert.equal(isCrossSiteWrite(req("POST", { host: "Zagreus:42248", origin: "http://zagreus:42248" })), false);

  // Some other page making the browser post here.
  assert.equal(isCrossSiteWrite(req("POST", { host: "127.0.0.1:42248", origin: "https://example.com" })), true);
  // Another app on this machine is another origin: the port differs.
  assert.equal(isCrossSiteWrite(req("POST", { host: "127.0.0.1:42248", origin: "http://127.0.0.1:5173" })), true);
  assert.equal(isCrossSiteWrite(req("DELETE", { host: "127.0.0.1:42248", origin: "http://localhost:42248" })), true);
  // A sandboxed frame or a local file names no origin at all.
  assert.equal(isCrossSiteWrite(req("POST", { host: "127.0.0.1:42248", origin: "null" })), true);
  assert.equal(isCrossSiteWrite(req("POST", { origin: "http://127.0.0.1:42248" })), true);

  // Not a page: curl, an import CLI, another machine's server.
  assert.equal(isCrossSiteWrite(req("POST", { host: "127.0.0.1:42248" })), false);
  // Reads are not this check's business; the browser withholds their answers itself.
  assert.equal(isCrossSiteWrite(req("GET", { host: "127.0.0.1:42248", origin: "https://example.com" })), false);
});

test("str and num read fields plainly", () => {
  assert.equal(str("  hi  "), "hi");
  assert.equal(str(undefined), undefined);
  assert.equal(str("abcdef", 3), "abc");
  assert.throws(() => str(5), /Expected text/);
  assert.equal(num("4"), 4);
  assert.equal(num(""), null);
  assert.equal(num(undefined), undefined);
  assert.throws(() => num("x"), /Expected a number/);
});
