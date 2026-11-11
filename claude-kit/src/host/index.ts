// @btkulka/claude-kit/host: the chats themselves, in the app's Node side (an
// Electron main process or a server). One ChatHost per app; hand it to a
// transport (../electron/main or ../http) and the screens follow it.

export { ChatHost, type ChatHostOptions, type ChatNotice } from "./host.js";
export { ImageStore, SENDABLE, MAX_SEND_BYTES, type ImageBytes, type ImageTools } from "./images.js";
export { transcriptTail, transcriptPath, type TranscriptEntry } from "./transcript.js";
export { openTerminal } from "./terminal.js";
export { contextWrapper, detailOf, firstLine, rowMaker, MAX_ITEMS } from "./items.js";
export type { AgentSdk, QueryLike, SdkMessage } from "./sdk.js";
export * from "../index.js";
