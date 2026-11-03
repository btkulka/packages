// Broadcast placeholders. Resend fills them in per recipient when it sends: the link to its hosted
// unsubscribe page, and the contact's own fields with a fallback for contacts that lack one.

/**
 * Resend's per-recipient unsubscribe link. Use it as the href in a broadcast's footer; Resend's
 * hosted page handles the unsubscribe and marks the contact, so the app never has to.
 */
export const RESEND_UNSUBSCRIBE_URL = "{{{RESEND_UNSUBSCRIBE_URL}}}";

/** The fields every contact has; any other key is a custom contact property. */
export type ContactField = "first_name" | "last_name" | "email" | (string & {});

/** Contact property keys: letters, digits and _, up to 50, case-sensitive. */
const KEY = /^[A-Za-z0-9_]{1,50}$/;

/**
 * A contact merge tag for a broadcast's subject or body: `mergeTag("first_name", "there")` is
 * `{{{contact.first_name|there}}}`, the contact's first name or "there" when it has none. Custom
 * properties work the same way (`mergeTag("city")`), and a leading `contact.` is accepted. Throws a
 * TypeError for a key Resend wouldn't read, or a fallback with `|`, `{` or `}` (they'd break the tag).
 */
export function mergeTag(field: ContactField, fallback?: string): string {
  const key = field.startsWith("contact.") ? field.slice("contact.".length) : field;
  if (!KEY.test(key)) throw new TypeError(`Not a contact field Resend can merge (letters, digits and _, up to 50): ${JSON.stringify(field)}`);
  if (fallback && /[|{}]/.test(fallback)) throw new TypeError(`A merge tag's fallback can't contain |, { or }: ${JSON.stringify(fallback)}`);
  return fallback ? `{{{contact.${key}|${fallback}}}}` : `{{{contact.${key}}}}`;
}
