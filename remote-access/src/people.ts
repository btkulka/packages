import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The people who may sign in to a remote, and their sessions. The owner signs in with the host's own key (the
// host keeps and shows it); each guest has a key of their own, made here, which their invite link carries once.
// Signing in gives a phone a session: a random token for its cookie, kept here only as its hash, so what crosses
// the network on every request can't be turned back into a key. Everything is stored through the host's
// SecretStore (Benhäus's encrypted secrets) as JSON under two names.
//
// Sessions from before people existed were stored as [hash, at]: they read as the owner's, so phones that were
// signed in stay signed in.

export type Role = "owner" | "guest";

export interface Person {
  /** "owner" for the owner; "g_…" for a guest. */
  id: string;
  name: string;
  role: Role;
  /** The tools a guest may use, by the host's tool id. The owner may use everything (empty here). */
  tools: string[];
  createdAt: string;
  /** When one of their phones last made a request (rounded to a few minutes). */
  lastSeen?: string;
  /** Their picture, a data: URL (PNG, JPEG, WebP or GIF, under 300 KB): what apps show beside what they did. */
  avatar?: string;
}

/** A person as an app shows them: who did what, with their name and picture. */
export type Profile = Pick<Person, "id" | "name" | "role" | "avatar">;

/** A guest as the host sees them: with their key, to show their link and code. A phone is never told it. */
export interface Guest extends Person {
  role: "guest";
  key: string;
}

/** A person as listed for the host's settings: with how many phones are signed in. */
export type Listed = (Person | Guest) & { sessions: number };

export interface SecretStore {
  get(name: string): string | null | undefined;
  set(name: string, value: string): void;
}

export interface PeopleOptions {
  store: SecretStore;
  /** The owner's key (the host's remote key). Read on every sign-in, so a new one takes effect at once. */
  ownerKey: () => string;
  ownerName?: string;
  /** Where the guests are kept. Default "remotePeople". */
  peopleName?: string;
  /** Where the sessions are kept. Default "remoteSessions" (Benhäus's name from before people). */
  sessionsName?: string;
  /** Where the owner's own name and picture are kept, once changed. Default "remoteOwner". */
  ownerProfileName?: string;
  /** Sessions kept per person; the oldest go first. Default 12. */
  maxSessions?: number;
  /** How long a session lasts from sign-in. Default 365 days (the cookie's life). */
  sessionDays?: number;
  now?: () => number;
}

export interface People {
  owner(): Person;
  /** The owner first, then the guests in the order added, each with their phones signed in. */
  list(): Listed[];
  get(id: string): Person | Guest | undefined;
  add(input: { name: string; tools: string[]; avatar?: string }): Guest;
  /** A person's name, picture (null takes it away) or, for a guest, tools. The owner ("owner") has a name and picture only. */
  update(id: string, patch: { name?: string; tools?: string[]; avatar?: string | null }): Person | Guest;
  /** Everyone's name and picture, for apps showing who did what. Never a key. */
  profiles(): Profile[];
  /** Removes a guest and signs their phones out. */
  remove(id: string): boolean;
  /** A guest's new key: their old link stops working and their phones sign out. */
  newKey(id: string): Guest;
  /** A key typed or carried by a link: a new session for whoever it belongs to. Undefined for a wrong key. */
  signIn(key: string): { token: string; person: Person } | undefined;
  /** Who a session token (a cookie) belongs to, or a key given as a bearer token (a script). */
  personFor(token: string | undefined): Person | undefined;
  signOut(token: string): boolean;
  /** Signs out one person's phones, or everyone's. */
  endSessions(personId?: string): void;
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Equal without saying how much matched. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const newKeyText = () => randomBytes(18).toString("base64url");
const cleanName = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 60);
const cleanTools = (tools: string[]) => [...new Set(tools.map((t) => String(t).trim()).filter(Boolean))].slice(0, 200);

const AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
/** A picture as given: a small data: URL, or nothing (null or ""). */
export function cleanAvatar(v: unknown): string | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !AVATAR.test(v) || v.length > 400_000) throw new Error("A picture has to be a PNG, JPEG, WebP or GIF under 300 KB.");
  return v;
}

interface Session {
  hash: string;
  at: number;
  person: string;
}

export function createPeople(options: PeopleOptions): People {
  const peopleName = options.peopleName ?? "remotePeople";
  const sessionsName = options.sessionsName ?? "remoteSessions";
  const maxSessions = options.maxSessions ?? 12;
  const life = (options.sessionDays ?? 365) * 86_400_000;
  const now = options.now ?? (() => Date.now());
  const ownerProfileName = options.ownerProfileName ?? "remoteOwner";

  /** The owner, with the name and picture they gave themselves, else ownerName. */
  function ownerPerson(): Person {
    let saved: { name?: unknown; avatar?: unknown } = {};
    try {
      saved = (JSON.parse(options.store.get(ownerProfileName) ?? "{}") as typeof saved) ?? {};
    } catch {
      /* unreadable: the defaults */
    }
    const name = typeof saved.name === "string" && cleanName(saved.name) ? cleanName(saved.name) : (options.ownerName ?? "Owner");
    const avatar = typeof saved.avatar === "string" && AVATAR.test(saved.avatar) ? saved.avatar : undefined;
    return { id: "owner", name, role: "owner", tools: [], createdAt: new Date(0).toISOString(), ...(avatar ? { avatar } : {}) };
  }

  let guests: Guest[] | undefined;
  let sessions: Session[] | undefined;

  function readGuests(): Guest[] {
    if (guests) return guests;
    try {
      const raw = JSON.parse(options.store.get(peopleName) ?? "[]") as unknown;
      guests = (Array.isArray(raw) ? raw : [])
        .filter((g): g is Guest => Boolean(g && typeof g === "object" && typeof (g as Guest).id === "string" && typeof (g as Guest).key === "string"))
        .map((g) => ({ ...g, role: "guest" as const, name: cleanName(String(g.name ?? "")) || "Guest", tools: cleanTools(Array.isArray(g.tools) ? g.tools : []) }));
    } catch {
      guests = [];
    }
    return guests;
  }
  const saveGuests = () => options.store.set(peopleName, JSON.stringify(readGuests()));

  function readSessions(): Session[] {
    if (sessions) return sessions;
    sessions = [];
    try {
      const raw = JSON.parse(options.store.get(sessionsName) ?? "[]") as unknown;
      for (const s of Array.isArray(raw) ? raw : []) {
        if (!Array.isArray(s) || typeof s[0] !== "string" || typeof s[1] !== "number") continue;
        if (now() - s[1] >= life) continue;
        sessions.push({ hash: s[0], at: s[1], person: typeof s[2] === "string" ? s[2] : "owner" });
      }
    } catch {
      /* unreadable: every phone signs in again */
    }
    return sessions;
  }
  // The owner's are written without a person, as before, so an older host reading them still knows them.
  const saveSessions = () => options.store.set(sessionsName, JSON.stringify(readSessions().map((s) => (s.person === "owner" ? [s.hash, s.at] : [s.hash, s.at, s.person]))));

  const find = (id: string) => readGuests().find((g) => g.id === id);
  const need = (id: string) => {
    const g = find(id);
    if (!g) throw new Error(`No such person: ${id}`);
    return g;
  };
  const byId = (id: string): Person | Guest | undefined => (id === "owner" ? ownerPerson() : find(id));

  function newSession(person: string): string {
    const token = randomBytes(24).toString("base64url");
    const all = readSessions();
    all.push({ hash: hashOf(token), at: now(), person });
    // Each person keeps their newest few: a phone signed in a dozen sign-ins ago signs in again.
    const theirs = all.filter((s) => s.person === person);
    for (const old of theirs.slice(0, Math.max(0, theirs.length - maxSessions))) all.splice(all.indexOf(old), 1);
    saveSessions();
    return token;
  }

  let lastSeenWrite = 0;
  function seen(g: Guest) {
    const t = now();
    const last = g.lastSeen ? Date.parse(g.lastSeen) : 0;
    if (t - last < 5 * 60_000) return;
    g.lastSeen = new Date(t).toISOString();
    // Written at most once a minute across everyone: a phone's every request shouldn't hit the disk.
    if (t - lastSeenWrite > 60_000) {
      lastSeenWrite = t;
      saveGuests();
    }
  }

  return {
    owner: ownerPerson,
    list() {
      const counts = new Map<string, number>();
      for (const s of readSessions()) counts.set(s.person, (counts.get(s.person) ?? 0) + 1);
      return [{ ...ownerPerson(), sessions: counts.get("owner") ?? 0 }, ...readGuests().map((g) => ({ ...g, sessions: counts.get(g.id) ?? 0 }))];
    },
    profiles() {
      return [ownerPerson(), ...readGuests()].map((p) => ({ id: p.id, name: p.name, role: p.role, ...(p.avatar ? { avatar: p.avatar } : {}) }));
    },
    get: byId,
    add(input) {
      const name = cleanName(input.name);
      if (!name) throw new Error("A person needs a name.");
      if (readGuests().some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already here.`);
      const avatar = cleanAvatar(input.avatar);
      const g: Guest = { id: `g_${randomBytes(6).toString("hex")}`, name, role: "guest", tools: cleanTools(input.tools), createdAt: new Date(now()).toISOString(), key: newKeyText(), ...(avatar ? { avatar } : {}) };
      readGuests().push(g);
      saveGuests();
      return g;
    },
    update(id, patch) {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      if (name === "") throw new Error("A person needs a name.");
      const avatar = patch.avatar === undefined ? undefined : (cleanAvatar(patch.avatar) ?? null);
      if (id === "owner") {
        const was = ownerPerson();
        const next = { name: name ?? was.name, avatar: avatar === undefined ? was.avatar : (avatar ?? undefined) };
        options.store.set(ownerProfileName, JSON.stringify(next));
        return ownerPerson();
      }
      const g = need(id);
      if (name !== undefined) {
        if (readGuests().some((o) => o.id !== id && o.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already here.`);
        g.name = name;
      }
      if (patch.tools !== undefined) g.tools = cleanTools(patch.tools);
      if (avatar === null) delete g.avatar;
      else if (avatar !== undefined) g.avatar = avatar;
      saveGuests();
      return g;
    },
    remove(id) {
      const all = readGuests();
      const i = all.findIndex((g) => g.id === id);
      if (i < 0) return false;
      all.splice(i, 1);
      saveGuests();
      this.endSessions(id);
      return true;
    },
    newKey(id) {
      const g = need(id);
      g.key = newKeyText();
      saveGuests();
      this.endSessions(id);
      return g;
    },
    signIn(key) {
      const k = key.trim();
      if (!k) return undefined;
      if (sameSecret(k, options.ownerKey())) return { token: newSession("owner"), person: ownerPerson() };
      const g = readGuests().find((x) => sameSecret(k, x.key));
      if (!g) return undefined;
      seen(g);
      return { token: newSession(g.id), person: g };
    },
    personFor(token) {
      if (!token) return undefined;
      const h = hashOf(token);
      const s = readSessions().find((x) => x.hash === h);
      if (s) {
        if (now() - s.at >= life) return undefined;
        const p = byId(s.person);
        if (p && p.role === "guest") seen(p as Guest);
        return p;
      }
      // A key itself: a script's bearer token, or a cookie from before sessions (the owner's key).
      if (sameSecret(token, options.ownerKey())) return ownerPerson();
      const g = readGuests().find((x) => sameSecret(token, x.key));
      return g;
    },
    signOut(token) {
      const all = readSessions();
      const i = all.findIndex((s) => s.hash === hashOf(token));
      if (i < 0) return false;
      all.splice(i, 1);
      saveSessions();
      return true;
    },
    endSessions(personId) {
      sessions = personId ? readSessions().filter((s) => s.person !== personId) : [];
      saveSessions();
    },
  };
}
