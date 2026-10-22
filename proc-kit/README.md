# @btkulka/proc-kit

Process and dev tooling that Ben's apps kept re-implementing: who holds a port and freeing it, killing a process tree, detached spawns with a log file, waiting for a port or an HTTP health URL, a clean environment for launching Electron, a PATH lookup, process lists and PID files.

- **Windows first, POSIX kept.** Windows behaviour is tested on Ben's machine (Windows 10, Node 22). The POSIX branches (lsof, ps, process groups) mirror what the copies did and are covered by parser tests only.
- **Node only.** There's no browser entry: no renderer or web app uses any of this.
- **No runtime dependencies.** Windows tools are called by absolute path under `%SystemRoot%\System32` (netstat, taskkill, PowerShell), so a stripped or odd PATH can't break them.
- **ESM and CommonJS:** `import { … } from "@btkulka/proc-kit"` or `require("@btkulka/proc-kit")`.

```json
"dependencies": { "@btkulka/proc-kit": "file:../packages/proc-kit" }
```

(`file:../../packages/proc-kit` from `nhi/nhi-album-art-gen`.) Build it once with `npm run build` in this folder; apps load `dist/`.

## API

### Ports

```ts
pidsOnPort(port: number): Promise<number[]>
pidsOnPortSync(port: number): number[]
probePort(port: number, opts?: { host?: string | string[]; timeoutMs?: number }): Promise<boolean>
waitForPort(port: number, opts?: { host?; timeoutMs?; connectTimeoutMs?; intervalMs?; signal? }): Promise<boolean>
waitForPortFree(port: number, opts?: { timeoutMs?; intervalMs?; signal? }): Promise<boolean>
freePort(port: number, opts?: { exclude?: number[]; graceMs?: number; timeoutMs?: number }): Promise<{ killed: number[]; skipped: number[]; free: boolean }>
```

- `pidsOnPort` lists the PIDs **listening** on a TCP port, IPv4 and IPv6, sorted, never throwing (empty when nothing listens, or on POSIX when `lsof` is missing). Windows parses `netstat -ano` (about 50 ms). It deliberately doesn't use `netstat -p tcp`, which lists IPv4 only and so misses a Vite bound to `[::1]`. It also doesn't use Get-NetTCPConnection, which costs 1.5 s of PowerShell start-up. The local port must match exactly (5173 never matches 51730). A localized Windows still works: a row counts as listening when its foreign address is `0.0.0.0:0` / `[::]:0`. A port held by http.sys shows pid 4.
- `probePort` is a TCP connect. With no `host` it tries `127.0.0.1` and `::1` in parallel and is true if either answers, because Vite binds only `::1` and most servers only `127.0.0.1`. Default timeout 1 s.
- `waitForPort` polls `probePort` (default 30 s, every 250 ms). `waitForPortFree` polls `pidsOnPort` until nothing listens (default 5 s), which gives a killed listener (and a CUDA process) time to let go.
- `freePort` kills the **tree** of every listener, then waits for the port. It always spares this process, pids in `exclude`, and pids 0 and 4. When a spared pid holds the port it returns `free: false` at once instead of waiting. It kills whatever is there: if a healthy listener should be kept and attached to (starfall's dev console), probe it first and call `freePort` only when it doesn't answer.

```js
import { freePort, probeHttp } from "@btkulka/proc-kit";
if (!(await probeHttp(`http://127.0.0.1:${API_PORT}/api/health`))) {
  const r = await freePort(API_PORT);
  if (r.killed.length) console.log(`[free-ports] killed ${r.killed.join(", ")} on :${API_PORT}`);
}
```

### Killing

```ts
killTree(pid: number, opts?: { graceMs?: number }): Promise<boolean>
killTreeSync(pid: number): boolean
isAlive(pid: number): boolean
```

- `killTree` kills a process **and everything it started**. On Windows that's `taskkill /PID <pid> /T /F`, the only thing that reaches the real server behind a `shell: true` cmd.exe, an npm `.cmd` shim or a `node --watch` runner (`child.kill()` stops the wrapper and orphans the server, which keeps its port). On POSIX it sends the signal to the process group (`-pid`, which exists when the process was spawned `detached: true`), falling back to the single pid.
- It resolves true when it killed the process, and false when the process was already gone, the pid is invalid (0, negative, fractional) or it wasn't ours to kill. It never throws. pid 1 is never group-signalled.
- `graceMs` (default 0, which forces at once) asks first and forces after that long. Windows: a plain `taskkill /T` closes GUI windows, so Electron quits cleanly. Console programs can't be asked, so for them it only delays the `/F`. POSIX: SIGTERM, then SIGKILL; it returns as soon as the process exits.
- `killTreeSync` is an immediate force-kill for `process.on("exit")` and other places where nothing async runs.
- `isAlive` is `process.kill(pid, 0)` (it works on Windows too) with EPERM counted as alive. It's cheaper than tasklist.
- **Windows caveat:** kill the tree while its root is alive. Once a parent exits, `/T` can't find its orphaned children. Find those by port (`freePort`) or by command line (`listProcesses`).

### Spawning

```ts
spawnDetached(command: string, args?: string[], opts?: {
  cwd?; env?; log?: string; logMode?: "a" | "w"; shell?: boolean;
  windowsHide?: boolean /* default true */; onError?: (err: Error) => void; spawn?: typeof child_process.spawn;
}): ChildProcess
runAndExit(command: string, args?: string[], opts?: { cwd?; env?; shell? }): ChildProcess
openUrl(url: string): boolean
packageBin(pkg: string, opts?: { from?: string; bin?: string }): string
```

- `spawnDetached` starts a program that outlives this one: `detached`, `unref()`'d, stdin ignored, stdout and stderr appended to `log` (its folder is created) or discarded. The log is opened before the spawn and closed in this process right after, even if spawn throws. A listener for `'error'` is always attached, so a missing program (ENOENT, reported asynchronously) calls `onError` and never crashes the host with an unhandled `'error'`. It returns the `ChildProcess`, whose `pid` is undefined when the start failed. You can still listen for `'exit'` on it. It throws only for a bad call: the log can't be opened, or spawn rejects its arguments (a `.cmd` without `shell`). `windowsHide` defaults to true, so no console window flashes up. Pass **false for GUI apps** (Electron, Chrome, Benhaus.exe), whose first window it would hide. `spawn` replaces `child_process.spawn` in tests.
- `runAndExit` is for launcher scripts: it runs a program on this terminal (inherited stdio) and exits with its exit code (1 when the program was killed by a signal, or couldn't start, which also prints `Could not start <cmd>: …`). Ctrl+C reaches the child straight from the terminal, so the wrapper ignores SIGINT and waits for the child to finish instead of dying first. SIGTERM and SIGHUP sent only to the wrapper are passed on.
- `openUrl` opens a URL (or file) with the default handler, fire and forget. On Windows it uses `rundll32 url.dll,FileProtocolHandler <url>`, not `cmd /c start "" <url>`, which cuts a URL at its first `&`. It returns false only if the opener couldn't be spawned, so print the URL too.
- `packageBin` returns the JS file behind an npm package's command (`tsx` → `…\tsx\dist\cli.mjs`, `electron-vite` → `…\bin\electron-vite.js`). It looks in node_modules in `from` (default the cwd) and each folder above it, as Node does. Run that file with `process.execPath` instead of the `.bin` shim: on Windows that's a `.cmd`, which Node won't spawn without a shell (EINVAL since the 2024 batch-file fix). Pass the app's root as `from` when the cwd may be elsewhere. The package can't work it out itself: linked, it lives in `D:\source\packages`.

```js
// scripts/run.mjs: electron-vite with a clean environment, no npx, no shell
import { runAndExit, electronEnv, packageBin } from "@btkulka/proc-kit";
runAndExit(process.execPath, [packageBin("electron-vite", { from: ROOT }), ...process.argv.slice(2)], { cwd: ROOT, env: electronEnv() });

// a detached server with a log
const child = spawnDetached(PYTHON, [MAIN, "--port", "8188"], { cwd: DIR, log: join(DIR, "comfyui-dev.log"), onError: (e) => log(e.message) });
return child.pid ?? null;
```

### Waiting

```ts
sleep(ms: number): Promise<void>
waitFor(check: () => boolean | Promise<boolean>, opts?: { timeoutMs? /* 30000 */; intervalMs? /* 250 */; signal?: AbortSignal }): Promise<boolean>
probeHttp(url: string | string[], opts?: { timeoutMs? /* 1500 */; method?; headers?; accept?: (res: Response) => boolean | Promise<boolean> }): Promise<boolean>
waitForHttp(url: string | string[], opts?: { timeoutMs?; intervalMs?; requestTimeoutMs?; method?; headers?; accept?; signal? }): Promise<boolean>
```

- These resolve a boolean instead of throwing, so the caller decides whether "not up in time" is fatal: `if (!(await waitForHttp(url))) throw …`.
- `waitFor` checks at once, then every `intervalMs`. A check that throws counts as "not yet". An aborted `signal` ends the wait with false. Use it to stop waiting on a child that has exited: `child.once("exit", () => ac.abort())`.
- `probeHttp`'s default `accept` is a 2xx. "Something answered" isn't enough by default: a Vite with a stale dep cache serves 504s, and an API mid-restart can take a socket and fail. Other options:
  - `accept: (r) => r.status < 500` takes 4xx, as benhaus and clipdrift did.
  - `accept: () => true` takes any answer, as starfall's dev-banner did.
  - Read the body to fingerprint the service: `async (r) => r.ok && (await r.json()).ok === true`.
  - With several URLs (`["http://127.0.0.1:5173/@vite/client", "http://[::1]:5173/@vite/client"]`) they're tried in parallel and any one passing is enough. An unread body is cancelled so the socket is freed.

```js
// open the browser once the dev server answers
if (await waitForHttp(url, { method: "HEAD", timeoutMs: 30_000, intervalMs: 300 })) openUrl(url);

// keep what the health check said
let snap;
const up = await waitForHttp(`${url}/system_stats`, { timeoutMs: 75_000, accept: async (r) => r.ok && (snap = await r.json()) !== null });
```

### Electron's environment

```ts
electronEnv(opts?: { env?: NodeJS.ProcessEnv; remove?: string[]; set?: Record<string, string | undefined> }): NodeJS.ProcessEnv
stripElectronEnv(env?: NodeJS.ProcessEnv /* process.env */): string[]
ELECTRON_ENV_KEYS: readonly string[]
```

Claude Code shells, VS Code's extension host, Playwright and Electron apps that run Electron as Node all leave `ELECTRON_RUN_AS_NODE=1` behind. An Electron launched with it starts as plain Node: `require("electron")` is a path, and main crashes on its first API call ("Cannot read properties of undefined (reading 'setAppUserModelId' / 'registerSchemesAsPrivileged')") with no window and no log.

- `electronEnv()` returns a **copy** of the environment without `ELECTRON_ENV_KEYS`. Those are `ELECTRON_RUN_AS_NODE`, `ATOM_SHELL_INTERNAL_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE` and `ELECTRON_OVERRIDE_DIST_PATH`, the union of what the copies stripped. It also drops any `remove` keys, then applies `set` (where `undefined` deletes). The input is never modified.
- `stripElectronEnv()` strips the same keys **in place** (default `process.env`), so every later spawn inherits a clean environment, and returns the names it removed.
- Names match case-insensitively on Windows.
- Code that deliberately **sets** `ELECTRON_RUN_AS_NODE=1` (running Electron's own Node for a matching native ABI) keeps doing that inline. It isn't a copy of this.

### Finding executables

```ts
findExecutable(name: string, opts?: { extraDirs?: string[] }): string | null
```

`findExecutable` is a synchronous PATH lookup that doesn't spawn `where` or `which`. It returns an absolute path or null. **The signature is stable:** `@btkulka/media-kit` uses it.

- It searches PATH first, then `extraDirs` in order. To prefer a bundled binary, check its path yourself first.
- On Windows a bare name is tried with each PATHEXT extension in order (default `.COM;.EXE;.BAT;.CMD`, lower-cased in the result), folder by folder, so PATH order wins over extension order, as with cmd.exe.
- A name that already ends in a PATHEXT extension (`claude.exe`) is looked up as given. Extensionless files (npm's sh shims) are never returned on Windows. A name with a folder in it is checked where it points. Quoted PATH entries are unquoted, and the cwd is **not** searched.
- On POSIX the file must have its execute bit.
- A `.cmd` / `.bat` result needs a shell to run: `spawn(p, args, { shell: true })` or `cmd.exe /d /c`.

### Processes

```ts
listProcesses(filter?: { pid?: number; name?: string }): Promise<ProcessInfo[]>
// ProcessInfo = { pid; ppid; name; commandLine?; executablePath? }
```

- On Windows it uses `Get-CimInstance Win32_Process` through PowerShell, about 1.5 s per call. It doesn't use wmic, which is deprecated and missing on new Windows 11 installs. Output is forced to UTF-8 so a command line with `…\Benhäus\…` comes through intact. `name` is the image name (`node.exe`, case-insensitive). `commandLine` and `executablePath` are missing for processes the OS won't describe (other users' processes without elevation).
- On POSIX it uses `ps -A -o pid=,ppid=,args=`. `name` is the basename of argv[0], and there's no `executablePath`.
- It's empty when the lookup fails, and never throws. The list includes this process.
- **Orphans on Windows:** an orphan keeps its dead parent's pid as `ppid`. Test `!isAlive(ppid)`, not `ppid === 1`.

### PID files

```ts
writePidFile(file: string, data?: { pid?: number; [k: string]: unknown }): PidFileData
readPidFile(file: string): (PidFileData & { alive: boolean }) | null
removePidFile(file: string): void
// PidFileData = { pid: number; startedAt: string; ...extra }
```

`writePidFile` writes JSON with `pid` (default this process), `startedAt` (now) and any extra fields, such as `supervisorPid` or `port`. It creates the folder and replaces the file atomically. `readPidFile` adds `alive`. It returns null when the file is missing, unreadable or has no valid pid. It also reads the old line format (`pid\nstartedAt\n…`) as `{ pid, startedAt }`; further lines are dropped. `removePidFile` never throws.

## Replaces

Paths are relative to `D:\source`. Line numbers were taken on 2026-10-22 and drift. The function names are the reliable anchor.

### Port owner / freeing a port

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| starfall | tools/port-procs.mjs | whole file: `parseNetstat`, `pidsOnPort`, `pidsOnPortAsync`, `killPid`, `waitForPortFree` | `pidsOnPortSync`, `pidsOnPort`, `killTree`, `waitForPortFree`; delete the file |
| starfall | tools/free-ports.mjs | `pidsOnPort` L23, `kill` L46, sweep loop L72-82 | `freePort(port)` per port that failed its probe |
| starfall | tools/restart-comfyui.mjs | `restartComfy` L26, `stopComfy` L55 (kill loop + wait) | `freePort(comfyPort())`; keep the launch/log messages |
| starfall | tools/restart-kobold.mjs | `restartKobold` L19, `stopKobold` L46 | `freePort(koboldPort())` |
| starfall | tools/dev-console.mjs | `refreshGpuSplit` L308 uses `pidsOnPortAsync` | `pidsOnPort` |
| benhaus | src/main/processes.ts | `portHolder` L108 (netstat + tasklist), `portOpen` L76 | `pidsOnPort` + `listProcesses({ pid })` for the name; `probePort` |
| orson | scripts/orson/process-cleanup.ts | `findListenerPid` L65, `cleanupDevPorts`, `cleanupComfyPort` | `pidsOnPort`, `freePort` |
| orson | scripts/orson/start.ts | cleanup L231-245 (fixed 1500 ms sleep + recheck) | `freePort` (waits for the port itself) |
| job-searcher | src/server.ts | `portOwner` L252 (Get-NetTCPConnection + CIM), `portFreed` L316 | `pidsOnPort` + `listProcesses({ pid })`; `waitForPortFree` |
| toejam | app/server.mjs | `portTaken` L572, `pidOnPort` L580 | `probePort`, `pidsOnPort` |
| reddit-search-lists-app | scripts/kill-stale.js | whole file body | `freePort(PORT)` |
| nhi-dashboard | scripts/dev.js | `portListeners` L99 (lsof only) | `pidsOnPort` |

### Kill tree

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| benhaus | src/main/processes.ts | `killTree` L118 | `killTree` |
| starfall | tools/dev-console.mjs | `killChildren` L158 | `killTreeSync(child.pid)` |
| starfall | tools/dev-pane.mjs | `stop` L88 | `killTree(child.pid)` |
| starfall | tools/dialogue-lab.mjs | `shutdown` L169 | `killTreeSync(child.pid)` |
| orson | scripts/orson/process-cleanup.ts | `killTree` L96 | `killTree` / `killTreeSync` |
| orson | src/comfy/supervisor.ts | `stop()` forced-kill timer L111-125 | `killTree(child.pid, { graceMs: STOP_TIMEOUT_MS })` |
| orson | scripts/playwright-dialogue.ts | `teardown` L264-281 | `killTreeSync(child.pid)` |
| orson | src/orchestrator.ts | `forceKill` L325 | optional: `killTree(pid)` |
| clipdrift | src/main/worker/comfy/launcher.ts | `stopComfyIfOwned` L145-193 | `killTree(pid, { graceMs: CONFIG.comfy.shutdownGraceMs })` |
| nhi-dashboard | scripts/dev.js | `stop` L168, `shutdown` L175, `reap` L123 (its kill loop) | `killTree(pid, { graceMs: 1500 })` |
| nhi/nhi-album-art-gen | src/app/api/comfyui/launch/route.ts | `DELETE` (`kill("SIGTERM")`) | `killTree(pid)` |
| job-searcher | src/server.ts | `restartServer` L357 `process.kill(owner.pid)` | `killTree(owner.pid)` |
| toejam | app/server.mjs | `replaceRunning` L614 `process.kill(old.pid)` | `killTree(old.pid)` |

### Alive check / PID files

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| benhaus | scripts/launch.cjs | `alive` L76, update lock in `updating` L111 and `rebuild` | `isAlive`; `writePidFile` / `readPidFile` / `removePidFile` |
| orson | src/comfy/pidfile.ts | whole file (`write`, `read`, `clear`, `isAlive` via tasklist) | `writePidFile`, `readPidFile`, `removePidFile`, `isAlive` |
| job-searcher | src/research-job.ts, src/send-run.ts | `isAlive` (L50, L112) | `isAlive` |

### Detached launch (with a log)

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| starfall | tools/ensure-comfyui.mjs | `launchComfy` L52 (log + spawn) | `spawnDetached(python, args, { cwd, log, env })` |
| starfall | tools/ensure-kobold.mjs | `launchKobold` L88 | `spawnDetached("cmd.exe", ["/d", "/c", bat], { cwd, log })` |
| benhaus | scripts/launch.cjs | `launch` L129 | `spawnDetached(exe, args, { cwd, env, windowsHide: false })` |
| benhaus | src/main/standalone.ts | `startUpdate` L118 (log `w`) | `spawnDetached(..., { log, logMode: "w" })` |
| benhaus | src/main/launch.ts | `detached` L9 | `spawnDetached(command, [], { cwd, shell: true })` |
| clipdrift | scripts/serve-headless.js | `--detach` branch | `spawnDetached(electronBin, args, { env, log })` |
| nhi-dashboard | src/site.js | `spawnPublish` L486 | `spawnDetached(process.execPath, [...], { cwd, env, log: LOG })` |
| nhi-dashboard | scripts/chrome.js | spawn L41 | `spawnDetached(chrome, args, { windowsHide: false })` |
| job-searcher | src/regen-now.ts | `launchRegenNow` L111-131 | `spawnDetached(bin, args, { cwd, env, log, spawn: opts.spawn })` |
| job-searcher | src/research-job.ts | launch L321-346 | same |
| job-searcher | src/send-run.ts | session launch L233-252 | same |
| job-searcher | src/server.ts | `ensureServer` L243 | `spawnDetached` + `waitForHttp` |
| job-searcher | scripts/cdp.mjs, scripts/linkedin-send.mjs | Chrome `launch` (cdp L62, linkedin-send L67) | `spawnDetached(CHROME, flags, { windowsHide: false })` |
| orson | scripts/orson/start.ts | `ensureComfyRunning` L130 | `spawnDetached("npm", ["run", "comfy"], { cwd, shell: win })` + `waitForHttp` |
| nhi/nhi-album-art-gen | src/app/api/comfyui/launch/route.ts | `POST` | `spawnDetached("cmd.exe", ["/d", "/c", startBat], { cwd })` / python |

### Health poll / wait

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| starfall | tools/dev-probe.mjs | `get` L21, `probe` L34 (both loopbacks) | `probeHttp([v4Url, v6Url], { timeoutMs, accept })` |
| starfall | tools/ensure-comfyui.mjs | `comfyRunning` L31 | `probeHttp(`${COMFY_URL}/system_stats`)` |
| starfall | tools/ensure-kobold.mjs | `get` L43 (`koboldRunning`) | `probeHttp` |
| starfall | tools/dialogue-lab.mjs | `ping` L54, `waitFor` L96, `sleep` | `probeHttp`, `waitFor(check, { timeoutMs: 90_000, intervalMs: 400 })`, `sleep` |
| starfall | tools/dev-console.mjs | `ping` L176 | `probeHttp(url, { accept: () => true })` |
| starfall | tools/dev-banner.mjs | `waitFor` L40, `ping` L50 | `waitForHttp(url, { accept: () => true, intervalMs: 300 })`, `probeHttp` |
| starfall | tools/bake-cues.mjs | `waitForServer` L71 | `waitForHttp(..., { intervalMs: 1000, requestTimeoutMs: 3000 })` then throw |
| starfall | tools/queue-moodsets.mjs | `waitForServer` L129 | `waitFor` (keep its "announced" log in the check) |
| starfall | server/index.ts | `siblingApi` L24 | `probeHttp(url, { accept })` |
| benhaus | src/main/processes.ts | `healthy` L89, ready poll in `start` L158-179, `startExternal` loop | `probePort` + `probeHttp(url, { accept: (r) => r.status < 500 })`; `waitFor` |
| benhaus | scripts/launch.cjs | `waitForHealth` L117, `wait` L74 | `waitFor(() => health(), …)`, `sleep` |
| orson | src/comfy/health.ts | `waitReady` | `waitForHttp(..., { accept })` (capture VRAM in `accept`), throw on false |
| orson | scripts/orson/start.ts | `comfyResponds` L109, poll L150-160 | `probeHttp`, `waitForHttp` |
| clipdrift | src/main/worker/comfy/launcher.ts | `pollUntilReady` L37 | `waitFor(() => isReachable(endpoint), { signal })` (abort on child exit) |
| job-searcher | scripts/dev.mjs | `poll` L37-50 | `waitForHttp(url, { method: "HEAD" })` |
| job-searcher | src/server.ts | `dashboardUp` L223, wait loop in `ensureServer` | `probeHttp`, `waitForHttp` |
| toejam | app/server.mjs | `waitFor` L229, `sleep` L228 | `waitFor(fn, { timeoutMs: ms, intervalMs: every })`, `sleep` |
| norf-hampton-electron | scripts/start-electron.js | `checkViteReady`, `waitForVite` | `waitForHttp("http://localhost:5174", { timeoutMs: 30_000, intervalMs: 200 })` |

### ELECTRON_RUN_AS_NODE strip / launcher wrappers

| Repo | File | Function or lines | Replaced by |
|---|---|---|---|
| benhaus | scripts/run.mjs | whole file | `runAndExit(process.execPath, [packageBin("electron-vite", { from: ROOT }), ...args], { env: electronEnv() })` |
| benhaus | scripts/launch.cjs | `cleanEnv` L36 | `electronEnv({ remove: ["ELECTRON_RENDERER_URL"] })` |
| benhaus | src/main/claude.ts | `childEnv` (~L350) | `electronEnv({ remove: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"], set: { CLAUDE_AGENT_SDK_CLIENT_APP: … } })` |
| orson | scripts/orson/strip-electron-env.ts | whole file | `stripElectronEnv()` (same return value) |
| orson | scripts/orson/dev.ts | whole file | `runAndExit(process.execPath, [packageBin("electron-vite", { from: REPO_ROOT }), "dev"], { cwd: REPO_ROOT, env: electronEnv() })` |
| orson | scripts/orson/start.ts | `stripElectronEnv()` call L197 | `stripElectronEnv` from here |
| orson | scripts/playwright-dialogue.ts | `childEnv` L206-215 | `electronEnv({ set: { ORSON_CDP_PORT: …, … } })` |
| orson | bin/orson.mjs | re-exec through tsx | `runAndExit(process.execPath, [packageBin("tsx", { from: root }), entry, ...args])` |
| clipdrift | scripts/run-electron-vite.js | whole file | `runAndExit(process.execPath, [packageBin("electron-vite", { from: root }), ...args], { env: electronEnv({ set: { USER_TIER: "PREMIUM" } }) })` |
| clipdrift | scripts/serve-headless.js | `ELECTRON_ENV_KEYS` loop, foreground branch | `electronEnv({ set: { USER_TIER: "PREMIUM" } })`, `runAndExit` |
| candybar-manager | scripts/run-electron-vite.mjs | whole file | `runAndExit(process.execPath, [packageBin("electron-vite"), ...args], { env: electronEnv() })` |
| candybar-manager | tests/e2e/helpers.ts | env loop in `launchApp` | `electronEnv({ set: { NODE_ENV: "test", ELECTRON_DISABLE_SANDBOX: "1" } })` |
| norf-hampton-electron | scripts/start-electron.js | `delete process.env.ELECTRON_RUN_AS_NODE` + spawn | `runAndExit(require("electron"), ["."], { cwd, env: electronEnv({ set: { NODE_ENV: "development" } }) })` |
| norf-hampton-electron | scripts/start-prod.js | whole file | `runAndExit(require("electron"), ["."], { cwd, env: electronEnv() })` |
| job-searcher | scripts/dev.mjs | tsx spawn + exit forwarding | `runAndExit(process.execPath, [packageBin("tsx", { from: root }), "watch", …])` |

### Open a URL

| Repo | File | Function | Replaced by |
|---|---|---|---|
| starfall | tools/dev-console.mjs | `openUrl` L101 | `openUrl` |
| starfall | tools/dialogue-lab.mjs | `openUrl` L156 | `openUrl` |
| job-searcher | src/open.ts | `openBrowser` (whole file) | `openUrl`; update the imports in cli.ts and mcp.ts |
| job-searcher | scripts/dev.mjs | `openBrowser` L26 | `openUrl` |
| nhi-dashboard | scripts/dev.js | `browse` L45 | `openUrl` (keep the `BROWSER` override app-side) |
| toejam | app/server.mjs | `spawn("explorer.exe", [url])` L639 | `openUrl` |

### PATH lookup

| Repo | File | Function | Replaced by |
|---|---|---|---|
| job-searcher | src/research-job.ts | `claudeBin` L60 | `findExecutable("claude.exe")`, then the native exe beside `findExecutable("claude.cmd")` |
| benhaus | src/main/mcp/register.ts | `claudeExe` L60 (`where claude`) | same as above |
| clipdrift | src/mcp-server/utils/paths.ts | `findInPath` L14 | `findExecutable` (or through media-kit, if it takes over the ffmpeg lookups) |
| clipdrift | src/mcp-server/run-upscale.ts | `findInPath` L158 | `findExecutable` |
| clipdrift | src/mcp-server/run-preview.ts | `findInPath` L142 | `findExecutable` |
| clipdrift | src/main/services/scanner.ts | `findInPath` L381 | `findExecutable` |
| clipdrift | src/main/services/ytdlp.ts | `findOnPath` L68 | `findExecutable("yt-dlp")` |
| candybar-manager | lib/youtubeDl.mjs | `findOnPath` L66 (where.exe / which) | `findExecutable` (sync now) |
| toejam (Python) | tools/glsl_check.py | `shutil.which` L38 | not ported (Python) |

### Process list

| Repo | File | Function | Replaced by |
|---|---|---|---|
| orson | scripts/orson/process-cleanup.ts | `findOrphanMcpServers` (+ Windows/POSIX helpers) | `listProcesses()` filtered by name and `MCP_SERVER_MARKERS` (keep the markers in orson) |
| clipdrift | src/main/services/orphanCleaner.ts | `findProcessesByName` (wmic) | `listProcesses({ name })` → `pid`, `executablePath` |
| nhi-dashboard | scripts/dev.js | `ps` L78 | `listProcesses()` |

### Not shared (on purpose)

- **benhaus `processes.ts` `stats()`:** wmic RAM/CPU per service tree plus `app.getAppMetrics`. Electron-specific, and nobody else needs CPU or memory.
- **benhaus `launch.ts` `openTerminal`, starfall `server/routes/ai.ts` launch:** these use `start "" …` to open a **visible** new console on purpose.
- **toejam `tdProcess`:** needs `tasklist /V` window titles.
- **Reveal in Explorer:** toejam, candybar `abletonLibrary.mjs` and starfall `jobActions.ts` use `explorer /select`. It's a different job from opening a URL.
- **orson `parent-watchdog.ts`:** a server exiting when its parent dies. It could use `isAlive(ppid)`, but there's nothing else to share.
- **The `ELECTRON_RUN_AS_NODE: "1"` setters:** orson `node-abi-launcher.ts`, `desktop/main.ts`, `ensure-native-abi.ts`; benhaus `package.cjs` `compile`, `standalone.ts`, `mcp/register.ts`. They deliberately run Electron as Node.
- **Supervisors** (benhaus processes.ts restart policy, orson `ComfySupervisor`, clipdrift's owned ComfyUI): each has its own state machine. They use the primitives here but stay in their apps.
- **Finding and driving Chrome for CDP** (job-searcher cdp.mjs, nhi-dashboard chrome.js): a separate concern. Only the detached spawn comes from here.

## Migration notes per app

General:

- **Add the dependency, delete the copy, in the same change** (packages README). Build this package first (`npm run build` in `D:\source\packages\proc-kit`).
- **Electron main processes** (benhaus, clipdrift, orson, candybar) build with electron-vite's `externalizeDepsPlugin()`, which leaves `require("@btkulka/proc-kit")` in the bundle. Either bundle it in with `externalizeDepsPlugin({ exclude: ["@btkulka/proc-kit"] })`, which is the simplest choice, or make sure the packaged app ships it (electron-builder and benhaus's `package.cjs` see a symlink; see benhaus below). Check the **packaged** app, not just `dev`.
- **Async now:** `pidsOnPort`, `freePort`, `killTree`, `listProcesses`, `waitFor*`. Sync versions exist only for `pidsOnPortSync`, `killTreeSync`, `isAlive` and `findExecutable`.
- **PIDs are numbers.** starfall's port-procs returned strings.
- **IPv6:** every netstat copy (starfall, benhaus, orson, toejam, reddit-search-lists-app) used `netstat -ano -p tcp`, which lists **IPv4 only**, and toejam's matched only `0.0.0.0:0` rows on top of that. A listener bound to `[::]` / `[::1]` (Vite) was invisible to all of them. Now it's found and freed. That's a behaviour change, and a fix.
- **Tree, not pid:** starfall's free-ports and port-procs `killPid` killed only the listening pid. `freePort` / `killTree` take the listener's children too.

### starfall

ESM `.mjs` tools run with plain node; `server/` runs under tsx.

- **Delete `tools/port-procs.mjs`.**
  - `pidsOnPort` → `pidsOnPortSync`, `pidsOnPortAsync` → `pidsOnPort`.
  - `killPid(pid)` → `killTree(pid)` (async; takes the tree) or `killTreeSync`.
  - `waitForPortFree(port, { tries, delayMs })` → `waitForPortFree(port, { timeoutMs: tries * delayMs, intervalMs: delayMs })`. The defaults (5000/250) equal the old 20 × 250.
- **free-ports.mjs:** keep the probe-first logic (`viteAlive` / `apiAlive`), and replace the sweep with `freePort(port)` for each port that didn't answer. Keep `--force`.
- **dev-probe.mjs:** `probe(port, path, accept, timeoutMs)` → `probeHttp(["http://127.0.0.1:" + port + path, "http://[::1]:" + port + path], { timeoutMs, accept })`.
  - For `apiAlive`, `accept` is `async (r) => r.ok && (await r.json())?.ok === true`. For `viteAlive`, use the default.
- **ensure-comfyui / ensure-kobold:** these must still never fail predev.
  - `spawnDetached` throws if the log can't be opened. The old code fell back to discarding output, so wrap it in try/catch. It now also creates the log's folder.
  - Return `child.pid ?? null`.
  - Pass `env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }` as before.
  - Kobold's `.bat`: `spawnDetached("cmd.exe", ["/d", "/c", KOBOLD_LAUNCHER], { cwd, log })`.
- **dev-console / dev-pane / dialogue-lab.** Spawning the services stays in the scripts, because they pipe and tag output.
  - Their teardown → `killTreeSync(child.pid)` on all platforms. On POSIX that's SIGKILL now, where it used to be SIGTERM to the child. Use `killTree(pid, { graceMs: 2000 })` where async is possible and graceful matters.
  - `openUrl` replaces both copies.
  - `dev-console.mjs`'s `ping` accepted any response, so use `probeHttp(url, { accept: () => true })`. `dialogue-lab.mjs`'s `ping` required `res.ok`, which is the default.
- **server/index.ts `siblingApi`:** `probeHttp(`http://127.0.0.1:${PORT}/api/health`, { accept: async (r) => r.ok && (await r.json())?.ok === true })`.
- Leave `server/docstore` alone (a deliberate fork).

### benhaus

- **Before editing:** CLAUDE.md applies. Check other sessions before editing shared files (`processes.ts` isn't on the shared list, `src/main/index.ts` is), then run `npm run check`. Nothing here adds a capability Ben can use in the window, so no new MCP tool is needed.
- **Main process:** use `externalizeDepsPlugin({ exclude: ["@btkulka/proc-kit"] })` in `electron.vite.config.ts` (main) so it's bundled into `out/main`.
- **`scripts/launch.cjs` runs unbundled inside the installed app** (`resources\app\scripts`, required by `mcp/bridge.cjs` with Benhaus.exe as Node). If it `require`s proc-kit, `package.cjs` must ship it.
  - `runtimePackages()` would copy `node_modules/@btkulka/proc-kit`, which is a **junction** to `D:\source\packages\proc-kit`, and `fs.cpSync` copies it as a link.
  - Copy linked packages dereferenced: copy `realpathSync(from)`'s `dist` and `package.json` into `resources\app\node_modules\@datrapscallion\proc-kit`.
  - Add `"../packages/proc-kit/dist"` to `INPUTS` so a package change makes the install stale.
  - Then verify `node scripts/launch.cjs update`, and the bridge starting Benhäus while it's closed.
  - If that's more than the migration wants, leave launch.cjs self-contained. Its copies are small.
- **launch.cjs mappings:**
  - `cleanEnv()` → `electronEnv({ remove: ["ELECTRON_RENDERER_URL"] })`, `alive` → `isAlive`.
  - The update lock → `writePidFile(LOCK)` / `readPidFile(LOCK)` / `removePidFile(LOCK)`. The JSON key is `startedAt`, not `at`, so update `updating()`'s 15-minute staleness check to read it.
  - `launch()` → `spawnDetached(exe, args, { cwd, env, windowsHide: false })`, and keep the `'exit'` listener.
- **`run.mjs`:** see the table. It no longer goes through `npx` or a shell.
- **`processes.ts`:**
  - `killTree` → `killTree`. It resolves a boolean; ignore it.
  - `portOpen(port)` → `probePort(port, { timeoutMs: 600 })`. With the default hosts a service on `::1` now counts as up, which is a fix; pass `host: "127.0.0.1"` to keep the old behaviour exactly.
  - `healthy()`'s fetch → `probeHttp(url, { timeoutMs: 1500, accept: (r) => r.status < 500 })`.
  - `portHolder` → `const [pid] = await pidsOnPort(port)`, then `(await listProcesses({ pid }))[0]?.name ?? "unknown"`. That's **~1.5 s** where tasklist took ~100 ms. It only runs after EADDRINUSE and from the `services:portHolder` IPC / MCP. If that's too slow for the IPC, keep the tasklist name lookup in benhaus.
  - Leave `stats()` (wmic) alone.
- **`standalone.ts` `startUpdate`:** `spawnDetached(process.execPath, [script, "update"], { cwd: source, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, log, logMode: "w", onError: (e) => end(…) })`. Keep the `'exit'` listener.
- **`launch.ts` `detached`:** `spawnDetached(command, [], { cwd, shell: true })`. It was `windowsHide: true` before too.
- **`claude.ts` `childEnv`:** `electronEnv({ remove: […Claude Code vars], set: { CLAUDE_AGENT_SDK_CLIENT_APP } })`. It now also drops `ATOM_SHELL_INTERNAL_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE` and `ELECTRON_OVERRIDE_DIST_PATH`.
- **`mcp/register.ts` `claudeExe`:** `findExecutable("claude.exe") ?? nativeBeside(findExecutable("claude.cmd"))`.
  - `where` listed every match and the old loop checked each one. `findExecutable` returns the first match only, so look for `claude.exe` first, as shown.
  - It's sync now, and the function no longer needs to be async.

### job-searcher

TS ESM compiled with tsc, plus `.mjs` scripts.

- **`src/open.ts`:** delete it, and import `openUrl` in `cli.ts` / `mcp.ts`. Windows now uses rundll32: URLs with `&` open intact (cmd's `start` cut them).
- **Detached Claude sessions** (`regen-now.ts`, `research-job.ts`, `send-run.ts`): `spawnDetached(bin, args, { cwd: PKG_ROOT, env, log, spawn: opts.spawn ?? loop.spawn })`.
  - The tests' stub goes in as the `spawn` option, and its shape fits.
  - Synchronous spawn errors still throw, so keep the try/catch (drop its `finally closeSync`; spawnDetached closes the fd).
  - Their own `'error'` / `'exit'` listeners still fire.
- **`isAlive` copies:** use `isAlive`, which works the same way.
- **`claudeBin`:** the env override first, then `findExecutable("claude.exe")`, then the native exe beside `findExecutable("claude.cmd")`.
- **`server.ts`:**
  - `dashboardUp` → `probeHttp(`http://127.0.0.1:${port}/api/stats`)`.
  - `ensureServer` → `spawnDetached(process.execPath, args, { cwd: PKG_ROOT })` + `waitForHttp(…, { timeoutMs, intervalMs: 250 })`.
  - `portOwner` becomes **async**: `pidsOnPort` + `listProcesses({ pid })` → `{ pid, command: p?.commandLine ?? "" }`. The old version threw a UserError when PowerShell failed. Now a failed lookup gives an empty command, which `dashboardKind` classes as `"other"`, so it still refuses to kill. Keep the message.
  - `portFreed` → `waitForPortFree(port, { timeoutMs: 10_000, intervalMs: 150 })`. That checks for no LISTENING socket rather than a refused connect on 127.0.0.1.
  - `process.kill(owner.pid)` → `killTree(owner.pid)`.
- **`scripts/dev.mjs`:** `runAndExit` + `packageBin("tsx", { from: root })` + `waitForHttp(url, { method: "HEAD", timeoutMs: 30_000, intervalMs: 300 })` → `openUrl`. Ctrl+C now waits for tsx to exit.
- **`scripts/cdp.mjs`:** another session was editing it. Coordinate, and only swap the Chrome spawn for `spawnDetached(CHROME, […flags, "about:blank"], { windowsHide: false })`. The same goes for `linkedin-send.mjs`.

### orson

- **`process-cleanup.ts`:**
  - `findListenerPid(port)` → `(await pidsOnPort(port))[0] ?? null`. Its callers (`runStart`, `runKill`, `ensureComfyRunning`) are async already.
  - `cleanupDevPorts` / `cleanupComfyPort` → `freePort`. In `start.ts`, drop the 1500 ms sleep and recheck: use `r.free`.
  - `findOrphanMcpServers` → `listProcesses()`, keeping rows whose `name` is `node.exe`/`electron.exe` (POSIX: `node`/`electron`) and whose `commandLine.replace(/\\/g, "/")` contains a marker. Exclude `process.pid`.
  - This is still one PowerShell call (~1.5 s), as before.
- **`strip-electron-env.ts`:** delete it; use `stripElectronEnv()` (same return). It also strips `ATOM_SHELL_INTERNAL_RUN_AS_NODE` and `ELECTRON_OVERRIDE_DIST_PATH` now.
- **`src/comfy/pidfile.ts`:** replace with `writePidFile(PID_FILE, { pid: child.pid, supervisorPid: process.pid })`, `readPidFile`, `removePidFile` and `isAlive`. The file becomes **JSON**.
  - An old 3-line file still reads, but as `{ pid, startedAt }` with **no `supervisorPid`**. Until it's rewritten, `desktop/main.ts` `comfyLifecycleStatus` reports it as unmanaged, and `comfy-doctor.ts` reads it the same way.
  - Its readers are supervisor.ts, desktop/main.ts ~L1725 and scripts/orson/comfy-doctor.ts.
- **`supervisor.ts` `stop()`:** `await killTree(child.pid, { graceMs: STOP_TIMEOUT_MS })` replaces `child.kill()` plus the 5 s timer. On Windows `child.kill()` was already an instant TerminateProcess of python alone, which could orphan its children.
- **`health.ts` `waitReady`:** `waitForHttp(`${url}/system_stats`, { timeoutMs: ceilingMs, intervalMs, requestTimeoutMs: intervalMs * 4, accept })`, with `accept` capturing `extractVram(await r.json())`. Throw the same message on false.
- **`dev.ts` and `bin/orson.mjs`:** `runAndExit` (see the table). A child killed by a signal now exits the wrapper with 1, where it used to re-raise the signal.
- **Leave the ELECTRON_RUN_AS_NODE=1 setters as they are.**

### clipdrift

CommonJS scripts; electron-vite main and worker.

- **`run-electron-vite.js`, `serve-headless.js`:** see the table. `ELECTRON_NO_ATTACH_CONSOLE` is now stripped too.
- **`serve-headless.js --detach`:** `spawnDetached(electronBin, spawnArgs, { env, log: path.join(os.tmpdir(), "clipdrift-headless.log") })`.
- **`launcher.ts` `stopComfyIfOwned`:** `killTree(pid, { graceMs: CONFIG.comfy.shutdownGraceMs })`. **The old Windows branch was not graceful.** Node maps `process.kill(pid, "SIGINT")` to TerminateProcess on Windows: no CTRL_BREAK, python only, children orphaned. Keep the owned/external logic and the piped spawn as they are.
- **The `findInPath` copies:** these are ffmpeg / ffprobe / realesrgan / yt-dlp lookups. If media-kit takes them over, they come through media-kit, which uses `findExecutable`. Otherwise call `findExecutable` directly.
  - It's synchronous with no 5 s `where` subprocess, and it doesn't search the cwd.
  - `ytdlp.ts` checked only `yt-dlp.exe` exactly on PATH. Now `.com`/`.bat`/`.cmd` shims are found too.
- **`orphanCleaner.ts`:** `listProcesses({ name })` instead of wmic. Rows give `executablePath` (missing for processes it can't inspect).
- **Electron bundling:** see General (externalizeDepsPlugin / electron-builder).

### candybar-manager

- **`scripts/run-electron-vite.mjs`:** `runAndExit(process.execPath, [packageBin("electron-vite"), ...args], { env: electronEnv() })`. npm scripts run in the repo root, so the default `from` works. There's no shell any more.
- **`tests/e2e/helpers.ts`:** Playwright's `electron.launch` wants `Record<string, string>`, so filter `undefined` out of `electronEnv(...)`.
- **`lib/youtubeDl.mjs` `findOnPath`:** `findExecutable(name)`, which is sync now. It may move to media-kit.

### norf-hampton-electron

- **`start-electron.js`:** `await waitForHttp("http://localhost:5174", { timeoutMs: 30_000, intervalMs: 200, requestTimeoutMs: 1000 })` (keep the "starting anyway" warning on false), then `runAndExit(require("electron"), ["."], { cwd, env: electronEnv({ set: { NODE_ENV: "development" } }) })`.
  - The old check wanted exactly 200; any 2xx counts now.
  - The old `close` handler exited 0 when Electron was killed by a signal; now that's 1.
- **`start-prod.js`:** `runAndExit(require("electron"), ["."], { cwd, env: electronEnv() })`.

### nhi-dashboard

CommonJS.

- **`src/site.js` `spawnPublish`:** `return spawnDetached(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, ...env }, log: LOG }).pid`.
- **`scripts/dev.js` is POSIX-only today.** `ps`, `lsof` and `process.kill(-pid)` all fail quietly on Windows, so `reap()` does nothing there. `stop()` kills only the `node --watch` wrapper (via the fallback), which leaves the server grandchild holding the port.
  - Use `listProcesses()` and `pidsOnPort(PORT)` in `reap()` (make the top level an async main), and `killTree(pid, { graceMs: 1500 })` for both reaping and shutdown.
  - Keep its argv-token matching rules.
  - Replace `p.ppid === 1` (orphan) with `p.ppid === 1 || !isAlive(p.ppid)`. On Windows an orphan keeps its dead parent's pid.
  - `browse()` → `openUrl(URL)`, unless `process.env.BROWSER` is set.
- **`scripts/chrome.js`:** `spawnDetached(findChrome(), args, { windowsHide: false })`.

### nhi/nhi-album-art-gen

Next.js route.

- **`POST`:** `spawnDetached("cmd.exe", ["/d", "/c", startBat], { cwd })`. The old code had `shell: true` on top of `cmd.exe /c`, a double shell. For python: `spawnDetached("python", [mainPy, …], { cwd })`. Keep `comfyProcess` and its `'close'` listener.
- **`DELETE`:** `kill("SIGTERM")` on Windows terminated only `cmd.exe`, leaving ComfyUI running on 8188. Use `await killTree(comfyProcess.pid)`, or `freePort(8188)`.
- **Next config:** put the package in `serverExternalPackages: ["@btkulka/proc-kit"]` so Next requires it at runtime instead of bundling a module from outside the project root.

### toejam

`app/server.mjs`, ESM.

- `portTaken()` → `probePort(PORT, { host: "127.0.0.1", timeoutMs: 1500 })`.
- `pidOnPort` → `(await pidsOnPort(port))[0] ?? null`. The old Windows parse only matched IPv4 rows.
- `waitFor(fn, ms, every)` → `waitFor(fn, { timeoutMs: ms, intervalMs: every })`. Both check first and then sleep. The old default `every` was 1000; the new default is 250.
- `process.kill(old.pid)` → `killTree(old.pid)`.
- `spawn("explorer.exe", [url])` → `openUrl(url)`.
- Keep `tdProcess` (tasklist window titles) and the `explorer /select` reveals.

### reddit-search-lists-app

- **`scripts/kill-stale.js`** (CommonJS, prestart): `require("@btkulka/proc-kit").freePort(PORT).then((r) => { if (r.killed.length) console.log(...) })`.
  - It now also finds IPv6 listeners, and waits up to 5 s for the port to be released before `npm start` continues.
  - It already used `/T`, so the tree behaviour is the same.

## Development

```sh
npm run build      # dist/esm + dist/cjs
npm run typecheck
npm test           # build, then node --test dist/esm/**/*.test.js
```

The tests use temp dirs, in-process servers and child `node` processes. The live port, kill and process-list tests call the OS's own tools: netstat, taskkill and PowerShell on Windows; lsof and ps on POSIX, where they're skipped if missing. No network and no other binaries are needed.
