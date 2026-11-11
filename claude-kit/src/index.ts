// @btkulka/claude-kit: Claude Code chats in any of Ben's apps, the way the
// Benhäus panel has them. This root entry is the shared part (types, the
// change protocol, the words the screens use), with no Node and no DOM.
// The host is "/host", the transports "/electron/main", "/electron/preload"
// and "/http" + "/client", the screens "/react" and "/element".

export type {
  AskDecision,
  ChatAsk,
  ChatImage,
  ChatItem,
  ChatPatch,
  ChatsPatch,
  ChatsState,
  ChatState,
  ChatStreamDelta,
  ClaudeEvent,
  ClaudeMode,
  ClaudeTransport,
  ImageBytesOut,
  NewChatImage,
  NewChatOptions,
  PastChat,
  ThumbSize,
} from "./types.js";
export { applyChat, applyChats, applyStream, diffItems } from "./patch.js";
export { MODES, chatWord, chatsWord, chatsSignal, modelName, toolLabel, needsSignIn, showPath, folderName, relTime } from "./words.js";
