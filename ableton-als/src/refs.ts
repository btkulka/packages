import { attr, scanXml } from "./xml.js";

/**
 * What a reference's relative path is relative to, from `<RelativePathType>`:
 * 0 none, 1 external (outside the project, reached with `..` from the project folder),
 * 3 project (inside the project folder), 5 library (Core Library or an installed Pack),
 * 6 user-library, 7 built-in (Live's own Resources). Anything else: unknown.
 */
export type RelativeTo = "none" | "external" | "project" | "library" | "user-library" | "built-in" | "unknown";

/** One `<FileRef>`: a file the document points at. */
export interface AbletonFileRef {
  /**
   * The absolute path as Live last saved it, entities decoded. Live 11+ writes forward
   * slashes even on Windows ("C:/Users/…"). Live 9/10 keep it in `<Data>`: decoded when it
   * holds a Windows path; null when it is a macOS alias record.
   */
  path: string | null;
  /**
   * The path relative to `relativeTo`'s base, with `/` separators and `..` for parent
   * folders. '' when there is none.
   */
  relativePath: string;
  relativeTo: RelativeTo;
  /** The file name. */
  name: string;
  /**
   * The element that holds the FileRef, which says what the file is for:
   * "SampleRef" (audio Live loads: clips, Simpler, Sampler, Drum Rack pads),
   * "OriginalFileRef" (where a sample or preset came from before it was imported),
   * "FilePresetRef" / "AbletonDefaultPresetRef" (device presets), "MxPatchRef" (a Max for Live device)…
   */
  owner: string;
}

const RELATIVE_TO: Record<string, RelativeTo> = {
  "0": "none",
  "1": "external",
  "3": "project",
  "5": "library",
  "6": "user-library",
  "7": "built-in",
};

interface Draft {
  owner: string;
  depth: number;
  path?: string;
  relString?: string;
  relDirs: string[];
  inRelPath: boolean;
  hasRelativePath?: boolean;
  relativePathType?: string;
  name?: string;
  dataStart?: number;
  data?: string;
}

/**
 * Every file reference in a decoded Ableton document, in document order. Covers the
 * Live 11/12 layout (`<Path>`, `<RelativePath Value>`) and the Live 9/10 one
 * (`<RelativePathElement Dir>` lists, `<Name>`, hex `<Data>`). Duplicates are kept: a
 * sample used by three clips appears three times.
 */
export function listFileRefs(xml: string): AbletonFileRef[] {
  const out: AbletonFileRef[] = [];
  const stack: string[] = [];
  let d: Draft | null = null;

  scanXml(xml, {
    open(tag) {
      const parent = stack[stack.length - 1] ?? "";
      if (!d && tag.name === "FileRef") {
        d = { owner: parent, depth: stack.length, relDirs: [], inRelPath: false };
      } else if (d) {
        const level = stack.length - d.depth; // 1 = direct child of FileRef
        if (level === 1) {
          switch (tag.name) {
            case "Path":
              d.path = attr(tag, "Value");
              break;
            case "RelativePath": {
              const v = attr(tag, "Value");
              if (v !== undefined) d.relString = v;
              else d.inRelPath = true;
              break;
            }
            case "RelativePathType":
              d.relativePathType = attr(tag, "Value");
              break;
            case "HasRelativePath":
              d.hasRelativePath = attr(tag, "Value") === "true";
              break;
            case "Name":
              d.name = attr(tag, "Value");
              break;
            case "Data":
              d.dataStart = tag.end;
              break;
          }
        } else if (level === 2 && tag.name === "RelativePathElement" && parent === "RelativePath") {
          d.relDirs.push(attr(tag, "Dir") ?? "");
        }
      }
      stack.push(tag.name);
    },
    close(name, start) {
      stack.pop();
      if (!d) return;
      const level = stack.length - d.depth;
      if (level === 1 && name === "Data" && d.dataStart !== undefined) {
        d.data = start > d.dataStart ? xml.slice(d.dataStart, start) : "";
      } else if (level === 0 && name === "FileRef") {
        const ref = finish(d);
        if (ref) out.push(ref);
        d = null;
      }
    },
  });
  return out;
}

function finish(d: Draft): AbletonFileRef | null {
  const path = (d.path || null) ?? (d.data ? windowsPathFromData(d.data) : null);
  const name = d.name || basename(path ?? "") || basename(d.relString ?? "");
  let relativePath = "";
  if (d.relString !== undefined) {
    relativePath = d.relString;
  } else if (d.hasRelativePath || d.relDirs.length > 0) {
    // Live 9/10: an empty Dir is a step up to the parent folder.
    relativePath = [...d.relDirs.map((dir) => (dir === "" ? ".." : dir)), d.name ?? ""].filter(Boolean).join("/");
  }
  if (!path && !relativePath && !name) return null;
  return {
    path,
    relativePath,
    relativeTo: d.relativePathType === undefined ? (relativePath ? "unknown" : "none") : (RELATIVE_TO[d.relativePathType] ?? "unknown"),
    name,
    owner: d.owner,
  };
}

/**
 * Live 9/10 keep the absolute path in `<Data>` as hex. On Windows it is the path in
 * UTF-16LE with a NUL terminator; on macOS it is an alias record, which we don't decode.
 */
export function windowsPathFromData(hex: string): string | null {
  const h = hex.replace(/\s+/g, "");
  if (!h || h.length % 4 !== 0 || /[^0-9a-fA-F]/.test(h)) return null;
  let s = "";
  for (let i = 0; i < h.length; i += 4) {
    const unit = parseInt(h.slice(i, i + 2), 16) | (parseInt(h.slice(i + 2, i + 4), 16) << 8);
    if (unit === 0) break;
    s += String.fromCharCode(unit);
  }
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/.test(s) ? s : null;
}

/** The last segment of a path with either separator, on any OS. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
