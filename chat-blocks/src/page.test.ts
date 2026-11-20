import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKS_EXT, M, MCP_APP_MIME, pagePolicy, styleVariables, withPolicy } from "./app.js";
import { BRIDGE_SCRIPT, blockPage, blockResource } from "./page.js";

test("a page's policy is the spec's defaults plus only the domains it declared", () => {
  const p = pagePolicy();
  assert.match(p, /default-src 'none'/);
  // Its own blob: and data: addresses only: nothing on the network.
  assert.match(p, /connect-src blob: data:;/);
  assert.match(p, /frame-src 'none'/);
  assert.match(p, /img-src 'self' data: blob:;/);
  const q = pagePolicy({ connectDomains: ["http://localhost:4321"], resourceDomains: ["https://*.example.com", "javascript:alert(1)"] });
  assert.match(q, /connect-src blob: data: http:\/\/localhost:4321;/);
  assert.match(q, /img-src 'self' data: blob: https:\/\/\*\.example\.com;/);
  assert.doesNotMatch(q, /javascript/);
});

test("the policy goes first in the head, whatever the page looks like", () => {
  assert.match(withPolicy("<!doctype html><html><head><title>x</title></head><body></body></html>"), /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><title>/);
  assert.match(withPolicy("<html><body>hi</body></html>"), /^<html><head><meta http-equiv/);
  assert.match(withPolicy("<p>hi</p>"), /^<!doctype html><html><head><meta[^>]+><\/head><body><p>hi<\/p><\/body><\/html>$/);
});

test("a block page inlines the look and the bridge, and nothing in it closes its script early", () => {
  const html = blockPage({ title: "Pick <one>", body: '<div id="app"></div>', script: 'ChatBlocks.connect().then(() => "</script><b>")' });
  assert.match(html, /<title>Pick &lt;one><\/title>/);
  assert.ok(html.includes(BRIDGE_SCRIPT.slice(0, 60)));
  assert.ok(html.includes(".cb-frame"), "frame.css is inlined");
  assert.ok(html.includes("--color-text-primary"), "page.css is inlined");
  assert.ok(html.includes('"<\\/script><b>"'));
  assert.equal(html.match(/<\/script>/g)?.length, 2);
  assert.match(BRIDGE_SCRIPT, /ChatBlocks/);
});

test("a block resource is an MCP Apps page at a ui:// address", () => {
  assert.deepEqual(blockResource("ui://gallery/picker", "<p/>"), { uri: "ui://gallery/picker", mimeType: MCP_APP_MIME, text: "<p/>", _meta: { ui: { prefersBorder: false } } });
  assert.throws(() => blockResource("https://x", ""), /starts with ui:\/\//);
});

test("the chat's --ck-* variables go to a page as the spec's names and their own", () => {
  const v = styleVariables({ "--ck-ink": "#fff", "--ck-surface": "#000", "--ck-font": "Inter", "--other": "x" });
  assert.equal(v["--color-text-primary"], "#fff");
  assert.equal(v["--color-background-primary"], "#000");
  assert.equal(v["--font-sans"], "Inter");
  assert.equal(v["--ck-ink"], "#fff");
  assert.equal(v["--other"], undefined);
});

test("the chat's own methods sit under btkulka/blocks: answer, image and file", () => {
  assert.equal(M.answer, `${BLOCKS_EXT}/answer`);
  assert.equal(M.image, `${BLOCKS_EXT}/image`);
  assert.equal(M.file, "btkulka/blocks/file");
  assert.equal(M.displayMode, "ui/request-display-mode");
});
