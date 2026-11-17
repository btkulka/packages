// @btkulka/runpod-client: rent a GPU by the minute on RunPod, guarded.

export { createRunPodClient, proxyUrl, sseLines, RUNPOD_API } from "./client.js";
export type { RunPodClient, RunPodClientOptions, GpuType, Pod, PodStatus, Cloud, CreatePodBody, ExecResult } from "./client.js";
export { RunPodError, isRunPodError } from "./errors.js";
export type { RunPodErrorCategory } from "./errors.js";
export { planRental, rent, sweep, spawnWatchdog, waitForPodHttp, POD_PREFIX, WATCHDOG_SCRIPT } from "./rental.js";
export type { Plan, PlanOptions, Candidate, Rental, RentOptions } from "./rental.js";
export { loadRunPodKey, readCliConfigKey, DEFAULT_CREDENTIAL, KEY_ENV, CLI_CONFIG } from "./key.js";
