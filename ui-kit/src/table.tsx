import { useMemo, useState, type ReactNode } from "react";
import { cx } from "./hooks.js";
import { sortRows, type SortDir, type SortValue } from "./logic.js";
import { useContextMenu, type MenuSpec } from "./menu.js";

export interface DataColumn<R> {
  id: string;
  label: ReactNode;
  /** The cell. */
  render: (row: R) => ReactNode;
  /** What the column sorts by; left out, its header doesn't sort. Rows with no value sort last. */
  sort?: (row: R) => SortValue;
  /** The way a first click sorts it: "desc" for counts and money, where the most is what you're after. Default "asc". */
  firstDir?: SortDir;
  /** "end" for numbers. */
  align?: "start" | "end";
  /** Stays in view while the table scrolls sideways (the first column, the row's name). */
  sticky?: boolean;
  /** Its least width, as CSS ("9rem"). */
  minWidth?: string;
  /** Read out instead of the header when the label is an icon. */
  ariaLabel?: string;
}

export interface DataSort {
  id: string;
  dir: SortDir;
}

export interface DataTableProps<R> {
  rows: readonly R[];
  columns: DataColumn<R>[];
  rowKey: (row: R) => string | number;
  /** Names the table for screen readers. */
  label: string;
  /** The sort, when the app keeps it (to remember it); otherwise the table keeps its own from `defaultSort`. */
  sort?: DataSort | null;
  onSort?: (sort: DataSort) => void;
  defaultSort?: DataSort;
  /** A row opens (click, tap, Enter). */
  onRowClick?: (row: R) => void;
  /** A row's menu: long press, right-click or the menu key. */
  rowMenu?: (row: R) => MenuSpec | null;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A table to look through and sort: each sortable header sorts on a click (again to turn it round), the
 * first column can stay put while the rest scrolls sideways, and the header stays put while the rows
 * scroll. Rows open on a click, tap or Enter and have a menu like any row. Filtering is the app's: hand
 * it the rows to show.
 */
export function DataTable<R>({ rows, columns, rowKey, label, sort, onSort, defaultSort, onRowClick, rowMenu, empty, className }: DataTableProps<R>) {
  const [own, setOwn] = useState<DataSort | null>(defaultSort ?? null);
  const current = sort !== undefined ? sort : own;
  const col = current ? columns.find((c) => c.id === current.id && c.sort) : undefined;
  const sorted = useMemo(() => (col && current ? sortRows(rows, col.sort!, current.dir) : [...rows]), [rows, col, current]);
  const setSort = (c: DataColumn<R>) => {
    const dir: SortDir = current?.id === c.id ? (current.dir === "asc" ? "desc" : "asc") : (c.firstDir ?? "asc");
    const next = { id: c.id, dir };
    if (sort === undefined) setOwn(next);
    onSort?.(next);
  };
  return (
    <div className={cx("ui-table-wrap", className)} role="region" aria-label={label} tabIndex={0}>
      <table className="ui-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const on = current?.id === c.id && Boolean(c.sort);
              return (
                <th
                  key={c.id}
                  scope="col"
                  className={cx(c.sticky && "is-sticky", c.align === "end" && "is-end", on && "is-sorted")}
                  style={c.minWidth ? { minWidth: c.minWidth } : undefined}
                  aria-sort={on ? (current!.dir === "asc" ? "ascending" : "descending") : c.sort ? "none" : undefined}
                  aria-label={c.ariaLabel}
                >
                  {c.sort ? (
                    <button type="button" className="ui-table__sort" onClick={() => setSort(c)}>
                      {c.label}
                      <span className="ui-table__arrow" aria-hidden="true">
                        {on ? (current!.dir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <DataRow key={rowKey(r)} row={r} columns={columns} onRowClick={onRowClick} rowMenu={rowMenu} />
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && empty && <div className="ui-table__empty">{empty}</div>}
    </div>
  );
}

function DataRow<R>({ row, columns, onRowClick, rowMenu }: { row: R; columns: DataColumn<R>[]; onRowClick?: (row: R) => void; rowMenu?: (row: R) => MenuSpec | null }) {
  const cm = useContextMenu(() => (rowMenu ? rowMenu(row) : null), { disabled: !rowMenu });
  return (
    <tr
      className={cx(onRowClick && "is-clickable")}
      tabIndex={onRowClick ? 0 : undefined}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onKeyDown={
        onRowClick
          ? (e) => {
              if (e.key === "Enter" && e.target === e.currentTarget) {
                e.preventDefault();
                onRowClick(row);
              }
            }
          : undefined
      }
      {...(rowMenu ? cm.bind : {})}
    >
      {columns.map((c, i) =>
        i === 0 ? (
          <th key={c.id} scope="row" className={cx(c.sticky && "is-sticky", c.align === "end" && "is-end")}>
            {c.render(row)}
            {rowMenu && cm.menu}
          </th>
        ) : (
          <td key={c.id} className={cx(c.sticky && "is-sticky", c.align === "end" && "is-end")}>
            {c.render(row)}
          </td>
        ),
      )}
    </tr>
  );
}
