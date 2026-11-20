import { useEffect, useState } from "react";
import type { ClaudeTransport } from "../types.js";
import { useTransport, useUi } from "./context.js";

// Stars on a chat's pictures (the transport's star: Benhäus keeps them in
// Gallery). A star is for marking the ones worth keeping while looking; it
// asks Claude nothing. Every card and lightbox showing a file shares one
// answer, asked for together: a carousel of eight asks once.

/** Files a star can go on: an absolute path or a file: address (not a data:, http or kept image). */
export const starrable = (ref: string) => /^(file:|[a-z]:[\\/]|[\\/])/i.test(ref.trim());

const known = new Map<string, boolean>();
/** Files the host couldn't answer for (a phone remote that doesn't pass stars on): no star drawn on them. */
const cannot = new Set<string>();
const subs = new Map<string, Set<() => void>>();
let queue: { t: ClaudeTransport; refs: Set<string> } | undefined;

const tell = (ref: string) => subs.get(ref)?.forEach((f) => f());

function ask(t: ClaudeTransport, ref: string) {
  if (!t.star || known.has(ref) || cannot.has(ref)) return;
  if (!queue) {
    const q = (queue = { t, refs: new Set<string>() });
    queueMicrotask(() => {
      queue = undefined;
      const refs = [...q.refs];
      q.t.star!(refs).then(
        (on) => refs.forEach((r, i) => (known.set(r, Boolean(on[i])), tell(r))),
        () => refs.forEach((r) => (cannot.add(r), tell(r))),
      );
    });
  }
  queue.refs.add(ref);
}

/** A file's star: whether it's on (undefined while unknown, or where stars can't go), and a toggle. */
export function useStar(ref: string): { on: boolean | undefined; can: boolean; toggle: () => void } {
  const t = useTransport();
  const ui = useUi();
  const can = Boolean(t.star) && starrable(ref) && !cannot.has(ref);
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!can) return;
    const f = () => redraw((n) => n + 1);
    let set = subs.get(ref);
    if (!set) subs.set(ref, (set = new Set()));
    set.add(f);
    ask(t, ref);
    return () => void set!.delete(f);
  }, [ref, can]);
  const toggle = () => {
    if (!can) return;
    const was = known.get(ref) ?? false;
    known.set(ref, !was);
    tell(ref);
    t.star!([ref], !was).then(
      (on) => (known.set(ref, Boolean(on[0])), tell(ref)),
      (e) => (known.set(ref, was), tell(ref), ui.toast(ui.errorText(e))),
    );
  };
  return { on: can ? known.get(ref) : undefined, can, toggle };
}
