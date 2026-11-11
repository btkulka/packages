import { useEffect, useState, type KeyboardEvent } from "react";
import type { PastChat } from "../types.js";
import { folderName } from "../words.js";
import { useStore, useTransport, useUi } from "./context.js";

const PAGE = 50;

/** Past chats: every conversation Claude Code kept (in the app's folder, or everywhere), newest first, the chats' own and terminal sessions alike. */
export function PastChats() {
  const t = useTransport();
  const ui = useUi();
  const store = useStore();
  const { SearchField } = ui.c;
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [found, setFound] = useState<{ total: number; chats: PastChat[] }>();
  const [error, setError] = useState<string>();

  /** A row: the conversation, picked back up as a chat, which is then shown. */
  const pickUp = (p: PastChat) =>
    void t.load(p.sessionId).then(
      () => store.setPast(false),
      (e) => ui.toast(ui.errorText(e)),
    );

  // Read again as the query is typed, a moment after it stops.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void t.past(query, limit).then(
          (r) => live && (setFound(r), setError(undefined)),
          (e) => live && setError(ui.errorText(e)),
        ),
      query ? 150 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, limit]);

  const rows = found?.chats ?? [];
  const total = found?.total ?? 0;
  const q = query.trim();

  return (
    <div className="ck-past">
      <div className="ck-pastsearch">
        <SearchField
          // Not on a phone, where focus raises the keyboard over the list it came to read.
          autoFocus={!ui.phone}
          shortcut={null}
          value={query}
          placeholder="Search titles, first messages and folders"
          aria-label="Search past chats"
          onChange={(e) => (setQuery(e.target.value), setLimit(PAGE))}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" && rows[0]) pickUp(rows[0]);
            else if (e.key === "Escape" && !query) {
              e.preventDefault();
              store.setPast(false);
            }
          }}
        />
        {found && <span className="ck-caption ck-ink3">{q ? `${total} ${total === 1 ? "match" : "matches"}` : `${total} conversations ${ui.machine}, newest first`}</span>}
      </div>
      <div className="ck-pastlist">
        {error ? (
          <p className="ck-note is-error">{error}</p>
        ) : !found ? (
          [0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="ck-li ck-pastrow" role="status" aria-label="Reading Claude Code's conversations">
              <span className="ck-col ck-grow" style={{ gap: 6 }}>
                <span className="ck-skel" style={{ width: `${74 - (i % 3) * 16}%`, height: 13 }} />
                <span className="ck-skel" style={{ width: `${34 + (i % 2) * 10}%`, height: 10 }} />
              </span>
            </div>
          ))
        ) : !rows.length ? (
          <div className="ck-empty">
            <p className="ck-headline">{q ? `Nothing matches “${q}”.` : "No conversations yet."}</p>
            <p className="ck-callout ck-ink3">Every chat here and every Claude Code session in a terminal shows up once it has a message.</p>
          </div>
        ) : (
          rows.map((p) => (
            <button key={p.sessionId} type="button" className="ck-li ck-pastrow" title={`${p.title}\n${ui.showPath(p.folder)}`} onClick={() => pickUp(p)}>
              <span className="ck-col ck-grow">
                <span className="ck-pasttitle">{p.title}</span>
                <span className="ck-caption ck-ink3 ck-where">{[folderName(p.folder), p.branch && p.branch !== "HEAD" ? p.branch : "", ui.relTime(p.updated)].filter(Boolean).join(" · ")}</span>
              </span>
              {p.chat && <span className="ck-caption ck-ink2">Open</span>}
            </button>
          ))
        )}
        {total > rows.length && !error && (
          <button type="button" className="ck-chip ck-pastmore" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, total - rows.length)} more
          </button>
        )}
      </div>
    </div>
  );
}
