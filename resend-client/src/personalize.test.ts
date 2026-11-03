import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeTag, RESEND_UNSUBSCRIBE_URL } from "./index.js";

test("the unsubscribe placeholder is Resend's, triple-braced", () => {
  assert.equal(RESEND_UNSUBSCRIBE_URL, "{{{RESEND_UNSUBSCRIBE_URL}}}");
});

test("mergeTag builds contact tags, with or without a fallback", () => {
  assert.equal(mergeTag("first_name", "there"), "{{{contact.first_name|there}}}");
  assert.equal(mergeTag("last_name"), "{{{contact.last_name}}}");
  assert.equal(mergeTag("email", ""), "{{{contact.email}}}");
  assert.equal(mergeTag("city", "your city"), "{{{contact.city|your city}}}");
  assert.equal(mergeTag("contact.first_name", "friend"), "{{{contact.first_name|friend}}}");
});

test("mergeTag refuses a key Resend can't read or a fallback that would break the tag", () => {
  for (const bad of ["", "first name", "first-name", "contact.", "a".repeat(51), "{{x}}"]) assert.throws(() => mergeTag(bad), TypeError, bad);
  for (const bad of ["a|b", "}}}", "{"]) assert.throws(() => mergeTag("first_name", bad), TypeError, bad);
  assert.equal(mergeTag("a".repeat(50)), `{{{contact.${"a".repeat(50)}}}}`);
});
