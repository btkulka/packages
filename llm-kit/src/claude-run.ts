/**
 * Running `claude -p`: once and wait for the answer (runClaude), or detached in the background
 * with its output appended to a log file (launchClaude).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { killTree as killProcessTree } from "@btkulka/proc-kit";
import { claudeArgs, type ClaudeArgsOptions } from "./claude-args.js";
import { claudeEnv } from "./claude-env.js";
import { resolveClaudeCommand, spawnSpec, type ClaudeCommand } from "./claude-resolve.js";
import {
  contentText,
  createLineSplitter,
  isErrorResult,
  parseClaudeJsonOutput,
  parseStreamJsonLine,
  resultErrorMessage,
  type ClaudeStreamEvent,
} from "./claude-stream.js";
import { LlmError } from "./errors.js";

/** child_process.spawn, or a stand-in for tests. */
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeProcessOptions {
  /** The claude program: a path or name, or a resolved command. Default: resolveClaudeCommand. */
  bin?: string | ClaudeCommand;
  /** Environment variable that may hold the path (ORSON_CLAUDE_BIN). */
  binEnvVar?: string;
  cwd?: string;
  /** Laid over the inherited environment; an undefined value removes a variable. */
  env?: Record<string, string | undefined>;
  /** Keep CLAUDECODE and the other inherited session variables (see claudeEnv). Default false. */
  keepSessionEnv?: boolean;
  /** Stands in for child_process.spawn (tests). */
  spawn?: SpawnLike;
}

export interface ClaudeRunOptions extends ClaudeProcessOptions, Omit<ClaudeArgsOptions, "prompt"> {
  prompt: string;
  /** "stdin" (default): written to stdin, no length or quoting limits. "arg": positional after -p. */
  promptVia?: "stdin" | "arg";
  /** Kill the process (and its children) and reject with a `timeout` LlmError after this long. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stream-json: every event as it arrives. */
  onEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * stream-json: the reply's text as it's written: token deltas with includePartialMessages,
   * otherwise each assistant message whole. Subagent text is left out.
   */
  onText?: (text: string) => void;
  /** Resolve with "" instead of rejecting with an `empty` LlmError. */
  allowEmpty?: boolean;
}

export interface ClaudeRunResult {
  /** The reply: stdout for text; the result's text for json/stream-json (the streamed text if the result has none). */
  text: string;
  /** The `result` event (json / stream-json). */
  result?: ClaudeStreamEvent;
  sessionId?: string;
  costUsd?: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function commandFor(o: ClaudeProcessOptions): ClaudeCommand {
  if (typeof o.bin === "object") return o.bin;
  return resolveClaudeCommand({ bin: o.bin, envVar: o.binEnvVar });
}

type PromptOptions = Omit<ClaudeArgsOptions, "prompt"> & { prompt: string; promptVia?: "stdin" | "arg" };

function argsFor(o: PromptOptions): string[] {
  return claudeArgs({
    prompt: o.promptVia === "arg" ? o.prompt : undefined,
    outputFormat: o.outputFormat,
    verbose: o.verbose,
    includePartialMessages: o.includePartialMessages,
    model: o.model,
    systemPrompt: o.systemPrompt,
    disableSlashCommands: o.disableSlashCommands,
    noSessionPersistence: o.noSessionPersistence,
    extraArgs: o.extraArgs,
    permissionMode: o.permissionMode,
    tools: o.tools,
    disallowedTools: o.disallowedTools,
    allowedTools: o.allowedTools,
  });
}

/**
 * Ends a process and everything it started (claude runs MCP servers and tool shells): taskkill /T
 * on Windows. A child from an injected spawn (a test fake) only gets child.kill(), so a fake pid
 * can never take a real process down with it.
 */
function killTree(child: ChildProcess, injected: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!injected && process.platform === "win32" && child.pid) {
    void killProcessTree(child.pid).then((ok) => {
      if (!ok) child.kill();
    });
    return;
  }
  child.kill("SIGTERM");
}

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Runs claude once and resolves with its reply. Rejects with an LlmError: `not-found` (no CLI),
 * `spawn`, `timeout`, `aborted`, `result` (the CLI reported a failed turn), `exit` (non-zero exit,
 * with the stderr), or `empty`.
 */
export function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const spawnFn = o.spawn ?? (nodeSpawn as SpawnLike);
  const format = o.outputFormat ?? "text";
  return new Promise<ClaudeRunResult>((resolve, reject) => {
    if (o.signal?.aborted) return reject(new LlmError("aborted", "claude run aborted"));
    let child: ChildProcess;
    try {
      const spec = spawnSpec(commandFor(o), argsFor(o));
      child = spawnFn(spec.file, spec.args, {
        cwd: o.cwd,
        env: claudeEnv(o.env, { keepSessionEnv: o.keepSessionEnv }),
        stdio: [o.promptVia === "arg" ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (e) {
      return reject(e instanceof LlmError ? e : new LlmError("spawn", `couldn't start claude: ${(e as Error).message}`, { cause: e }));
    }

    let stdout = "";
    let stderr = "";
    let result: ClaudeStreamEvent | undefined;
    let sessionId: string | undefined;
    let streamed = "";
    let deltaSinceMessage = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err: LlmError | null, value?: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => {
      killTree(child, Boolean(o.spawn));
      finish(new LlmError("aborted", "claude run aborted", { stdout, stderr }));
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.timeoutMs !== undefined && o.timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child, Boolean(o.spawn));
        finish(new LlmError("timeout", `claude timed out after ${o.timeoutMs}ms`, { stdout, stderr }));
      }, o.timeoutMs);
    }

    const onEvent = (ev: ClaudeStreamEvent) => {
      o.onEvent?.(ev);
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.parent_tool_use_id) return;
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta" && typeof ev.event.delta.text === "string") {
        streamed += ev.event.delta.text;
        deltaSinceMessage = true;
        o.onText?.(ev.event.delta.text);
      } else if (ev.type === "assistant") {
        // No deltas for this message (partial messages off, or the CLI skipped them): pass it on whole.
        if (!deltaSinceMessage) {
          const text = contentText(ev.message?.content);
          if (text) {
            streamed += text;
            o.onText?.(text);
          }
        }
        deltaSinceMessage = false;
      } else if (ev.type === "result") result = ev;
    };
    const lines = createLineSplitter((line) => {
      const ev = parseStreamJsonLine(line);
      if (ev) onEvent(ev);
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      stdout += s;
      if (format === "stream-json") lines.push(s);
    });
    child.stderr?.on("data", (s: string) => (stderr += s));
    child.on("error", (e: NodeJS.ErrnoException) => {
      const kind = e.code === "ENOENT" ? "not-found" : "spawn";
      const hint = kind === "not-found" ? (o.binEnvVar ? ` Install Claude Code or set ${o.binEnvVar}.` : " Install Claude Code.") : "";
      finish(new LlmError(kind, `couldn't start claude: ${e.message}.${hint}`, { cause: e, stdout, stderr }));
    });
    child.on("close", (code) => {
      if (format === "stream-json") lines.end();
      if (format === "json") {
        result = parseClaudeJsonOutput(stdout) ?? undefined;
        if (result?.session_id) sessionId = result.session_id;
      }
      const details = { exitCode: code, stdout, stderr, result };
      if (result && isErrorResult(result)) return finish(new LlmError("result", `claude: ${resultErrorMessage(result)}`, details));
      if (code !== 0) return finish(new LlmError("exit", `claude exited ${code}: ${clip(stderr.trim() || stdout.trim() || "(no output)")}`, details));
      const text = format === "text" ? stdout.trim() : (result?.result ?? "").trim() || streamed.trim();
      if (!text && !o.allowEmpty) return finish(new LlmError("empty", "claude returned no content", details));
      finish(null, {
        text,
        result,
        sessionId,
        costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    if (o.promptVia !== "arg" && child.stdin) {
      child.stdin.on("error", () => undefined); // claude exiting early closes the pipe; 'close' reports it
      child.stdin.end(o.prompt, "utf8");
    }
  });
}

export interface ClaudeLaunchOptions extends ClaudeProcessOptions, Omit<ClaudeArgsOptions, "prompt"> {
  prompt: string;
  /** "stdin" (default) or "arg" (positional after -p; what job-searcher's tests expect). */
  promptVia?: "stdin" | "arg";
  /** stdout and stderr are appended here. Its folder is created. */
  logFile: string;
}

/**
 * Starts claude detached in the background, output appended to `logFile` (use stream-json to tail
 * it with parseStreamJsonLine), and returns the child, already unref'd so it doesn't keep this
 * process alive. Attach 'exit'/'error' listeners to learn how it ended. Spawn failures throw; a
 * missing CLI is a `not-found` LlmError.
 */
export function launchClaude(o: ClaudeLaunchOptions): ChildProcess {
  const spawnFn = o.spawn ?? (nodeSpawn as SpawnLike);
  const spec = spawnSpec(commandFor(o), argsFor(o));
  mkdirSync(dirname(o.logFile), { recursive: true });
  const fd = openSync(o.logFile, "a");
  let child: ChildProcess;
  try {
    child = spawnFn(spec.file, spec.args, {
      cwd: o.cwd,
      env: claudeEnv(o.env, { keepSessionEnv: o.keepSessionEnv }),
      detached: true,
      stdio: [o.promptVia === "arg" ? "ignore" : "pipe", fd, fd],
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
    });
  } finally {
    closeSync(fd);
  }
  if (o.promptVia !== "arg" && child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(o.prompt, "utf8");
  }
  child.unref?.();
  return child;
}

/** `claude --version`: whether the CLI is installed and runs. Never throws. */
export async function probeClaude(o: ClaudeProcessOptions & { timeoutMs?: number } = {}): Promise<{ ok: boolean; detail: string }> {
  const spawnFn = o.spawn ?? (nodeSpawn as SpawnLike);
  let spec;
  try {
    spec = spawnSpec(commandFor(o), ["--version"]);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const end = (r: { ok: boolean; detail: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawnFn(spec.file, spec.args, {
        cwd: o.cwd,
        env: claudeEnv(o.env, { keepSessionEnv: o.keepSessionEnv }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (e) {
      return resolve({ ok: false, detail: (e as Error).message });
    }
    const timer = setTimeout(() => {
      killTree(child, Boolean(o.spawn));
      end({ ok: false, detail: `claude --version timed out after ${o.timeoutMs ?? 15_000}ms` });
    }, o.timeoutMs ?? 15_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => (out += s));
    child.stderr?.resume();
    child.on("error", (e) => end({ ok: false, detail: e.message }));
    child.on("close", (code) => {
      const lines = out.trim().split(/\r?\n/);
      if (code !== 0) end({ ok: false, detail: `claude --version exited ${code}` });
      else end({ ok: true, detail: lines[lines.length - 1]?.trim() || out.trim() });
    });
  });
}
