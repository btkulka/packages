import { forwardRef, useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cx, mergeRefs } from "./hooks.js";

/** A labelled field: the label over the control, a hint or an error under it. */
export function Field({ label, hint, error, children, className, as = "label", htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; as?: "label" | "div"; htmlFor?: string }) {
  const Tag = as;
  return (
    <Tag className={cx("ui-field", className)} htmlFor={as === "label" ? htmlFor : undefined}>
      <span className="ui-field__label">{label}</span>
      {children}
      {error ? <span className="ui-field__error">{error}</span> : hint && <span className="ui-field__hint">{hint}</span>}
    </Tag>
  );
}

const ClearIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** Called when the person's done (blur or Enter), only if the text changed since they started. */
  onCommit?: (value: string) => void;
  /** At the start, inside the field. */
  icon?: ReactNode;
  /** An × that empties the field, shown when there's text. */
  clearable?: boolean;
  clearLabel?: string;
  /** At the end, inside the field (a unit, a button). */
  trailing?: ReactNode;
  size?: "md" | "lg";
  invalid?: boolean;
}

/** A text field with room for an icon, a clear button and something at its end. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ value, onChange, onCommit, icon, clearable, clearLabel = "Clear", trailing, size = "md", invalid, className, onFocus, onBlur, onKeyDown, ...rest }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  const atFocus = useRef(value);
  const commit = (v: string) => {
    if (onCommit && v !== atFocus.current) {
      atFocus.current = v;
      onCommit(v);
    }
  };
  return (
    <span className={cx("ui-input", `ui-input--${size}`, icon && "has-icon", invalid && "is-invalid", className)}>
      {icon && <span className="ui-input__icon">{icon}</span>}
      <input
        ref={mergeRefs(ref, own)}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => {
          atFocus.current = e.target.value;
          onFocus?.(e);
        }}
        onBlur={(e) => {
          commit(e.target.value);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && onCommit) commit(e.currentTarget.value);
          onKeyDown?.(e);
        }}
        {...rest}
      />
      {clearable && value && (
        <button
          type="button"
          className="ui-input__clear"
          aria-label={clearLabel}
          title={clearLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            commit("");
            own.current?.focus();
          }}
        >
          <ClearIcon />
        </button>
      )}
      {trailing && <span className="ui-input__trailing">{trailing}</span>}
    </span>
  );
});

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);

/** A search field: a glass, an ×, and Escape empties it (a second Escape goes on to close a sheet). */
export const SearchField = forwardRef<HTMLInputElement, Omit<TextFieldProps, "icon" | "clearable" | "type">>(function SearchField({ onKeyDown, ...props }, ref) {
  return (
    <TextField
      ref={ref}
      type="search"
      icon={<SearchIcon />}
      clearable
      enterKeyHint="search"
      autoComplete="off"
      spellCheck={false}
      {...props}
      onKeyDown={(e) => {
        if (e.key === "Escape" && props.value) {
          e.preventDefault();
          e.stopPropagation();
          props.onChange("");
        }
        onKeyDown?.(e);
      }}
    />
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  /** Grows with what's typed, from `rows` up to this many lines, then scrolls. */
  maxRows?: number;
}

/** A text area that grows with its text instead of scrolling a tiny box. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ value, onChange, onCommit, rows = 3, maxRows = 18, className, onFocus, onBlur, ...rest }, ref) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const atFocus = useRef(value);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 22;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = "auto";
    const want = Math.min(el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth), line * maxRows + pad);
    el.style.height = `${Math.max(want, line * rows + pad)}px`;
  }, [value, rows, maxRows]);
  return (
    <textarea
      ref={mergeRefs(ref, own)}
      className={cx("ui-textarea", className)}
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        atFocus.current = e.target.value;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        if (onCommit && e.target.value !== atFocus.current) onCommit(e.target.value);
        onBlur?.(e);
      }}
      {...rest}
    />
  );
});

export interface SelectProps<T extends string | number> {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  /** Shown before the value, inside the control. */
  icon?: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** A native select in the kit's clothes, so phones still get their own picker wheel. */
export function Select<T extends string | number>({ value, options, onChange, label, size = "md", icon, disabled, id, className }: SelectProps<T>) {
  return (
    <span className={cx("ui-select", `ui-select--${size}`, icon && "has-icon", className)}>
      {icon && <span className="ui-select__icon">{icon}</span>}
      <select
        id={id}
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find((o) => String(o.value) === e.target.value);
          if (hit) onChange(hit.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="ui-select__chevron" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}
