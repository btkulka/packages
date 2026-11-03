// A read-only check that resend-client works with the key in Benhäus: loads resend/nhi from Settings ›
// Credentials through benhaus-client (it shows on that credential's Read by as resend-client-smoke, falling back
// to RESEND_API_KEY in the environment), lists the account's domains and prints each one's name and status.
// It never prints the key and never sends anything.   npm run build, then node scripts/smoke.mjs

import { loadCredential } from "@btkulka/benhaus-client";
import { createResendClient } from "../dist/esm/index.js";

const cred = await loadCredential("resend/nhi", {
  app: "resend-client-smoke",
  env: { apiKey: "RESEND_API_KEY" },
  required: ["apiKey"],
});
if (!cred) {
  console.error("No Resend key: resend/nhi has no apiKey in Benhäus (Settings › Credentials) and RESEND_API_KEY isn't set.");
  process.exit(1);
}
const key = cred.fields.apiKey;
const quiet = (text) => String(text ?? "").split(key).join("•••");
console.log(`Key from ${cred.source}${cred.updatedAt ? `, saved ${cred.updatedAt}` : ""}.`);

const resend = createResendClient({ apiKey: key });
try {
  const domains = await resend.domains.list();
  if (!domains.data.length) console.log("No domains on this account.");
  for (const d of domains.data) console.log(`${d.name}: ${d.status}`);
} catch (e) {
  console.error(`Resend said no: ${quiet(e?.name)} ${e?.status ?? ""} ${e?.code ?? ""}: ${quiet(e?.message)}`.replace(/\s+/g, " "));
  process.exit(1);
}
