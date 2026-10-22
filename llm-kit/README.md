# @btkulka/llm-kit

The transport and parsing layer under Ben's LLM calls. Apps keep their prompts, routing, budgets and validation. This package gives them the plumbing underneath:

- **Running the `claude` CLI.** It finds the real program behind the Windows npm shim, sends the prompt over stdin and parses `text`, `json` and `stream-json` output, including cost and session id. Timeouts and aborts kill the whole process tree. It can also start a detached run that logs to a file.
- **An OpenAI-compatible chat client** for koboldcpp, llama.cpp, LM Studio, vLLM and Ollama's `/v1`. It covers timeouts, empty-reply retries and GBNF grammars, the last ported from starfall with its traps fixed.
- **A native Ollama client** for chat (whole or streamed, with `<think>` hidden from the stream), embeddings and the installed-model list.
- **JSON out of model output.** It strips `<think>` and code fences, extracts balanced JSON while ignoring braces inside strings, salvages truncated arrays and repairs raw newlines and stray backslashes.
- **Routing by model string**, for example `ollama:rocinante-12b`.

There are no runtime dependencies. It builds ESM and CommonJS. Model names, URLs, ports, paths and env var names always come from the app.

| Entry | Use from | Contents |
|---|---|---|
| `@btkulka/llm-kit` | Node: Electron main, servers, scripts | everything |
| `@btkulka/llm-kit/json` | anywhere, including a browser renderer (no `node:*` imports) | `stripThinking`, `stripCodeFences`, `createThinkFilter`, `extractJson`, `extractJsonValues`, `repairJson`, `parseJsonLoose` |

## API

### Errors

Every call throws one class, `LlmError`, with a `kind` field:

| `kind` | Meaning | Extra fields |
|---|---|---|
| `http` | Non-2xx reply | `status`, `body` |
| `timeout` | The time limit ran out | |
| `aborted` | The caller's signal fired | |
| `unreachable` | The connection failed | |
| `empty` | The model returned no text | |
| `bad-response` | 2xx reply, but the wrong shape, or an Ollama error frame | |
| `not-found` | No claude CLI was found | |
| `spawn` | The CLI couldn't start | |
| `exit` | The CLI exited non-zero | `exitCode`, `stderr`, `stdout` |
| `result` | The CLI reported a failed turn | `result` |

`isLlmError(e, kind?)` narrows to it.

```ts
import { isLlmError } from "@btkulka/llm-kit";
try { … } catch (e) { if (isLlmError(e, "timeout")) … }
```

### Chat backends: one request shape

```ts
interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
interface ChatRequest {
  model: string;            // always from the app
  system?: string;          // goes in front of any system-role messages
  messages: ChatMessage[];
  temperature?: number;     // only sent when set
  maxTokens?: number;       // max_tokens / Ollama num_predict
  signal?: AbortSignal;
  timeoutMs?: number;       // whole call, streamed body included
  emptyRetries?: number;    // extra tries on an empty reply, default 0
  retryTemperatureStep?: number; // +0.15 per retry (only when temperature is set)
  allowEmpty?: boolean;     // return "" instead of throwing `empty`
}
interface ChatResult { text: string; usage: { in: number; out: number }; model?: string }
```

Usage is estimated (characters / 4) when a server doesn't report it.

#### `openAiChat(cfg, req): Promise<ChatResult>`

```ts
import { openAiChat } from "@btkulka/llm-kit";
const r = await openAiChat(
  { baseUrl: "http://127.0.0.1:5001/v1", apiKey, grammar: "D:/source/starfall/server/dialogue.gbnf", timeoutMs: 180_000, label: "local LLM" },
  { model: "rocinante-12b", system, messages: [{ role: "user", content: "Hi" }], maxTokens: 768, temperature: 0.8 },
);
r.text; r.usage; r.model; // r.model is the model the server says it served (koboldcpp reports the .gguf actually loaded)
```

`OpenAiConfig` fields:

- `baseUrl`: required. `/chat/completions` is appended.
- `apiKey`: sent as a Bearer token.
- `grammar`: one of:
  - `"json"`: sends `response_format: {type:"json_object"}`.
  - a path ending in `.gbnf`: sends the file's **contents** as `grammar`. The file is re-read when its mtime or size changes, CRLF becomes LF, and the last good text is kept if the file briefly disappears. A missing path is never sent as grammar text; it warns once per path through `onWarning`, which defaults to `console.error`.
  - any other string: sent as an inline GBNF grammar.
- `timeoutMs`: default timeout.
- `label`: names the server in error messages, e.g. `local LLM 503: …`. Default `LLM`.
- `onWarning`
- `fetch`: a stand-in for global fetch.

`grammarInfo(path?)` returns `{ path, mtimeMs, size, chars }` for the grammar file last used, or the one at `path`.

#### `ollamaChat(cfg, req): Promise<ChatResult>`

This uses Ollama's native `/api/chat`, because only the native endpoint takes per-call `num_ctx` and `num_gpu`.

```ts
import { ollamaChat, stripThinking } from "@btkulka/llm-kit";
const ollama = { baseUrl: process.env.OLLAMA_URL ?? "http://localhost:11434" };
const r = await ollamaChat(ollama, {
  model, messages, temperature: 0.8, emptyRetries: 1,
  options: { num_ctx: 8192, num_gpu: 99 },  // passed through; temperature and maxTokens are set on top
});
// Streamed: onDelta gets text outside <think>…</think>, even when a tag is split across chunks.
const s = await ollamaChat(ollama, { model, messages, onDelta: (t) => process.stdout.write(t), allowEmpty: true });
stripThinking(s.text); // the returned text still contains the think blocks
```

- The reply text is trimmed.
- Usage comes from `prompt_eval_count` and `eval_count`.
- An `{"error": …}` frame in the middle of a stream throws `bad-response`.
- `OllamaConfig` is `{ baseUrl, timeoutMs?, label? = "Ollama", fetch? }`.

#### `claudeCliChat(req): Promise<ClaudeChatResult>`

This is one chat turn through `claude -p`, so it runs on Ben's Claude subscription.

```ts
import { claudeCliChat } from "@btkulka/llm-kit";
const r = await claudeCliChat({ binEnvVar: "ORSON_CLAUDE_BIN", model: "sonnet", messages, onDelta });
r.text; r.usage; r.costUsd; r.sessionId;
```

- **Messages:** they're flattened the way orson did it, with `flattenForClaude(messages, system)`:
  - system messages are joined with blank lines into `--system-prompt`;
  - prior turns are written out under `=== Prior conversation ===`;
  - the last message is the current turn.
- **Prompt:** goes over stdin.
- **Defaults:** `tools: []` (none), `disableSlashCommands: true`, `noSessionPersistence: true`.
- **Output:** `json` when called without `onDelta`. With `onDelta`, it's `stream-json` with partial messages.
- `temperature` and `maxTokens` are accepted and ignored, because the CLI has neither.
- `permissionMode`, `allowedTools`, `disallowedTools`, `extraArgs`, `cwd`, `env`, `timeoutMs`, `signal` and `spawn` pass through to `runClaude`.

### The claude CLI

#### `runClaude(opts): Promise<ClaudeRunResult>`

```ts
import { runClaude } from "@btkulka/llm-kit";
const r = await runClaude({ prompt, outputFormat: "text", timeoutMs: 180_000 });
r.text;      // stdout trimmed (text); the result text for json/stream-json, or the streamed text if the result has none
r.result;    // the `result` event (json / stream-json): is_error, num_turns, duration_ms, usage, permission_denials…
r.sessionId; r.costUsd; r.exitCode; r.stdout; r.stderr;
```

These options control the run:

- `prompt`: required.
- `promptVia`: `"stdin"` (default) or `"arg"`.
  - stdin has no 32K command-line limit and no quoting problems.
  - `"arg"` puts the prompt right after `-p`, and stdin stays closed.
- `bin`: a path or name, or a resolved `{command, args}`.
- `binEnvVar`: the name of the app's env var for the CLI path.
- `cwd`
- `env`: laid over the inherited environment. An `undefined` value removes a variable.
- `keepSessionEnv`
- `timeoutMs`, `signal`: either one kills the **process tree**, with `taskkill /T /F` on Windows.
- `onEvent(event)`: called for every stream-json event.
- `onText(text)`: the reply as it's written. It gets token deltas with `includePartialMessages`, or each assistant message whole otherwise. Subagent text is skipped.
- `allowEmpty`
- `spawn`: a stand-in for `child_process.spawn`, for tests.

Every `claudeArgs` option is accepted too (see below).

**Errors:**

- No CLI throws `not-found`, and the message names `binEnvVar`.
- A failed result is `result`, checked before the exit code. The message is `claude: <result text>`.
- A non-zero exit is `exit`, with the message `claude exited N: <stderr>`.
- No text is `empty`.

**Environment:** by default the child doesn't inherit `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` or `ELECTRON_RUN_AS_NODE` (`INHERITED_SESSION_ENV_KEYS`). An app started from a Claude Code shell would otherwise pass its session to the child. `claudeEnv(extra?, { base?, keepSessionEnv?, platform? })` builds the same environment for other uses, such as the Agent SDK's `env` option. It ignores case on Windows, so `PATH` replaces an inherited `Path` instead of duplicating it.

#### `launchClaude(opts): ChildProcess`

This is the detached background run job-searcher uses. Its stdout and stderr are appended to `logFile`, whose folder is created. The child is `unref()`'d. Attach your own `exit` and `error` listeners.

```ts
import { launchClaude, resolveClaudeCommand } from "@btkulka/llm-kit";
const child = launchClaude({
  bin: resolveClaudeCommand({ envVar: "JOBHUNT_CLAUDE_BIN" }),
  prompt: "/job-research research", promptVia: "arg",
  outputFormat: "stream-json", permissionMode: "acceptEdits",
  disallowedTools: ["PowerShell"], allowedTools: ALLOWED_TOOLS,
  cwd: PKG_ROOT, env: { JOBHUNT_DB: db.name }, logFile,
});
child.on("exit", (code) => …);
```

Spawn options are `{ cwd, env, detached: true, stdio: [stdin, fd, fd], windowsHide: true }`. Stdin is `"ignore"` with `promptVia: "arg"`, otherwise a pipe that gets the prompt. Read the log back a line at a time with `parseStreamJsonLine`.

#### `probeClaude(opts?): Promise<{ ok, detail }>`

This runs `claude --version`. `detail` is the version line, or why the probe failed. It never throws.

#### `claudeArgs(opts): string[]`

The arguments always come in this order:

```text
-p [prompt] --output-format F [--verbose] [--include-partial-messages] [--model M] [--system-prompt S]
[--disable-slash-commands] [--no-session-persistence] [...extraArgs] [--permission-mode P] [--tools a,b]
[--disallowedTools …] [--allowedTools …]
```

- `--verbose` is always added for `stream-json`.
- `tools: []` sends `--tools ""`, which turns every tool off.
- The multi-value tool lists go last, so nothing can be mistaken for one of them.
- This order is what job-searcher's tests pin: `args.slice(2,10)` and `args.slice(10)`.

#### Finding the CLI: `resolveClaudeCommand({ bin?, envVar?, env?, platform? }): { command, args }`

The lookup order:

1. `bin`.
2. The `envVar` variable.
3. On Windows:
   1. each PATH folder's `claude.exe`, or the `node_modules\@anthropic-ai\claude-code\bin\claude.exe` an npm install puts there;
   2. a `claude.cmd`, looked through to the program it runs;
   3. `%USERPROFILE%\.local\bin\claude.exe`, where the native installer puts it.
4. On POSIX: `claude` on PATH, then `~/.local/bin/claude`, then `~/.claude/local/claude`.
5. Otherwise it throws `not-found`.

On Ben's machine it finds `C:\nvm4w\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.

`resolveCmdShim(path)` reads npm, pnpm and yarn shims, including a shim that calls another shim, and the 1.x-era `node cli.js` shim. If a `.cmd` still can't be read, the run goes through `cmd.exe /d /s /c` with cross-spawn's escaping. In that case it refuses any argument containing a newline (a `spawn` LlmError), because cmd can't carry one.

#### Output parsing

- `parseStreamJsonLine(line)`: returns a `ClaudeStreamEvent`, or `null` for blanks and stderr.
- `createLineSplitter(onLine)`: splits a stream into lines, handling chunk boundaries and CRLF.
- `parseClaudeJsonOutput(stdout)`: finds the result event in `--output-format json` output. That's a single object, or an array with `--verbose`, and the parser tolerates warning lines before it.
- `contentText(content)`
- `isErrorResult(result)`: true for `is_error`, or an `error_…` subtype.
- `resultErrorMessage(result)`

`ClaudeStreamEvent` is deliberately loose: one interface with optional `subtype`, `session_id`, `parent_tool_use_id`, `message`, `event`, `result`, `total_cost_usd`, `num_turns`, `duration_ms`, `usage`, `errors` and `permission_denials`, plus an index signature.

### JSON from model output (`/json`)

```ts
import { parseJsonLoose, extractJson, extractJsonValues, stripThinking, stripCodeFences } from "@btkulka/llm-kit/json";
parseJsonLoose('Sure! ```json\n{"mood":"calm"}\n``` hope that helps');  // { mood: "calm" }
parseJsonLoose(reply, "array");                                          // kind: "object" (default) | "array" | "any"
extractJson('The {template}: {"a":{"b":1}}');                            // '{"a":{"b":1}}'
extractJson(text, "array");                                              // first complete array, as a string
extractJsonValues('[{"a":1},{"b":2},{"c":');                             // [{a:1},{b:2}]  (salvage)
```

- `stripThinking(text)` removes closed `<think>…</think>` blocks in any case, then trims. An unclosed `<think>` is left alone, as orson did.
- `stripCodeFences(text)` returns the inside of the first ``` block (tagged `json` or untagged), or the trimmed text when there's no fence. These are orson's semantics.
- `createThinkFilter()` returns `{ push(chunk), flush() }`, the streaming counterpart of `stripThinking`. It holds back a tag split across chunks until it resolves.
- `extractJson(text, kind = "object")` returns the first complete value, balanced and string-aware.
  - It prefers the first candidate that parses.
  - If none parses, it returns the first balanced one, so the caller's own `JSON.parse` reports why.
  - It returns `null` when there's no complete value at all.
- `extractJsonValues(text, kind = "object")` returns every complete top-level value, parsed. It also looks inside a balanced value that doesn't parse, and inside a truncated wrapper.
- `repairJson(text)`: inside strings, raw control characters become escapes and a lone backslash becomes `\\`. Outside strings, stray control characters become spaces. Correct escapes are left alone.
- `parseJsonLoose(text, kind = "object")` does this:
  1. Strips think blocks.
  2. Tries the fenced block, then the whole text: first a whole parse, then `extractJson`.
  3. Repeats both after `repairJson`.
  4. Throws the original `SyntaxError`, or `No JSON object found in the model output`.

### Routing by model string

```ts
import { splitModelRef, LOCAL_MODEL_PREFIXES } from "@btkulka/llm-kit";
splitModelRef("ollama:qwen3:8b");   // { prefix: "ollama", model: "qwen3:8b" }
splitModelRef("claude-haiku-4-5");  // { prefix: null,     model: "claude-haiku-4-5" }
splitModelRef("qwen3:8b");          // { prefix: null,     model: "qwen3:8b" }   (only known prefixes are stripped)
```

The default prefixes are `ollama`, `local`, `llama` and `kobold`, which is starfall's set. Pass your own list as the second argument.

### Ollama embeddings and models

- `ollamaEmbed(cfg, text, { model, dims? })` returns `number[]`. Given `string[]`, it returns `number[][]`. It calls `/api/embed`. With `dims`, it throws `bad-response` on any other width.
- `ollamaListModels(cfg, { timeoutMs? })` returns `OllamaModel[]` (`{ name, digest, sizeBytes, modifiedAt, family, parameterSize, quantization }`), the same shape as orson's `RawOllamaModel`.
- `ollamaHasModel(installedNames, wanted)` matches the way Ollama resolves a name: exact, or `:latest` for an untagged name.

## Replaces

Paths are relative to `D:\source`. Line numbers are as of 2026-10-22.

| Repo | File | Function / lines | Replaced by |
|---|---|---|---|
| benhaus | `src/main/home.ts` | `writeBrief()` spawn block, lines 424-442 (`spawn("claude", ["-p","--output-format","text"], {shell:true, timeout:180_000})`) | `runClaude({ prompt, outputFormat: "text", timeoutMs: 180_000 })` |
| benhaus | `src/main/claude.ts` (**untracked: another session's in-progress work**) | `childEnv()`, lines 340-345 | `claudeEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: \`benhaus/${app.getVersion()}\` })`. The Agent SDK session itself stays (see below). |
| job-searcher | `src/research-job.ts` | `claudeBin()`, lines 59-70 | `resolveClaudeCommand({ bin: opts.bin, envVar: "JOBHUNT_CLAUDE_BIN" })` |
| job-searcher | `src/research-job.ts` | `launchResearchJob` spawn block, lines 316-334 (log fd, env, args, detached spawn, `closeSync`) | `launchClaude({ …, promptVia: "arg", logFile: log })` |
| job-searcher | `src/research-job.ts` | `StreamBlock` / `StreamEvent` types, lines 122-145; the `JSON.parse` in `logEntries`, lines 185-191 | `ClaudeContentBlock` / `ClaudeStreamEvent`; `parseStreamJsonLine(s) ?? raw` |
| job-searcher | `src/send-run.ts` | `step()` args + spawn, lines 228-241 | `launchClaude({ bin: loop.bin, spawn: loop.spawn, promptVia: "arg", logFile: run.log, … })` |
| job-searcher | `src/regen-now.ts` | `launchRegenNow` args + spawn, lines 106-120 | `launchClaude(...)` |
| orson | `src/claude-agent.ts` | whole file: `flatten`, `buildArgs`, `chat`, `chatStream`, `runClaude`, `claudeProbe`, `StreamEvent` | `claudeCliChat`, `flattenForClaude`, `probeClaude` |
| orson | `src/ollama.ts` | `buildOptions`, `chatOnce`, `chat` (empty retry), `chatStream`, `extractVisibleDelta`, `embed` | `ollamaChat`, `createThinkFilter` (inside it), `ollamaEmbed`. Keep `DEFAULT_CHAT_MODEL`, the env defaults and `getEmbedModel`. |
| orson | `src/model-cleanup.ts` | whole file: `stripThinking`, `stripCodeFences`, `extractFirstJsonObject`, `extractFirstJsonArray` | `stripThinking`, `stripCodeFences`, `extractJson(x)`, `extractJson(x, "array")` |
| orson | `src/preflight.ts` | `pingOllama` 34-43, `listModels` 45-52, `modelMatches` 54-58 | `ollamaListModels(cfg, { timeoutMs })`, `ollamaHasModel`. `claudeProbe` becomes `probeClaude`. |
| orson | `src/ollama/manager.ts` | `OllamaManager.list()`, lines 107-121 | `ollamaListModels`. It returns the same shape as `RawOllamaModel`. |
| orson | `test/helpers/ollama-probe.ts` | `isOllamaReachable` | `ollamaListModels({ baseUrl }, { timeoutMs }).then(() => true, () => false)`, or proc-kit's `probeHttp` |
| orson | `src/servers/rules-core.ts` | `parseIntentResponse`, line 236 (lazy `\{[\s\S]*?\}`) | `extractJson(stripThinking(raw))` |
| orson | `src/servers/narrator.ts` | `parseSuggestionsResponse`, lines 435-437 (think regex + greedy `{…}`) | `extractJson(stripThinking(raw))` |
| orson | `src/training/grade-dm-core.ts` | `tryPretty`, lines 282-292 | `extractJson(stripThinking(stripCodeFences(raw)))` then `JSON.stringify(JSON.parse(s), null, 2)` |
| orson | `scripts/train/view-dm.ts` | `tryPretty`, lines 79-92 | same as above |
| orson | `src/desktop/renderer/TrainDmScreen.tsx` | `prettyJson`, lines 782-792 (renderer) | same as above, imported from **`@btkulka/llm-kit/json`** |
| orson | `scripts/train/audit.ts` | `tryParseResolveBody`, lines 50-60 (fence + think regex) | `JSON.parse(stripCodeFences(stripThinking(raw)))` |
| orson | `src/image/landscape-question.ts:51`, `src/audio/ambience-question.ts:52` | inline `<think>` regex in `cleanLine` | `stripThinking(raw)`. The fence-removal regex stays: it drops fenced blocks, which is different from `stripCodeFences`. |
| orson | importers of `model-cleanup.js`: `src/servers/dm.ts`, `narrator-core.ts`, `lore-gate.ts`, `character.ts`, `rules-core.ts`, `narrator.ts`, `src/desktop/main.ts` (2383-2405), `src/training/grade-dm-core.ts`, `scripts/train/eval-dm.ts`, `scripts/train/build-dataset.ts` | imports | import from `@btkulka/llm-kit` (or `/json`) |
| starfall | `server/localLlm.ts` | whole file: `resolveGrammar`, `grammarInfo`, `localChat`, `bareModel`, `providerOf` | `openAiChat`, `resolveGrammar`, `grammarInfo`, `splitModelRef` |
| starfall | `server/aiBudget.ts` | `providerOf` 53-55, `bareModelId` 58-61 | `splitModelRef(model).prefix ? "local" : "anthropic"`, `splitModelRef(model).model` |
| starfall | `server/context.ts` | `localProvider` 288-302, `dialogueProvider` regex 309-312 | `openAiChat` (or a thin `localChat` wrapper), `splitModelRef` |
| starfall | `server/routes/dialogue.ts` | `runComposeBrief` direct `localChat`, lines 2170-2190; `grammarInfo` import (5, 459) | `openAiChat` with no `grammar`; `grammarInfo()` from the package |
| starfall | `server/utils/parseJsonLoose.ts` | `parseJsonLoose` | `parseJsonLoose`. `CONTROL_CHARS` stays in starfall, where `routes/dialogue.ts:480` uses it. |
| starfall | `server/dialogueTree.ts` | `extractJson`, lines 140-148 | `parseJsonLoose` |
| starfall | `tools/gen-persona-beats.mts` | `MODEL` prefix regex (39), `callModel` (146-158), `tryArray` (161-176), `extractObjects` (179-194) | `splitModelRef(...).model`, `openAiChat(..., { allowEmpty: true })`, `extractJson(text, "array")`, `extractJsonValues(text)` |
| starfall | `tools/consolidate-beat-trees.mts` | `MODEL` (49), `callModel` (255-266), `extractObjects` (270-285) | same as above |
| starfall | `tools/reembed-memory.mts` | `preflight` `/api/embed` + 768 check, lines 54-77 | `ollamaEmbed({ baseUrl: OLLAMA_URL }, "preflight", { model, dims: 768 })`, mapping `unreachable`/`http` to its messages |
| starfall | `tools/dev-prep.mjs` | `/api/tags` check, lines 93-103 | `ollamaListModels` + `ollamaHasModel` |
| starfall | `server/localLlm.test.ts` | the grammar tests | covered by this package's `openai.test.ts` "grammar" suite. Keep them only if a `localChat` wrapper remains. |

## Migration notes

### benhaus

**`src/main/home.ts` `writeBrief()`:**

```ts
const r = await runClaude({ prompt, outputFormat: "text", timeoutMs: 180_000 }).then(
  (x) => ({ ok: true as const, text: x.text }),
  (e: LlmError) => ({ ok: false as const, err: e.stderr || e.message }),
);
```

Keep the existing `fail("Claude", "Claude couldn't write the brief: " + err.slice(0,160))` wording.

There's no `shell: true` any more:

- claude.exe is spawned directly.
- The timeout now kills claude and its children. Node's own spawn timeout used to kill only the `cmd.exe` in front of it, which left claude running.
- `CLAUDECODE` is no longer inherited. Benhäus is often launched from a Claude Code shell by `/launch-benhaus`.

**`src/main/claude.ts`:** this file is **untracked, another session's in-progress work**. Coordinate before you edit it. Only `childEnv()` moves. The Agent SDK session (Inbox, permission asks, transcript mapping) is app logic and stays.

**Bundling:** Benhäus is built with electron-vite. Make sure `@btkulka/llm-kit` reaches the packaged main process: inline it, excluding it from `externalizeDepsPlugin`, or check that electron-builder copies the linked folder.

### job-searcher

- Delete `claudeBin()`.
- Where it was called (`launchResearchJob`, `launchSendRun`, `launchRegenNow`), resolve first so a missing CLI still fails before anything is claimed or saved:

  ```ts
  let bin: ClaudeCommand;
  try { bin = resolveClaudeCommand({ bin: opts.bin, envVar: "JOBHUNT_CLAUDE_BIN" }); }
  catch (e) { throw new UserError((e as Error).message); }   // regen-now: return { launched: false, error }
  ```

- Replace each `openSync`/spawn/`closeSync` block with:

  ```ts
  launchClaude({
    bin, spawn: opts.spawn,
    prompt: PROMPT, promptVia: "arg",
    outputFormat: "stream-json", permissionMode: "acceptEdits",
    disallowedTools: ["PowerShell"], allowedTools: ALLOWED_TOOLS,
    cwd: PKG_ROOT, env: db.name && db.name !== ":memory:" ? { JOBHUNT_DB: db.name } : {},
    logFile: log,
  })
  ```

  - `promptVia: "arg"` keeps the exact argv the tests assert: `args[0..1]`, `slice(2,10)` and `slice(10)`.
  - The injected `spawn` still receives `(bin, args, { cwd, env, detached: true, windowsHide: true, stdio })`.
  - `launchClaude` creates the log folder, so the `mkdirSync` calls can go.
  - It calls `unref()` itself. A second `unref()` is harmless.
- `send-run.ts`'s `Loop.bin` type changes from `string` to `string | ClaudeCommand`.
- `logEntries` and `readJobLog` stay; they're presentation. Swap the local `StreamEvent` type for `ClaudeStreamEvent`, and the `JSON.parse` try/catch for `parseStreamJsonLine(s)`. That returns null for non-JSON lines, so keep the `raw` fallback.
- **Behaviour differences:**
  - The child no longer inherits `CLAUDECODE` and the other session variables when the server was started from Claude Code.
  - The not-found message is now `cannot find the \`claude\` CLI on PATH. Install Claude Code or set JOBHUNT_CLAUDE_BIN to its path.`

### orson

**`src/claude-agent.ts`** becomes a few lines, or `llm.ts` calls the package directly:

```ts
const model = (o: { model?: string }) => o.model ?? process.env.ORSON_CLAUDE_MODEL ?? "sonnet";
export const chat = async (m, o = {}) => (await claudeCliChat({ binEnvVar: "ORSON_CLAUDE_BIN", model: model(o), messages: m })).text;
export const chatStream = async (m, onDelta, o = {}) => (await claudeCliChat({ binEnvVar: "ORSON_CLAUDE_BIN", model: model(o), messages: m, onDelta })).text;
export const claudeProbe = () => probeClaude({ binEnvVar: "ORSON_CLAUDE_BIN" });
```

What changes:

- The prompt now goes over **stdin**. Before, it was the last argument, so a long history could hit the 32K Windows command-line limit.
- A plain `spawn("claude")` used to fail with ENOENT on Ben's machine, where `claude` is an npm `.cmd` shim, unless `ORSON_CLAUDE_BIN` was set. claude.exe is now found automatically.
- `ORSON_CLAUDE_BIN` is read at call time, not at import.
- Non-streaming calls use `--output-format json` instead of `text`. The text is the same, but `is_error` results are now caught.
- A streamed error result's message is now `claude: <text>`, with kind `result`. It used to be `claude result error: <text>`.
- Stream text is decoded as UTF-8 across chunk boundaries. `d.toString()` per chunk could break a character that was split between chunks.

**`src/ollama.ts`:** keep the env defaults and `DEFAULT_CHAT_MODEL`, and replace the transport:

```ts
const OLLAMA = { baseUrl: OLLAMA_URL };
const opts = (o) => ({ temperature: o.temperature ?? 0.8, options: { num_ctx: o.numCtx ?? DEFAULT_NUM_CTX, num_gpu: o.numGpu ?? DEFAULT_NUM_GPU } });
export const chat = async (messages, o = {}) => (await ollamaChat(OLLAMA, { model: o.model ?? OLLAMA_MODEL, messages, ...opts(o), emptyRetries: 1 })).text;
export const chatStream = async (messages, onDelta, o = {}) => (await ollamaChat(OLLAMA, { model: o.model ?? OLLAMA_MODEL, messages, ...opts(o), onDelta, allowEmpty: true })).text;
export const embed = (text: string, model?: string) => ollamaEmbed(OLLAMA, text, { model: model ?? OLLAMA_EMBED_MODEL });
```

What changes:

- `allowEmpty: true` on streams keeps the old behaviour of returning `""`, which `narrate()` relies on for its own retry. Without it, an empty stream throws `empty`.
- The streamed result is now trimmed.
- The think filter now also catches a tag split across chunks.
- An `{"error":…}` stream frame now throws instead of being skipped.
- The empty-retry message is now `Ollama returned no content (after 1 retry)`.
- **Embeddings** now go through `/api/embed` instead of the deprecated `/api/embeddings`.
  - `/api/embed` returns L2-normalized vectors.
  - lore-core searches with `distanceType("cosine")`, so ranking against vectors already stored is unchanged.
  - The zero-vector Claude mode is untouched.

**`src/model-cleanup.ts`:** delete it.

- `stripThinking` and `stripCodeFences` behave identically.
- `extractFirstJsonObject(x)` becomes `extractJson(x)`. It is now balanced: nested objects used to be cut at the first `}`, and now they work.
- `extractFirstJsonArray(x)` becomes `extractJson(x, "array")`. It used to be greedy from the first `[` to the last `]`.
- `extractJson` returns the first candidate that *parses*. A caller that logged "no JSON" versus "parse failed" separately now hits the "parse failed" branch only for a balanced candidate that doesn't parse.
- Keep strict whole-reply parsing where a grader scores clean output: `parsedOk` in `grade-dm-core.ts`, `dm.ts` `resolve_turn`, `desktop/main.ts`. Don't switch those to `parseJsonLoose`, or the grades inflate.
- The renderer (`TrainDmScreen.tsx`) imports from `@btkulka/llm-kit/json`.

**`preflight.ts`, `ollama/manager.ts`:** see the table.

- `OllamaManager.probe/pull/remove` and `RECOMMENDED_OLLAMA_MODELS` stay.
- `scripts/orson/start.ts` `unloadOllamaModels` stays.

**`llm.ts`** keeps its env routing: `ORSON_LLM_PROVIDER` and `ORSON_<AGENT>_PROVIDER`.

**Bundling:** orson already ships `comfy-client` and `lore-core`. Do the same for this package.

### starfall

**`server/localLlm.ts`:** either delete it and call `openAiChat` from `context.ts` and `dialogue.ts`, or keep `localChat` as a thin wrapper so `aiBudget`'s `LocalProvider` contract (`{ok, text, usage, servedModel} | {ok:false, error}`) is untouched:

```ts
try {
  const r = await openAiChat({ baseUrl, apiKey, grammar, timeoutMs: timeoutMs ?? 90_000, label: "local LLM" },
                             { model, system, messages, maxTokens, temperature: temperature ?? 0.8 });
  return { ok: true, text: r.text, usage: r.usage, servedModel: r.model };
} catch (e) { return { ok: false, error: (e as Error).message }; }
```

Error text changes:

| Case | Before | After |
|---|---|---|
| timeout | `local LLM timed out` | `local LLM timed out after 180000ms` |
| empty | `local LLM returned empty content` | `local LLM returned no content` |

The HTTP and unreachable messages are unchanged.

Other differences:

- An empty `system` is no longer sent as an empty system message.
- The grammar warning now reads `[llm-kit] … UNCONSTRAINED …`. Pass `onWarning` to keep starfall's wording.
- `grammarInfo()` keeps its signature.

**`parseJsonLoose`** is the package's.

- It now strips `<think>` first.
- It picks the first *complete* object that parses instead of slicing from the first `{` to the last `}`.
- Its repair is string-aware. A raw newline inside a string value now becomes a real `\n` in the parsed value. Before, it became a space.
- `[ {…} ]` still yields the first object.
- `dialogueTree.ts` `extractJson` gains repair and think-stripping.

**Tools:** `callModel` returned `""` on an empty reply, so pass `allowEmpty: true`.

- `tryArray(text)` becomes:

  ```ts
  const s = extractJson(text, "array");
  return s ? JSON.parse(s) : null;
  ```

  Guard the `JSON.parse` with try/catch, as `tryArray` did.
- `extractObjects` becomes `extractJsonValues`. It now also salvages objects inside a truncated `{"beats":[…` wrapper, where the old copy returned `[]`.

**`tools/dev-prep.mjs`:** `ollamaHasModel` treats an untagged name as `:latest`, the way Ollama resolves it. The old check accepted any tag. For `nomic-embed-text:latest` the result is the same.

**Unchanged:** the governor (rate windows, eligibility, cost via `costOf`) and the `@anthropic-ai/sdk` call in `aiBudget.ts`. `routes/ai.ts` `localReachable` and `tools/ensure-kobold.mjs` are service probes; use proc-kit's `probeHttp` if you like.

### lore-core

Not changed, as the brief asked. Its `ollamaEmbedder` (`src/embed.ts`) calls `/api/embed` just like `ollamaEmbed`. A later change could make it delegate.

## Not shared, and why

- **Anthropic SDK calls.** These are starfall `server/aiBudget.ts` `messages.create` and ableton-extensions-store `cli/templates/ai-device/node/main.js`. The SDK is already the shared client, and starfall has a single call site. The ableton file is a scaffold template copied into buyers' projects, so it can't depend on a private package.
- **One full provider router.** Both apps route, but on different keys to different pairs:
  - orson: env vars per agent, choosing between Ollama and the claude CLI;
  - starfall: model-string prefix, choosing between the Anthropic SDK and OpenAI-compatible.
  
  The backends and `splitModelRef` are shared. The routing decision stays in each app.
- **job-searcher's log presentation** (`logEntries`, `logText`, `readJobLog`, `fmtElapsed`) and the run/job state machines: app UI and logic.
- **benhaus's Agent SDK chat session:** app logic, a single app, and in progress.
- **Ollama model lifecycle** (pull, delete, unload, the recommended catalog) and **reachability probes** (orson `pingOllama` / `ollama-probe.ts`, starfall `localReachable`, `ensure-kobold.mjs`): these are lifecycle and health concerns, not LLM calls. Generic probes are proc-kit's `probeHttp`.
- **OpenAI-compatible streaming:** no app streams through `/chat/completions`. orson streams through Ollama's native API.
- **starfall `server/docstore/embed.ts`:** a deliberate fork, left alone.
- **Python:** none. orson `scripts/train/train-dm.py` only exports a GGUF and makes no LLM calls.
- **Survey false positives** with no LLM plumbing:
  - clipdrift `src/main/services/acquisition/ytdlpFetch.ts` matched on yt-dlp's `--merge-output-format`;
  - starfall `tools/dialogue-lab.mjs` and `cli/commands/generate.mjs` matched on their own `--print` flag;
  - candybar-manager `scripts/legacy/copy-onhold.mjs` reads its own JSON files;
  - job-searcher `src/run-notes.ts` matched on the note author "claude";
  - nhi-album-art-gen's `/api/generate` is its own route.

## Development

```text
npm run build       # ESM (dist/esm) + CommonJS (dist/cjs)
npm run typecheck
npm test            # builds, then node --test dist/esm/**/*.test.js
```

The tests use fake `fetch` responses, a fake `claude` written as a node script (in a temp dir), temp-dir shims, and real `cmd.exe` for the Windows shim round trip. Nothing touches the network.

`LLM_KIT_REAL_CLAUDE=1 npm test` also resolves the installed CLI and runs `claude --version`. That costs no tokens.
