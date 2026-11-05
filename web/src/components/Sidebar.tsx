import { dayBucket, formatNumber, formatWhen, type Key, type Locale } from "../i18n";
import type { Health, SessionSummary } from "../types";
import { Mark } from "./Mark";

export function Sidebar({
  open,
  health,
  sessions,
  activeId,
  locale,
  t,
  onNew,
  onSelect,
}: {
  open: boolean;
  health: Health | null;
  sessions: SessionSummary[];
  activeId: string | null;
  locale: Locale;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  const groups: Array<"today" | "yesterday" | "earlier"> = ["today", "yesterday", "earlier"];
  const owner = health?.ownerName ?? "…";
  const model = health?.model || health?.provider || t("noModel");
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="flex items-center gap-3 px-4 pb-2 pt-4">
        <Mark />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tight">{t("appName")}</div>
          <div className="truncate text-xs text-muted">{t("tagline", { name: owner })}</div>
        </div>
      </div>
      <div className="px-3 py-2">
        <button type="button" className="text-btn w-full rounded-xl px-3 py-2 text-left text-sm text-ink" onClick={onNew}>
          + {t("newChat")}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {sessions.length === 0 ? <p className="px-2 py-3 text-sm text-muted">{t("noSessions")}</p> : null}
        {groups.map((bucket) => {
          const items = sessions.filter((session) => dayBucket(session.updatedAt) === bucket);
          if (items.length === 0) return null;
          return (
            <div key={bucket} className="mb-3">
              <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-muted">{t(bucket)}</div>
              {items.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className={`session ${session.id === activeId ? "active" : ""}`}
                  onClick={() => onSelect(session.id)}
                >
                  <span className="line-clamp-2 text-sm">{session.title}</span>
                  <small>{formatWhen(session.updatedAt, locale)}</small>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="border-t border-line px-4 py-3 text-xs text-muted">
        <div className="truncate">{model}</div>
        {health ? (
          <div className="mt-1">
            {t("usageToday", {
              tokens: formatNumber(health.usageToday.total, locale),
              runs: formatNumber(health.usageToday.runs, locale),
            })}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
