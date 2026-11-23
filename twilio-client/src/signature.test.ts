import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { twilioSignature, validTwilioSignature } from "./index.js";
import { bytesToBase64, hmacSha1 } from "./signature.js";

// Twilio's documented example (Security › Validating requests).
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

test("Twilio's own example signs to its documented signature", () => {
  assert.equal(twilioSignature("12345", URL, PARAMS), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assert.equal(validTwilioSignature("12345", URL, PARAMS, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="), true);
});

test("a wrong signature, token, URL or field fails; so does one of another length", () => {
  assert.equal(validTwilioSignature("12345", URL, PARAMS, "nope"), false);
  assert.equal(validTwilioSignature("12345", URL, PARAMS, "1/KCTR6DLpKmkAf8muzZqo1nDgQ="), false);
  assert.equal(validTwilioSignature("12346", URL, PARAMS, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="), false);
  assert.equal(validTwilioSignature("12345", `${URL}&x=1`, PARAMS, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="), false);
  assert.equal(validTwilioSignature("12345", URL, { ...PARAMS, Digits: "1235" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ="), false);
  assert.equal(validTwilioSignature("12345", URL, PARAMS, ""), false);
});

test("field order doesn't matter (names are sorted); a GET has no fields", () => {
  const reversed = Object.fromEntries(Object.entries(PARAMS).reverse());
  assert.equal(twilioSignature("12345", URL, reversed), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  assert.equal(twilioSignature("tok", "https://x.test/sms"), createHmac("sha1", "tok").update("https://x.test/sms").digest("base64"));
});

test("matches node:crypto's HMAC-SHA1 for text in any script and keys of any length", () => {
  const nodeSig = (token: string, url: string, params: Record<string, string>) =>
    createHmac("sha1", token)
      .update(url + Object.keys(params).sort().map((k) => k + params[k]).join(""), "utf8")
      .digest("base64");
  const cases: [string, string, Record<string, string>][] = [
    ["", "", {}],
    ["k", "https://a.test/", { Body: "café ☕ 你好 👋", From: "+15125550111" }],
    ["x".repeat(64), "https://a.test/" + "y".repeat(55), {}],
    ["x".repeat(65), "https://a.test/" + "y".repeat(56), {}],
    ["é".repeat(100), "https://a.test/" + "z".repeat(200), { A: "1" }],
  ];
  for (const [token, url, params] of cases) assert.equal(twilioSignature(token, url, params), nodeSig(token, url, params));
});

test("HMAC-SHA1 and SHA-1 padding at every length around the block edges, against node:crypto", () => {
  for (let len = 0; len <= 200; len++) {
    const key = randomBytes((len * 7) % 150);
    const data = randomBytes(len);
    const want = createHmac("sha1", key).update(data).digest("base64");
    assert.equal(bytesToBase64(hmacSha1(new Uint8Array(key), new Uint8Array(data))), want, `length ${len}`);
  }
  // A key over 64 bytes is hashed first; a message of several blocks.
  const big = randomBytes(5000);
  assert.equal(bytesToBase64(hmacSha1(new Uint8Array(big), new Uint8Array(big))), createHmac("sha1", big).update(big).digest("base64"));
  assert.equal(bytesToBase64(new Uint8Array(createHash("sha1").update("abc").digest())), "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
});

test("bytesToBase64 pads like Buffer", () => {
  for (let n = 0; n < 10; n++) {
    const b = randomBytes(n);
    assert.equal(bytesToBase64(new Uint8Array(b)), b.toString("base64"));
  }
});
