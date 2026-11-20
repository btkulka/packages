// The API key, from the first place that has one (Node only: `@btkulka/meshy-client/key`, never the index):
//   1. Benhäus › Settings › Credentials, the `meshy` credential (field apiKey),
//   2. MESHY_API_KEY in the environment (loadCredential's fallback, for when Benhäus is closed).
// The key is never printed or logged.

import { loadCredential } from "@btkulka/benhaus-client";

export const DEFAULT_CREDENTIAL = "meshy";
export const KEY_ENV = "MESHY_API_KEY";
export const DEFAULT_APP = "meshy-3d";

/** The key, or undefined when neither Benhäus nor the environment has one. `app` is the reader Benhäus shows. */
export async function loadMeshyKey(o: { credential?: string; app?: string } = {}): Promise<string | undefined> {
  const c = await loadCredential(o.credential ?? DEFAULT_CREDENTIAL, { app: o.app ?? DEFAULT_APP, env: { apiKey: KEY_ENV }, required: ["apiKey"] });
  return c?.fields.apiKey;
}
