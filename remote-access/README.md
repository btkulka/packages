# @btkulka/remote-access

The people who may sign in to a remote, and what each may do there. Benhäus's phone remote is built on it (Settings › People). The owner signs in with the host's own key. Each guest gets a key of their own and a list of the owner's tools they may use. A peer, another of the owner's computers, gets a key of its own and only the calls the host gives peers, so the owner's key never has to leave the host. A signed-in phone holds a session, never a key.

Two parts:

- **People** (`createPeople`): the guests, their keys, the sessions, sign-in and sign-out.
- **Policy** (`definePolicy` and the `may*` checks): pure functions answering whether this person may make this call, change this setting, hear this event, reach this port or see this notice.

```ts
import { createPeople, definePolicy, describe, mayCall, mayReachPort } from "@btkulka/remote-access";

const people = createPeople({
  store: { get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v) }, // the host's encrypted secrets
  ownerKey: () => remoteKey(),       // read on every sign-in, so a new key works at once
  ownerName: "Ben",
});

const kourtney = people.add({ name: "Kourtney", tools: ["fridge-planner"] }); // { id: "g_…", key, … }
const signed = people.signIn(keyFromLink);   // { token, person } or undefined
const person = people.personFor(cookieToken); // on every request

const policy = definePolicy({
  calls: { owner: ALL_CHANNELS, guest: ["config:get", "services:list", "services:start", "notices:list"] },
  settings: { owner: ALL_SETTINGS, guest: [] },
  events: { guest: ["config", "services:state", "notices"] },
  toolCalls: ["services:start", "services:restart"], // calls whose first argument is a tool id
});

const verdict = mayCall(policy, person, "services:start", ["habit-tracker"]);
// { ok: false, reason: "tool" }: a call guests may make, on a tool that isn't theirs
```

## People

- `owner()`, `list()` (the owner first, then guests in the order added, each with `sessions`, the phones signed in), and `get(id)`.
- `add({ name, tools })` makes a guest with a fresh key. `update(id, { name?, tools? })` changes them; tools is the whole list. `remove(id)` removes them and ends their sessions.
- `newKey(id)` gives a guest a new key and ends their sessions, so their old link stops working.
- `peer(name)` is the peer of that name (`p_…`), made with a key of its own the first time it's asked for: the host hands that key to its other computer (Benhäus puts it in the credential vault as its link). It has no tools list, since it may act on every tool through the calls its role allows; `newKey(id)` and `remove(id)` cut it alone, and the owner's and guests' phones stay signed in. Peers are kept with the guests (a version from before peers reads one as a guest with nothing shared), are in `list()`, and are never in `profiles()`.
- `signIn(key)` checks the owner's key, then each guest's, in constant time. It starts a session: a random token for the cookie, stored only as its hash. A person keeps 12 sessions at most (`maxSessions`), oldest dropped first, each lasting a year (`sessionDays`).
- `personFor(token)` is the person a cookie belongs to, and marks them seen (written at most once a minute, so a busy phone doesn't write on every request). It also takes a key itself: a bearer header, or an older cookie that held the key. `signOut(token)` ends one session. `endSessions(personId?)` ends one person's sessions, or everyone's.
- **Names and pictures.** Everyone has a name and an optional `avatar`, a data: URL (PNG, JPEG, WebP or GIF under 300 KB; `cleanAvatar` checks it). `update("owner", { name, avatar })` gives the owner their own, kept under `remoteOwner`, else `ownerName`. `profiles()` is everyone's id, name, role and picture for apps showing who did what, never a key. `describe()` includes the picture.
- Everything is stored through the host's `SecretStore` as JSON under two names, `remotePeople` and `remoteSessions` by default. Sessions saved before people existed (`[hash, at]`) read as the owner's, so phones that were already signed in stay signed in.

## Policy

- `definePolicy({ calls, settings, events?, toolCalls? })` builds the rules: the channels and setting keys each role may use, the events a guest hears, and which calls name a tool as their first argument. A peer's lists (`calls.peer`, `settings.peer`, `events.peer`) may be left out, and then a peer may do and hear nothing; a role other than a peer that has no events list hears every event.
- `mayCall(policy, person, channel, args)` answers `{ ok: true }` or `{ ok: false, reason: "call" | "setting" | "tool" }`.
- `mayChange(policy, person, patch)` checks that every key in a settings patch is one the person may change.
- `mayHear(policy, person, channel)` says whether the person hears an event.
- `usesTool(person, toolId)` is true for the owner and a peer always, and for a guest when the tool, or the desktop app behind a `<id>@web` web app, is theirs.
- `mayReachPort(person, port, toolPorts)` lets a guest reach only the ports their tools answer on, and a peer only ports some tool answers on (the owner any). The host lists the ports per tool.
- `seesNotice(person, notice)` lets a guest see a notice from one of their tools, or one whose action opens one (`open-tool:<id>`); a peer sees none.
- `describe(person)` is what a phone may be told about itself: id, name, role and tools, never the key.

What a guest is shown (their tools, their verticals, their notices) is the host's business. Benhäus does it in `src/main/remoteScope.ts`, with these checks underneath.

Icon: `icon.svg` is a key with a person cut into its bow, on the Benhäus app-icon plate in the Utilities sky tint. It was designed on the Claude Design canvas https://claude.ai/artifact/K463VLAvnDzPCVMtgL5G2a with the Benhäus design system. BPM draws it through `benhaus.config.json` (`logos` and the `libraries` row).

Tests: `npm test` (node:test on the built `dist/`).
