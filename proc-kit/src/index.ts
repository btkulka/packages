// @btkulka/proc-kit: process and dev tooling for Ben's apps. Node only.

export { pidsOnPort, pidsOnPortSync, probePort, waitForPort, waitForPortFree, freePort } from "./ports.js";
export type { ProbePortOptions, WaitForPortOptions, WaitForPortFreeOptions, FreePortOptions, FreePortResult } from "./ports.js";

export { killTree, killTreeSync, isAlive } from "./kill.js";
export type { KillTreeOptions } from "./kill.js";

export { spawnDetached, runAndExit, openUrl } from "./spawn.js";
export type { SpawnDetachedOptions, RunAndExitOptions } from "./spawn.js";

export { sleep, waitFor, probeHttp, waitForHttp } from "./wait.js";
export type { WaitOptions, ProbeHttpOptions, WaitForHttpOptions } from "./wait.js";

export { electronEnv, stripElectronEnv, ELECTRON_ENV_KEYS } from "./env.js";
export type { ElectronEnvOptions } from "./env.js";

export { findExecutable } from "./which.js";
export type { FindExecutableOptions } from "./which.js";

export { packageBin } from "./bin.js";
export type { PackageBinOptions } from "./bin.js";

export { listProcesses } from "./processes.js";
export type { ProcessInfo, ListProcessesFilter } from "./processes.js";

export { writePidFile, readPidFile, removePidFile } from "./pidfile.js";
export type { PidFileData, PidFileEntry } from "./pidfile.js";
