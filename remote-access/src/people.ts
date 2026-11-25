import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// The people who may sign in to a remote, and their sessions. The owner signs in with the host's own key (the
// host keeps and shows it); each guest has a key of their own, made here, which their invite link carries once.
// Signing in gives a phone a session: a random token for its cookie, kept here only as its hash, so what crosses
// the network on every request can't be turned back into a key. Everything is stored through the host's
// SecretStore (Benhäus's encrypted secrets) as JSON under two names.
//
// Sessions from before people existed were stored as [hash, at]: they read as the owner's, so phones that were
// signed in stay signed in.
//
// A peer is another of the owner's computers: the hub there calling this one's remote for the owner (Benhäus on a
// Mac starting the PC's servers). It has a name and a key of its own, kept with the guests, and gets only the calls
// the host's policy gives peers, so the owner's key never has to leave this computer, and a peer's new key cuts
// that link alone without signing a phone out.
//
// Each session also keeps when it was last used (to within a few minutes), and the browser and address the host
// saw then, so the host can list a person's phones and sign one out. One unused for idleDays (60) ends by itself.
// A session saved before these existed starts its idle clock the first time it's read, so it keeps working.

export type Role = "owner" | "guest" | "peer";

export interface Person {
  /** "owner" for the owner; "g_…" for a guest; "p_…" for a peer. */
  id: string;
  name: string;
  role: Role;
  /** The tools a guest may use, by the host's tool id. The owner and peers may use every tool (empty here). */
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

/** Another of the owner's computers, as the host sees it: with its key, which the host hands that computer itself. */
export interface Peer extends Person {
  role: "peer";
  key: string;
}

/** A person as listed for the host's settings: with how many phones (a peer: sessions) are signed in and used lately (recentDays). */
export type Listed = (Person | Guest | Peer) & { sessions: number };

/** What the host saw of a request, kept with its session: the browser's User-Agent and the address it came from. */
export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

/** One phone's (or browser's) session, as the host lists it. Never its token or the token's hash. */
export interface SessionInfo {
  /** A short id made from the session's hash: what signOutSession takes. */
  id: string;
  /** Whose it is ("owner", "g_…", "p_…"). */
  person: string;
  signedInAt: string;
  /** When it last made a request, to within a few minutes. Absent for one saved before this was kept and not used since. */
  lastUsed?: string;
  userAgent?: string;
  ip?: string;
}

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
  /** A session unused this long ends. Default 60 days. */
  idleDays?: number;
  /** list()'s count takes the sessions used within this many days. Default 30. */
  recentDays?: number;
  now?: () => number;
}

export interface People {
  owner(): Person;
  /** The owner first, then the guests and peers in the order added, each with their phones signed in. */
  list(): Listed[];
  get(id: string): Person | Guest | Peer | undefined;
  add(input: { name: string; tools: string[]; avatar?: string }): Guest;
  /** The peer of that name (another of the owner's computers), made with a key of its own the first time it's asked for. */
  peer(name: string): Peer;
  /** A person's name, picture (null takes it away) or, for a guest, tools. The owner ("owner") and peers have a name and picture only. */
  update(id: string, patch: { name?: string; tools?: string[]; avatar?: string | null }): Person | Guest | Peer;
  /** Everyone's name and picture, for apps showing who did what. Never a key, and never a peer (a computer, not a person). */
  profiles(): Profile[];
  /** Removes a guest or a peer and signs them out. */
  remove(id: string): boolean;
  /** A guest's or a peer's new key: the old one stops working and their sessions end. */
  newKey(id: string): Guest | Peer;
  /** A key typed or carried by a link: a new session for whoever it belongs to, with what the host saw of the request. Undefined for a wrong key. */
  signIn(key: string, meta?: SessionMeta): { token: string; person: Person } | undefined;
  /** Who a session token (a cookie) belongs to, or a key given as a bearer token (a script). A session's use is noted, with `meta`. */
  personFor(token: string | undefined, meta?: SessionMeta): Person | undefined;
  signOut(token: string): boolean;
  /** Signs out one person's phones, or everyone's. */
  endSessions(personId?: string): void;
  /** The live sessions, one person's or everyone's, the most recently used first. */
  sessions(personId?: string): SessionInfo[];
  /** Signs out one session by its id (sessions()): what was ended, or undefined when there's no such session. */
  signOutSession(id: string): SessionInfo | undefined;
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
  /** When it last made a request (rounded to a few minutes). */
  used?: number;
  /** A session saved before `used` was kept: when its idle clock started (the first time this read it). */
  from?: number;
  ua?: string;
  ip?: string;
}

/** A session's id for the host's list: from its hash, so nothing new is stored and the hash itself isn't shown. */
const sessionId = (hash: string) => createHash("sha256").update(`session:${hash}`).digest("base64url").slice(0, 16);
const cleanMeta = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function createPeople(options: PeopleOptions): People {
  const peopleName = options.peopleName ?? "remotePeople";
  const sessionsName = options.sessionsName ?? "remoteSessions";
  const maxSessions = options.maxSessions ?? 12;
  const life = (options.sessionDays ?? 365) * 86_400_000;
  const idle = (options.idleDays ?? 60) * 86_400_000;
  const recent = (options.recentDays ?? 30) * 86_400_000;
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

  /** Everyone with a key of their own: guests and peers, in the order added, kept together under peopleName. */
  let keyed: (Guest | Peer)[] | undefined;
  let sessions: Session[] | undefined;

  function readKeyed(): (Guest | Peer)[] {
    if (keyed) return keyed;
    try {
      const raw = JSON.parse(options.store.get(peopleName) ?? "[]") as unknown;
      keyed = (Array.isArray(raw) ? raw : [])
        .filter((g): g is Guest | Peer => Boolean(g && typeof g === "object" && typeof (g as Guest).id === "string" && typeof (g as Guest).key === "string"))
        // A peer keeps no tools, so a version from before peers reads one as a guest with nothing shared.
        .map((g): Guest | Peer =>
          g.role === "peer"
            ? { ...g, role: "peer", name: cleanName(String(g.name ?? "")) || "Computer", tools: [] }
            : { ...g, role: "guest", name: cleanName(String(g.name ?? "")) || "Guest", tools: cleanTools(Array.isArray(g.tools) ? g.tools : []) },
        );
    } catch {
      keyed = [];
    }
    return keyed;
  }
  const saveKeyed = () => options.store.set(peopleName, JSON.stringify(readKeyed()));
  const readGuests = () => readKeyed().filter((g): g is Guest => g.role === "guest");

  /** When a session was last known to be in use, for its idle clock. */
  const usedAt = (s: Session) => s.used ?? s.from ?? s.at;
  const live = (s: Session, t = now()) => t - s.at < life && t - usedAt(s) < idle;

  function readSessions(): Session[] {
    if (sessions) return sessions;
    sessions = [];
    let upgraded = false;
    try {
      const raw = JSON.parse(options.store.get(sessionsName) ?? "[]") as unknown;
      for (const s of Array.isArray(raw) ? raw : []) {
        if (!Array.isArray(s) || typeof s[0] !== "string" || typeof s[1] !== "number") continue;
        const one: Session = { hash: s[0], at: s[1], person: typeof s[2] === "string" ? s[2] : "owner" };
        if (typeof s[3] === "number") one.used = s[3];
        if (typeof s[4] === "string") one.ua = s[4];
        if (typeof s[5] === "string") one.ip = s[5];
        if (typeof s[6] === "number") one.from = s[6];
        // Saved before sessions kept their use: its idle clock starts now, so a phone signed in long ago stays.
        if (one.used === undefined && one.from === undefined) {
          one.from = now();
          upgraded = true;
        }
        if (!live(one)) continue;
        sessions.push(one);
      }
    } catch {
      /* unreadable: every phone signs in again */
    }
    if (upgraded) saveSessions();
    return sessions;
  }
  // [hash, at, person, used, userAgent, ip, from], trailing blanks left off. The owner's person is left empty, as
  // before, so an older host reading them still knows them; an older host reads the first three and ignores the rest.
  const row = (s: Session) => {
    const r: unknown[] = [s.hash, s.at, s.person === "owner" ? null : s.person, s.used ?? null, s.ua ?? null, s.ip ?? null, s.from ?? null];
    while (r.length > 2 && r[r.length - 1] === null) r.pop();
    return r;
  };
  let sessionsWrite = 0;
  const saveSessions = () => {
    sessionsWrite = now();
    options.store.set(sessionsName, JSON.stringify(readSessions().map(row)));
  };
  /** Ends the sessions past their life or idle too long; true when any went. */
  function prune(): boolean {
    const all = readSessions();
    const t = now();
    const kept = all.filter((s) => live(s, t));
    if (kept.length === all.length) return false;
    sessions = kept;
    return true;
  }
  const infoOf = (s: Session): SessionInfo => ({
    id: sessionId(s.hash),
    person: s.person,
    signedInAt: new Date(s.at).toISOString(),
    ...(s.used !== undefined ? { lastUsed: new Date(s.used).toISOString() } : {}),
    ...(s.ua ? { userAgent: s.ua } : {}),
    ...(s.ip ? { ip: s.ip } : {}),
  });
  /** A session used now: noted every few minutes, written at most once a minute across everyone, like lastSeen. */
  function touch(s: Session, meta?: SessionMeta) {
    const t = now();
    const ua = cleanMeta(meta?.userAgent, 300);
    const ip = cleanMeta(meta?.ip, 64);
    if (s.used !== undefined && t - s.used < 5 * 60_000 && (!ip || ip === s.ip) && (!ua || ua === s.ua)) return;
    s.used = t;
    delete s.from;
    if (ua) s.ua = ua;
    if (ip) s.ip = ip;
    if (t - sessionsWrite > 60_000) saveSessions();
  }

  const find = (id: string) => readKeyed().find((g) => g.id === id);
  const need = (id: string) => {
    const g = find(id);
    if (!g) throw new Error(`No such person: ${id}`);
    return g;
  };
  const byId = (id: string): Person | Guest | Peer | undefined => (id === "owner" ? ownerPerson() : find(id));

  function newSession(person: string, meta?: SessionMeta): string {
    const token = randomBytes(24).toString("base64url");
    prune();
    const all = readSessions();
    const t = now();
    const ua = cleanMeta(meta?.userAgent, 300);
    const ip = cleanMeta(meta?.ip, 64);
    all.push({ hash: hashOf(token), at: t, person, used: t, ...(ua ? { ua } : {}), ...(ip ? { ip } : {}) });
    // Each person keeps their few most recently used: a phone not used for a dozen sign-ins signs in again.
    const theirs = all.filter((s) => s.person === person);
    const stale = [...theirs].sort((a, b) => usedAt(a) - usedAt(b)).slice(0, Math.max(0, theirs.length - maxSessions));
    for (const old of stale) all.splice(all.indexOf(old), 1);
    saveSessions();
    return token;
  }

  let lastSeenWrite = 0;
  function seen(g: Guest | Peer) {
    const t = now();
    const last = g.lastSeen ? Date.parse(g.lastSeen) : 0;
    if (t - last < 5 * 60_000) return;
    g.lastSeen = new Date(t).toISOString();
    // Written at most once a minute across everyone: a phone's every request shouldn't hit the disk.
    if (t - lastSeenWrite > 60_000) {
      lastSeenWrite = t;
      saveKeyed();
    }
  }

  return {
    owner: ownerPerson,
    list() {
      // Only phones still signed in and used lately: not every token ever issued.
      const counts = new Map<string, number>();
      const t = now();
      for (const s of readSessions()) if (live(s, t) && s.used !== undefined && t - s.used < recent) counts.set(s.person, (counts.get(s.person) ?? 0) + 1);
      return [{ ...ownerPerson(), sessions: counts.get("owner") ?? 0 }, ...readKeyed().map((g) => ({ ...g, sessions: counts.get(g.id) ?? 0 }))];
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
      readKeyed().push(g);
      saveKeyed();
      return g;
    },
    peer(name) {
      const n = cleanName(name);
      if (!n) throw new Error("A computer needs a name.");
      const had = readKeyed().find((g): g is Peer => g.role === "peer" && g.name.toLowerCase() === n.toLowerCase());
      if (had) return had;
      const p: Peer = { id: `p_${randomBytes(6).toString("hex")}`, name: n, role: "peer", tools: [], createdAt: new Date(now()).toISOString(), key: newKeyText() };
      readKeyed().push(p);
      saveKeyed();
      return p;
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
        if (readKeyed().some((o) => o.id !== id && o.role === g.role && o.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already here.`);
        g.name = name;
      }
      // A peer may use every tool, through the calls the host gives peers: it keeps no list.
      if (patch.tools !== undefined && g.role === "guest") g.tools = cleanTools(patch.tools);
      if (avatar === null) delete g.avatar;
      else if (avatar !== undefined) g.avatar = avatar;
      saveKeyed();
      return g;
    },
    remove(id) {
      const all = readKeyed();
      const i = all.findIndex((g) => g.id === id);
      if (i < 0) return false;
      all.splice(i, 1);
      saveKeyed();
      this.endSessions(id);
      return true;
    },
    newKey(id) {
      const g = need(id);
      g.key = newKeyText();
      saveKeyed();
      this.endSessions(id);
      return g;
    },
    signIn(key, meta) {
      const k = key.trim();
      if (!k) return undefined;
      if (sameSecret(k, options.ownerKey())) return { token: newSession("owner", meta), person: ownerPerson() };
      const g = readKeyed().find((x) => sameSecret(k, x.key));
      if (!g) return undefined;
      seen(g);
      return { token: newSession(g.id, meta), person: g };
    },
    personFor(token, meta) {
      if (!token) return undefined;
      const h = hashOf(token);
      const s = readSessions().find((x) => x.hash === h);
      if (s) {
        if (!live(s)) {
          // Past its life, or unused too long: it ends here.
          if (prune()) saveSessions();
          return undefined;
        }
        const p = byId(s.person);
        if (!p) return undefined;
        touch(s, meta);
        if (p.role !== "owner") seen(p as Guest | Peer);
        return p;
      }
      // A key itself: a script's or a peer's bearer token, or a cookie from before sessions (the owner's key).
      if (sameSecret(token, options.ownerKey())) return ownerPerson();
      const g = readKeyed().find((x) => sameSecret(token, x.key));
      if (g) seen(g);
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
    sessions(personId) {
      if (prune()) saveSessions();
      return readSessions()
        .filter((s) => !personId || s.person === personId)
        .sort((a, b) => usedAt(b) - usedAt(a))
        .map(infoOf);
    },
    signOutSession(id) {
      const all = readSessions();
      const i = all.findIndex((s) => sessionId(s.hash) === id);
      if (i < 0) return undefined;
      const [gone] = all.splice(i, 1);
      saveSessions();
      return infoOf(gone);
    },
  };
}
