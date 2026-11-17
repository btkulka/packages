import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { addTags, splitTags } from "./logic.js";
import { haptic } from "./motion.js";

export interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Spoken name of the field. */
  label: string;
  placeholder?: string;
  /** Offered while typing (and on focus when `suggestOnFocus`), minus what's already in. */
  suggestions?: string[];
  suggestOnFocus?: boolean;
  transform?: (tag: string) => string;
  allowDuplicates?: boolean;
  max?: number;
  /** What a chip shows (left out: the tag itself). */
  renderTag?: (tag: string) => ReactNode;
  removeLabel?: (tag: string) => string;
  /** A typed tag that isn't Entered yet is added when the field loses focus (on by default). */
  commitOnBlur?: boolean;
  id?: string;
  className?: string;
}

/**
 * Tags as chips. Enter, a comma or Tab adds what's typed; pasting "a, b, c" adds three;
 * Backspace on an empty field lights the last chip, and again removes it. Suggestions come up
 * as you type and the arrow keys pick one.
 */
export function TagInput({ value, onChange, label, placeholder, suggestions = [], suggestOnFocus = false, transform, allowDuplicates, max, renderTag, removeLabel = (t) => `Remove ${t}`, commitOnBlur = true, id, className }: TagInputProps) {
  const [text, setText] = useState("");
  const [marked, setMarked] = useState(false);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const fresh = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const opts = { allowDuplicates, max, transform };

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q && !suggestOnFocus) return [];
    const have = new Set(value.map((v) => v.toLowerCase()));
    return suggestions.filter((s) => !have.has(s.toLowerCase()) && (!q || s.toLowerCase().includes(q))).slice(0, 8);
  }, [text, suggestions, value, suggestOnFocus]);
  const open = focused && shown.length > 0;

  const add = (raw: string[]) => {
    const next = addTags(value, raw, opts);
    if (next !== value) {
      for (const t of next.slice(value.length)) fresh.current.add(t);
      haptic(4);
      onChange(next);
    }
    setText("");
    setActive(-1);
    setMarked(false);
  };
  const remove = (i: number) => {
    onChange(value.filter((_, j) => j !== i));
    setMarked(false);
    input.current?.focus();
  };

  return (
    <div
      className={cx("ui-tags", focused && "is-focused", className)}
      onMouseDown={(e) => {
        // A tap on the box (not a chip's ×) puts the cursor in the field.
        if (e.target === e.currentTarget) {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      {value.map((t, i) => (
        <span key={`${t}-${i}`} className={cx("ui-tags__chip", fresh.current.has(t) && "is-fresh", marked && i === value.length - 1 && "is-marked")}>
          <span>{renderTag ? renderTag(t) : t}</span>
          <button type="button" aria-label={removeLabel(t)} title={removeLabel(t)} onClick={() => remove(i)}>
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        className="ui-tags__input"
        value={text}
        placeholder={value.length ? undefined : placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        enterKeyHint="enter"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setMarked(false);
          if (commitOnBlur && text.trim()) add(splitTags(text));
        }}
        onChange={(e) => {
          const v = e.target.value;
          setMarked(false);
          if (/[,;\n]/.test(v)) {
            const parts = v.split(/[,;\n]/);
            const keep = parts.pop() ?? "";
            add(parts.map((p) => p.trim()).filter(Boolean));
            setText(keep.trimStart());
          } else {
            setText(v);
            setActive(-1);
          }
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (/[,;\n]/.test(pasted)) {
            e.preventDefault();
            add(splitTags(text + pasted));
          }
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" || (e.key === "Tab" && text.trim() && !e.shiftKey)) {
            if (open && active >= 0) {
              e.preventDefault();
              add([shown[active]]);
            } else if (text.trim()) {
              e.preventDefault();
              add(splitTags(text));
            } else if (e.key === "Enter") e.preventDefault();
          } else if (e.key === "Backspace" && !text && value.length) {
            e.preventDefault();
            if (marked) remove(value.length - 1);
            else setMarked(true);
          } else if (e.key === "ArrowDown" && open) {
            e.preventDefault();
            setActive((a) => (a + 1) % shown.length);
          } else if (e.key === "ArrowUp" && open) {
            e.preventDefault();
            setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
          } else if (e.key === "Escape" && (text || marked)) {
            // Clear the field first; a second Escape closes the sheet it's in.
            e.preventDefault();
            e.stopPropagation();
            setText("");
            setMarked(false);
          } else if (marked) setMarked(false);
        }}
      />
      {open && (
        <ul className="ui-tags__suggest" role="listbox" id={listId} aria-label={`${label} suggestions`}>
          {shown.map((s, i) => (
            <li key={s} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={cx(i === active && "is-active")} onMouseDown={(e) => e.preventDefault()} onClick={() => add([s])}>
              {renderTag ? renderTag(s) : s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
