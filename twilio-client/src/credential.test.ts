import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hasTwilioAuth, TWILIO_ENV, twilioAuth, twilioFromEnv } from "./index.js";

test("twilioFromEnv: each field from its variable, trimmed, blanks left out", () => {
  const env = {
    TWILIO_ACCOUNT_SID: " AC1 ",
    TWILIO_AUTH_TOKEN: "tok",
    TWILIO_API_KEY: "  ",
    TWILIO_FROM: "+18885550100\n",
    TWILIO_MESSAGING_SERVICE_SID: "",
    OTHER: "x",
  };
  assert.deepEqual(twilioFromEnv(env), { accountSid: "AC1", authToken: "tok", from: "+18885550100" });
  assert.deepEqual(twilioFromEnv({}), {});
});

test("twilioAuth: the API key and secret over the Auth Token; the token when the pair is incomplete; nothing without a SID", () => {
  assert.deepEqual(twilioAuth({ accountSid: "AC1", authToken: "tok", apiKey: "SK1", apiSecret: "sec" }), { accountSid: "AC1", user: "SK1", password: "sec" });
  assert.deepEqual(twilioAuth({ accountSid: "AC1", authToken: "tok", apiKey: "SK1" }), { accountSid: "AC1", user: "AC1", password: "tok" });
  assert.deepEqual(twilioAuth({ accountSid: " AC1 ", authToken: " tok " }), { accountSid: "AC1", user: "AC1", password: "tok" });
  assert.equal(twilioAuth({ accountSid: "AC1", apiKey: "SK1" }), undefined);
  assert.equal(twilioAuth({ authToken: "tok" }), undefined);
  assert.equal(hasTwilioAuth({ accountSid: "AC1", apiKey: "SK1", apiSecret: "sec" }), true);
  assert.equal(hasTwilioAuth({ accountSid: "AC1", authToken: "  " }), false);
});

test("package.json's Benhäus credential names the same fields and variables, and tests with the Auth Token", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const cred = pkg.benhaus.credential;
  assert.deepEqual(
    Object.fromEntries(cred.fields.map((f: { name: string; env: string }) => [f.name, f.env])),
    TWILIO_ENV,
  );
  const secret = cred.fields.filter((f: { secret: boolean }) => f.secret).map((f: { name: string }) => f.name);
  assert.deepEqual(secret, ["authToken", "apiSecret"]);
  assert.equal(cred.test.method, "GET");
  assert.equal(cred.test.url, "https://api.twilio.com/2010-04-01/Accounts/{accountSid}.json");
  assert.deepEqual(cred.test.basicAuth, ["accountSid", "authToken"]);
});
