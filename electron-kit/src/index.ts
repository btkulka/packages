// @btkulka/electron-kit: what main and preload share. No Electron, no
// Node built-ins, safe in any process. Process code lives in the subpaths:
// "@btkulka/electron-kit/main" and "@btkulka/electron-kit/preload".

export type {
  AnyIpc,
  EventChannel,
  EventPayload,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  IpcSchema,
  SendArgs,
  SendChannel,
  Unsubscribe,
} from "./ipc-schema.js";
export { WINDOW_ACTIONS, isWindowAction, windowChannels } from "./window-actions.js";
export type { WindowAction, WindowChannels } from "./window-actions.js";
