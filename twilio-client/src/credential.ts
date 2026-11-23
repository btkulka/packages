// The Benhäus credential (package.json › benhaus.credential): its field names, the environment
// variable each falls back to, and which fields make a sign-in. The package never reads the
// environment itself: an app hands in process.env (or any map), or the fields loadCredential gave it.

/** The credential's fields and their environment variables. */
export const TWILIO_ENV = {
  accountSid: "TWILIO_ACCOUNT_SID",
  authToken: "TWILIO_AUTH_TOKEN",
  apiKey: "TWILIO_API_KEY",
  apiSecret: "TWILIO_API_SECRET",
  from: "TWILIO_FROM",
  messagingServiceSid: "TWILIO_MESSAGING_SERVICE_SID",
} as const;

export type TwilioField = keyof typeof TWILIO_ENV;

/** The credential's fields, any of them missing. Fits `createTwilioClient` as it is. */
export type TwilioCredential = { [K in TwilioField]?: string };

/** What a sign-in needs: the Account SID, and an API key with its secret or the Auth Token. */
export interface TwilioAuthFields {
  accountSid?: string | null;
  authToken?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
}

const clean = (v: string | null | undefined) => v?.trim() || undefined;

/** The credential's fields from an environment (`process.env`, say): each trimmed, the blank ones left out. */
export function twilioFromEnv(env: Record<string, string | undefined>): TwilioCredential {
  const out: TwilioCredential = {};
  for (const [field, name] of Object.entries(TWILIO_ENV) as [TwilioField, string][]) {
    const v = clean(env[name]);
    if (v) out[field] = v;
  }
  return out;
}

/**
 * The Basic-auth user and password the fields make: the API key and its secret when both are there
 * (Twilio's advice for production), else the Account SID and its Auth Token; undefined without an
 * Account SID or either pair.
 */
export function twilioAuth(f: TwilioAuthFields): { accountSid: string; user: string; password: string } | undefined {
  const accountSid = clean(f.accountSid);
  if (!accountSid) return undefined;
  const apiKey = clean(f.apiKey);
  const apiSecret = clean(f.apiSecret);
  if (apiKey && apiSecret) return { accountSid, user: apiKey, password: apiSecret };
  const authToken = clean(f.authToken);
  if (authToken) return { accountSid, user: accountSid, password: authToken };
  return undefined;
}

/** True when the fields can sign in: an Account SID, and an API key with its secret or the Auth Token. */
export function hasTwilioAuth(f: TwilioAuthFields): boolean {
  return twilioAuth(f) !== undefined;
}
