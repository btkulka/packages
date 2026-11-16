import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatFile, NewChatFile } from "../types.js";

// Files attached to a message. Claude reads them where they are, with its own
// tools, so a file on this machine goes by path; one a screen uploads (a
// phone's picker, a browser's drop) is kept under <dataDir>/chat-files by its
// hash and name, and goes by that path. The message tells Claude what came
// with it (trailer).

/** An upload over this is refused; a file named by path is read where it is, whatever its size. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** "1.2 MB", "340 KB", "12 bytes". */
export function sizeWord(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

const safeName = (name: string) => (name.trim() || "file").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120);

export class FileStore {
  constructor(private readonly root: string) {}

  private dir(): string {
    mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  /** A file to send: a path on this machine (relative to `folder`, the chat's; a folder is fine), checked; or bytes, kept. */
  incoming(f: NewChatFile, folder?: string): ChatFile {
    if ("path" in f) {
      const raw = f.path.trim().replace(/^<(.*)>$/, "$1");
      const p = /^file:/i.test(raw) ? fileURLToPath(raw) : isAbsolute(raw) ? raw : resolve(folder ?? homedir(), raw);
      if (!existsSync(p)) throw new Error(`${p} isn't there.`);
      const st = statSync(p);
      return { path: p, name: f.name?.trim() || basename(p) || p, size: st.isFile() ? st.size : undefined };
    }
    const bytes = Buffer.from(f.data, "base64");
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`${f.name} is ${sizeWord(bytes.length)}; up to ${sizeWord(MAX_UPLOAD_BYTES)} can be uploaded here.`);
    const name = safeName(f.name);
    const path = join(this.dir(), `${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}-${name}`);
    if (!existsSync(path)) writeFileSync(path, bytes);
    return { path, name, size: bytes.length };
  }

  /** What the message tells Claude about the files that came with it; "" for none. */
  static trailer(files: ChatFile[]): string {
    if (!files.length) return "";
    const line = (f: ChatFile) => `- ${f.path}${f.size === undefined ? " (a folder)" : ` (${sizeWord(f.size)})`}`;
    return `Attached files (on this machine; read them with your tools as needed):\n${files.map(line).join("\n")}`;
  }
}
