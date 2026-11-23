import type { Person, Role } from "./people.js";

// What a person may do once signed in. The host names its calls, settings and events per role (it knows its
// own channels); these answer the questions every request asks: may they make this call, change this setting,
// hear this event, use this tool, reach this port, see this notice. The owner gets what the owner's lists give
// (and every tool and port); a guest gets the guest lists, and only their own tools; a peer (another of the
// owner's computers) gets the peer lists, which are empty unless the host gives some, on every tool, and only
// the ports the tools answer on.

export interface AccessPolicy {
  /** The calls each role may make, by the host's channel name. */
  calls: Record<Role, ReadonlySet<string>>;
  /** The settings each role may change. */
  settings: Record<Role, ReadonlySet<string>>;
  /** The events each role hears. A role left out hears every event, except a peer, which hears only what's listed. */
  events?: Partial<Record<Role, ReadonlySet<string>>>;
  /**
   * Calls that act on one tool, with its id as the first argument (start, stop, restart): a guest may make them
   * for their own tools only.
   */
  toolCalls?: ReadonlySet<string>;
}

/** A role's lists as the host gives them: a peer's may be left out, and then it may do nothing. */
type ByRole = Record<"owner" | "guest", Iterable<string>> & { peer?: Iterable<string> };

export function definePolicy(p: { calls: ByRole; settings: ByRole; events?: Partial<Record<Role, Iterable<string>>>; toolCalls?: Iterable<string> }): AccessPolicy {
  const set = (xs: Iterable<string> = []) => new Set(xs);
  const events: Partial<Record<Role, ReadonlySet<string>>> = Object.fromEntries(Object.entries(p.events ?? {}).map(([k, v]) => [k, set(v as Iterable<string>)]));
  events.peer = set(p.events?.peer);
  return {
    calls: { owner: set(p.calls.owner), guest: set(p.calls.guest), peer: set(p.calls.peer) },
    settings: { owner: set(p.settings.owner), guest: set(p.settings.guest), peer: set(p.settings.peer) },
    events,
    toolCalls: p.toolCalls ? set(p.toolCalls) : undefined,
  };
}

/**
 * The tool id a host id names: a tool's variants ("candybar@web") belong to the tool. Hosts that name variants
 * differently pass their own `base`.
 */
export const baseTool = (id: string) => id.replace(/@[^@]*$/, "");

/** Whether a person may use a tool (or one of its variants): the owner and a peer (the owner's other computer) every tool. */
export function usesTool(person: Person, toolId: string, base: (id: string) => string = baseTool): boolean {
  if (person.role !== "guest") return true;
  const b = base(toolId);
  return person.tools.some((t) => t === toolId || base(t) === b);
}

export type Refusal = { ok: false; reason: "call" | "setting" | "tool" };

/**
 * Whether a person may make a call with these arguments: the role's list, and for a tool call, their own tool.
 * A settings call is checked with mayChange.
 */
export function mayCall(policy: AccessPolicy, person: Person, channel: string, args: unknown[] = []): { ok: true } | Refusal {
  if (!policy.calls[person.role]?.has(channel)) return { ok: false, reason: "call" };
  if (policy.toolCalls?.has(channel) && person.role === "guest") {
    const id = typeof args[0] === "string" ? args[0] : "";
    if (!id || !usesTool(person, id)) return { ok: false, reason: "tool" };
  }
  return { ok: true };
}

/** Whether every setting in a patch is one this person may change. */
export function mayChange(policy: AccessPolicy, person: Person, patch: unknown): boolean {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((k) => policy.settings[person.role]?.has(k));
}

/** Whether a person hears an event: a role without a list hears every one, except a peer, which then hears none. */
export function mayHear(policy: AccessPolicy, person: Person, channel: string): boolean {
  const list = policy.events?.[person.role];
  return list ? list.has(channel) : person.role !== "peer";
}

export interface ToolPorts {
  id: string;
  /** Every port the tool answers on (its server, its web app). */
  ports: number[];
}

/** Whether a person may reach a port: the owner any; a peer any port a tool answers on; a guest only their tools'. */
export function mayReachPort(person: Person, port: number, tools: readonly ToolPorts[]): boolean {
  if (person.role === "owner") return true;
  return tools.some((t) => t.ports.includes(port) && usesTool(person, t.id));
}

/**
 * Whether a person sees a notice: the owner all of them; a guest those from one of their tools (its `app`), or
 * whose action opens one of them (`open-tool:<id>`, as a hub's posted notifications name it); a peer none.
 */
export function seesNotice(person: Person, notice: { app: string; actions?: readonly { action: string }[] }): boolean {
  if (person.role === "owner") return true;
  if (person.role === "peer") return false;
  if (usesTool(person, notice.app)) return true;
  return (notice.actions ?? []).some((a) => {
    const m = /^open-tool:(.+)$/.exec(a.action);
    return Boolean(m && usesTool(person, m[1]));
  });
}

/** What a phone is told about who it is: never a key. */
export function describe(person: Person): Pick<Person, "id" | "name" | "role" | "tools" | "avatar"> {
  return { id: person.id, name: person.name, role: person.role, tools: person.role === "guest" ? [...person.tools] : [], ...(person.avatar ? { avatar: person.avatar } : {}) };
}
