// Who a request to a local app is from, by Benhäus's people (Settings › People): Ben, or a guest like Kourtney.
// Apps use it to keep track of who did what, with each person's name and picture from their Benhäus profile.
//
// Three ways a request comes in:
//   1. Through Benhäus's phone remote, which passes a signed-in phone's requests on from this PC and names the
//      person in a header (after dropping any such header the phone sent). Trusted only from a loopback socket.
//   2. Straight to the app over Tailscale (the app listens there too). The browser still sends the remote's
//      session cookie (cookies belong to the host, whatever the port), and Benhäus says whose it is.
//   3. From this PC with neither: Ben, at his own computer.
// Anything else (another machine with no session) is nobody in particular: undefined.

import type { BenhausClient } from "./client.js";
import type { BenhausProfile } from "./types.js";

/** The header Benhäus's pass-through names the person in. */
export const PERSON_HEADER = "x-benhaus-person";
/** The phone remote's session cookie. */
export const REMOTE_COOKIE = "bh_remote";

export interface RequestLike {
  socket?: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}

export interface RequestPerson {
  /** "owner" for Ben, "g_…" for a guest. */
  id: string;
  /** How it was known: Benhäus's pass-through, the remote's session, or this PC. */
  via: "remote" | "session" | "this-pc";
  /** A guest known by their session: the tools they may use (Benhäus's pass-through checks that itself). */
  tools?: string[];
}

const isLoopback = (a?: string) => Boolean(a && (a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.")));
const header = (req: RequestLike, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function cookie(req: RequestLike, name: string): string | undefined {
  for (const part of (header(req, "cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return undefined;
}

/** Sessions Benhäus has already named, for a few minutes, so every request doesn't ask it. */
const known = new Map<string, { id: string | null; tools?: string[]; at: number }>();

/** Who the request is from (see the top of this file), or undefined when nobody in particular. Never throws. */
export async function requestPerson(req: RequestLike, client: Pick<BenhausClient, "people">): Promise<RequestPerson | undefined> {
  const local = isLoopback(req.socket?.remoteAddress);
  const named = header(req, PERSON_HEADER);
  if (local && named && /^(owner|g_[\w-]+)$/.test(named)) return { id: named, via: "remote" };
  const session = cookie(req, REMOTE_COOKIE);
  if (session) {
    const hit = known.get(session);
    if (hit && Date.now() - hit.at < 5 * 60_000) {
      if (hit.id) return { id: hit.id, via: "session", ...(hit.tools ? { tools: hit.tools } : {}) };
    } else {
      try {
        const p = await client.people.whois(session);
        known.set(session, { id: p?.id ?? null, tools: p?.tools, at: Date.now() });
        if (known.size > 200) known.delete(known.keys().next().value!);
        if (p) return { id: p.id, via: "session", ...(p.tools ? { tools: p.tools } : {}) };
      } catch {
        /* Benhäus not answering: as if there were no session */
      }
    }
  }
  return local ? { id: "owner", via: "this-pc" } : undefined;
}

/** Everyone's name and picture, read from Benhäus at most once a minute (and kept when it isn't answering). */
export function createProfileCache(client: Pick<BenhausClient, "people">, ttlMs = 60_000) {
  let list: BenhausProfile[] = [];
  let at = 0;
  let reading: Promise<BenhausProfile[]> | undefined;
  const all = async (fresh = false): Promise<BenhausProfile[]> => {
    if (!fresh && Date.now() - at < ttlMs) return list;
    // A Benhäus without people (older, or a test's fake) reads as nobody, never a throw.
    reading ??= Promise.resolve()
      .then(() => client.people.profiles())
      .then((p) => ((list = p), (at = Date.now()), p))
      .catch(() => list)
      .finally(() => (reading = undefined));
    return reading;
  };
  return {
    all,
    async get(id: string): Promise<BenhausProfile | undefined> {
      return (await all()).find((p) => p.id === id) ?? (await all(true)).find((p) => p.id === id);
    },
    /** After a profile changes. */
    forget: () => void (at = 0),
  };
}
