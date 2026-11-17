import { forwardRef, useMemo, useRef, useState, type ReactNode } from "react";
import { TextField, type TextFieldProps } from "./fields.js";
import { cx, mergeRefs } from "./hooks.js";
import { completeToken, currentToken, rankSuggestions } from "./logic.js";
import { haptic } from "./motion.js";

export interface TokenFieldProps extends TextFieldProps {
  /** Words to finish the one being typed with ("spin" → spinach). */
  suggestions: readonly string[];
  /** How many to offer at once. */
  limit?: number;
  /** An icon for a suggestion (a food's own picture). */
  iconFor?: (suggestion: string) => ReactNode;
}

/**
 * A text field for lists of things ("2 avocados, spinach, 1 lb chicken") that finishes each one
 * as it's typed: suggestions for the word after the last comma sit in a row under the field;
 * a tap takes one (and keeps the keyboard up for the next), Tab takes the first.
 */
export const TokenField = forwardRef<HTMLInputElement, TokenFieldProps>(function TokenField({ suggestions, limit = 6, iconFor, value, onChange, onKeyDown, onFocus, onBlur, className, ...rest }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const word = currentToken(value).word;
  const offers = useMemo(() => (focused ? rankSuggestions(word, suggestions, limit) : []), [focused, word, suggestions, limit]);
  const take = (s: string) => {
    haptic(4);
    onChange(completeToken(value, s));
    // Keep typing where it left off.
    requestAnimationFrame(() => {
      const el = own.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  return (
    <div className={cx("ui-token-field", className)}>
      <TextField
        ref={mergeRefs(ref, own)}
        value={value}
        onChange={onChange}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (offers.length && (e.key === "Tab" || (e.key === "ArrowRight" && el.selectionStart === el.value.length)) && !e.shiftKey) {
            e.preventDefault();
            take(offers[0]);
            return;
          }
          onKeyDown?.(e);
        }}
      />
      {offers.length > 0 && (
        <div className="ui-token-field__offers" role="listbox" aria-label="Suggestions">
          {offers.map((s, i) => (
            <button key={s} type="button" role="option" aria-selected={i === 0} className={cx("ui-token-field__offer", i === 0 && "is-first")} onMouseDown={(e) => e.preventDefault()} onClick={() => take(s)}>
              {iconFor?.(s)}
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
