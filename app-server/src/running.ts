import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { probeHttp, sleep } from "@btkulka/proc-kit";

// A second `npm run dev` doesn't fight the first: when a healthy copy of the app already answers on the port,
// it attaches (tails its log, watches its health) and only goes on to serve when that copy goes away. Ctrl+C on
// an attached console detaches; the server stays up.

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  pid: number;
  prod: boolean;
  startedAt: string;
}

/** The app running on its port (its health answer carries its name), or undefined when nothing or something else answers. */
export async function runningInstance(o: { name: string; port: number; path?: string }): Promise<Health | undefined> {
  let found: Health | undefined;
  // probeHttp times out, never throws, and frees the socket; `accept` fingerprints the answer.
  await probeHttp(`http://127.0.0.1:${o.port}${o.path ?? "/api/health"}`, {
    accept: async (res) => {
      const h = res.ok ? ((await res.json()) as Health) : undefined;
      if (h?.name === o.name) found = h;
      return found !== undefined;
    },
  });
  return found;
}

/** Tails the running copy's log and watches its health until it goes away; resolves when it does. */
export async function attachToRunning(o: { name: string; port: number; logPath: string; instance: Health; path?: string }): Promise<void> {
  const { name, port, logPath, instance } = o;
  console.log(`${name} v${instance.version} is already running on http://127.0.0.1:${port} (pid ${instance.pid}, ${instance.prod ? "built" : "dev"}, since ${instance.startedAt}).`);
  console.log(`Attached: its log follows. Ctrl+C detaches and leaves it running.`);
  let offset = 0;
  try {
    offset = statSync(logPath).size;
  } catch {
    /* no log yet */
  }
  let detached = false;
  const detach = () => {
    detached = true;
    console.log(`\nDetached; ${name} keeps running on :${port}.`);
    process.exit(0);
  };
  process.on("SIGINT", detach);
  process.on("SIGTERM", detach);
  process.on("SIGBREAK", detach);
  let misses = 0;
  while (!detached) {
    try {
      const size = statSync(logPath).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const fh = await open(logPath, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          await fh.read(buf, 0, buf.length, offset);
          process.stdout.write(buf.toString("utf8").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, ""));
        } finally {
          await fh.close();
        }
        offset = size;
      }
    } catch {
      /* no log file yet */
    }
    if (await runningInstance({ name, port, path: o.path })) misses = 0;
    else if (++misses >= 3) break;
    await sleep(1000);
  }
  process.off("SIGINT", detach);
  process.off("SIGTERM", detach);
  process.off("SIGBREAK", detach);
  console.log(`The running ${name} stopped answering; starting here.`);
}
