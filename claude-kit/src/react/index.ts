// @btkulka/claude-kit/react: Claude's screens. Put a <ClaudeProvider> on a
// transport, then <ClaudeWidget /> for the corner button and its drawer, or
// the pieces (ClaudeFab, ClaudeDrawer, ClaudePanel, ClaudeChat, ChatView) to
// place yourself. Import "@btkulka/claude-kit/styles.css" once.

export { ClaudeProvider, claudeToast, useClaude, useStore, useTransport, useUi, type ClaudeUi, type Where } from "./context.js";
export { ClaudeWidget, ClaudeFab, ClaudeDrawer, askClaude } from "./widget.js";
export { ClaudePanel, ClaudeChat, More } from "./panel.js";
export { ChatView, ChatStrip } from "./chat.js";
export { PastChats } from "./past.js";
export { Prose } from "./prose.js";
export { Thumb, Lightbox, prepare, type Pic, type Pending } from "./images.js";
export { MenuButton } from "./menu.js";
export { ClaudeMark, builtIns, type Components, type MenuItem, type ButtonProps, type TooltipProps, type MenuProps, type SegmentedControlProps, type SearchFieldProps } from "./primitives.js";
export { createClaudeStore, httpTransport, type ClaudeSnapshot, type ClaudeStore } from "../client/index.js";
export * from "../index.js";
