// @btkulka/ui-kit: the controls Ben's web apps share. Every piece is themed by --ui-* CSS
// variables (import "@btkulka/ui-kit/styles.css", then set the variables in the app's own CSS),
// moves the same way (settles, never bounces; nothing moves under reduced motion), works by
// touch, mouse and keyboard, and keeps targets at 44px or more.

export { AnimatedList, type AnimatedListProps } from "./animated-list.js";
export { Button, ConfirmButton, IconButton, type ButtonProps, type ButtonSize, type ButtonVariant, type ConfirmButtonProps, type IconButtonProps } from "./button.js";
export { Chip, RemovableChip, type ChipProps } from "./chips.js";
export { Segmented, TileGroup, type ChoiceOption, type SegmentedProps, type TileGroupProps } from "./choice.js";
export { DateStrip, type DateStripProps } from "./date-strip.js";
export { Disclosure, type DisclosureProps } from "./disclosure.js";
export { useDragTo, type DragToHandle, type DragToOptions } from "./drag.js";
export { Avatar, Banner, EmptyState, Row, Skeleton, Spinner, Tag, type Tone } from "./feedback.js";
export { Field, SearchField, Select, TextArea, TextField, type SelectProps, type TextAreaProps, type TextFieldProps } from "./fields.js";
export { cx, mergeRefs, useHotkey, useLatest, useRepeat, useResize, type HotkeyOptions } from "./hooks.js";
export { IconBadge, IconPicker, SvgIcon, type IconDef, type IconPickerProps } from "./icon.js";
export * from "./logic.js";
export { Menu, MenuButton, useContextMenu, useLongPress, type ContextMenuHandle, type LongPressInfo, type MenuAction, type MenuEntry, type MenuMode, type MenuSpec } from "./menu.js";
export { DURATION, EASE, EASE_IN, fold, haptic, motion, reducedMotion, settled, unfold, wideLayout } from "./motion.js";
export { PageHeader, type PageHeaderProps } from "./page-header.js";
export { Sheet, finePointer, useKeyboardAware, type SheetProps } from "./sheet.js";
export { Stepper, type StepperProps } from "./stepper.js";
export { SwipeRow, type SwipeAction, type SwipeRowProps } from "./swipe-row.js";
export { DataTable, type DataColumn, type DataSort, type DataTableProps } from "./table.js";
export { TabBar, type TabBarProps, type TabItem } from "./tabbar.js";
export {
  DEFAULT_UI_THEME,
  UI_THEMES,
  UI_THEME_ATTRIBUTE,
  UI_TOKENS,
  customizeUiTheme,
  getUiTheme,
  setUiTheme,
  type UiTheme,
  type UiThemeId,
  type UiToken,
  type UiTokenOverrides,
} from "./themes.js";
export { TagInput, type TagInputProps } from "./tag-input.js";
export { ToastProvider, useToasts, type ToastAction, type ToastApi, type ToastOptions } from "./toast.js";
export { TokenField, type TokenFieldProps } from "./token-field.js";
export { Check, Switch, SwitchRow, type CheckProps, type SwitchProps, type SwitchRowProps } from "./toggles.js";
