import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { SearchField } from "./fields.js";
import { cx } from "./hooks.js";
import { haptic } from "./motion.js";
import { Sheet } from "./sheet.js";

/** An icon as data: SVG markup for a 24-unit box, drawn with the current colour's stroke. */
export interface IconDef {
  /** Its id, what's stored when someone picks it ("carrot"). */
  name: string;
  /** What it shows ("Carrot"). */
  label: string;
  /** The inner SVG (paths, circles…), stroke-only unless an element sets its own fill. */
  body: string;
  /** Words it answers to in a search ("vegetable", "root"). */
  keywords?: string[];
  /** The group it shows under in a picker ("Vegetables"). */
  group?: string;
}

/**
 * Draws an IconDef. Bodies come from the app's own icon table (built from an icon set at build
 * time), never from what people type, so setting them as markup is safe.
 */
export function SvgIcon({ icon, size = 20, stroke = 1.8, className, title, style }: { icon: IconDef | Pick<IconDef, "body"> | undefined | null; size?: number; stroke?: number; className?: string; title?: string; style?: CSSProperties }) {
  if (!icon) return null;
  return (
    <svg
      className={cx("ui-svg-icon", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={style}
      dangerouslySetInnerHTML={{ __html: icon.body }}
    />
  );
}

/** A small round badge holding an icon: a food's picture at the start of its row. */
export function IconBadge({ icon, size = 36, tone, className, onClick, label }: { icon: IconDef | undefined | null; size?: number; tone?: "neutral" | "accent" | "good" | "warn" | "danger"; className?: string; onClick?: () => void; label?: string }) {
  const inner = <SvgIcon icon={icon} size={Math.round(size * 0.56)} />;
  const cls = cx("ui-icon-badge", tone && `ui-tone-${tone}`, onClick && "is-button", className);
  const style = { width: size, height: size } as CSSProperties;
  return onClick ? (
    <button type="button" className={cls} style={style} onClick={onClick} aria-label={label} title={label}>
      {inner}
    </button>
  ) : (
    <span className={cls} style={style} aria-hidden={label ? undefined : true} title={label}>
      {inner}
    </span>
  );
}

export interface IconPickerProps {
  icons: IconDef[];
  /** The picked icon's name, or null for "automatic". */
  value: string | null;
  onChange: (name: string | null) => void;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  /** The icon "automatic" would give, shown on its tile. */
  automatic?: IconDef | null;
  automaticLabel?: string;
  searchLabel?: string;
}

/** A sheet of icons to choose from, grouped and searchable, with "automatic" first. */
export function IconPicker({ icons, value, onChange, onClose, title, sub, automatic, automaticLabel = "Automatic", searchLabel = "Find an icon" }: IconPickerProps) {
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase();
    const hits = words ? icons.filter((i) => i.label.toLowerCase().includes(words) || i.name.includes(words) || i.keywords?.some((k) => k.includes(words))) : icons;
    const out = new Map<string, IconDef[]>();
    for (const i of hits) {
      const g = i.group ?? "";
      if (!out.has(g)) out.set(g, []);
      out.get(g)!.push(i);
    }
    return [...out];
  }, [icons, q]);
  const pick = (name: string | null) => {
    haptic(6);
    onChange(name);
    onClose();
  };
  return (
    <Sheet title={title} sub={sub} onClose={onClose} size="lg" initialFocus={search}>
      <SearchField ref={search} value={q} onChange={setQ} placeholder={searchLabel} aria-label={searchLabel} />
      {!q && (
        <div className="ui-icon-grid">
          <button type="button" className={cx("ui-icon-tile", value === null && "is-on")} aria-pressed={value === null} onClick={() => pick(null)}>
            <SvgIcon icon={automatic ?? { body: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/>' }} size={24} />
            <span>{automaticLabel}</span>
          </button>
        </div>
      )}
      {groups.map(([g, list]) => (
        <section key={g} className="ui-icon-group">
          {g && <h3 className="ui-icon-group__title">{g}</h3>}
          <div className="ui-icon-grid">
            {list.map((i) => (
              <button key={i.name} type="button" className={cx("ui-icon-tile", value === i.name && "is-on")} aria-pressed={value === i.name} onClick={() => pick(i.name)} title={i.label}>
                <SvgIcon icon={i} size={24} />
                <span>{i.label}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {!groups.length && <p className="ui-icon-none">Nothing called that.</p>}
    </Sheet>
  );
}
