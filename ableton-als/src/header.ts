import { attrs, scanXml } from "./xml.js";

/**
 * The root `<Ableton …>` element, e.g.
 * `<Ableton MajorVersion="5" MinorVersion="12.0_12203" SchemaChangeCount="3" Creator="Ableton Live 12.2.5" Revision="…">`
 */
export interface AbletonHeader {
  /** File-format major ("4" for Live 9, "5" since Live 10). */
  majorVersion: string | null;
  /** Schema version; starts with Live's major version ("9.0_305", "10.0_370", "12.0_12203"). */
  minorVersion: string | null;
  schemaChangeCount: number | null;
  /** "Ableton Live 12.2.5", "Ableton Live 12.3b14". */
  creator: string | null;
  revision: string | null;
  /** The version from Creator: "12.2.5", "12.3b14", "10.0d150". */
  liveVersion: string | null;
  /** Live's major version, from Creator or else MinorVersion: 9, 10, 11, 12. */
  liveMajor: number | null;
  /** The first child of <Ableton>: "LiveSet" for a set, "GroupDevicePreset" for a rack… */
  documentType: string | null;
}

/**
 * Reads the root element. Returns null when the document's root isn't `<Ableton>`, which
 * makes it the "is this really an Ableton file?" check too. Stops after the first child,
 * so it is cheap on big sets.
 */
export function readAbletonHeader(xml: string): AbletonHeader | null {
  // `as` keeps TypeScript from narrowing these to null: the callbacks assign them.
  let root = null as Record<string, string> | null;
  let documentType = null as string | null;
  let rootSeen = false;
  scanXml(xml, {
    open(tag) {
      if (!rootSeen) {
        rootSeen = true;
        if (tag.name !== "Ableton") return true;
        root = attrs(tag);
        return tag.selfClosing ? true : undefined;
      }
      documentType = tag.name;
      return true;
    },
    close() {
      return true; // </Ableton> before any child
    },
  });
  if (!root) return null;
  const a = root;
  const creator = a.Creator ?? null;
  const fromCreator = creator?.match(/Live\s+(\d+(?:\.\d+)*[A-Za-z0-9.]*)/)?.[1] ?? null;
  const major = fromCreator ? parseInt(fromCreator, 10) : a.MinorVersion ? parseInt(a.MinorVersion, 10) : NaN;
  const scc = a.SchemaChangeCount != null ? Number(a.SchemaChangeCount) : NaN;
  return {
    majorVersion: a.MajorVersion ?? null,
    minorVersion: a.MinorVersion ?? null,
    schemaChangeCount: Number.isFinite(scc) ? scc : null,
    creator,
    revision: a.Revision ?? null,
    liveVersion: fromCreator,
    liveMajor: Number.isFinite(major) ? major : null,
    documentType,
  };
}
