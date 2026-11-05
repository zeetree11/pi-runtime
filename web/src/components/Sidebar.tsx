import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { dayBucket, formatNumber, formatWhen, type Key, type Locale } from "../i18n";
import { useMotionPreset } from "../motion";
import type { Health, SessionSummary } from "../types";
import { Mark } from "./Mark";

export function Sidebar({
  open,
  health,
  sessions,
  activeId,
  locale,
  thinking,
  t,
  onNew,
  onSelect,
}: {
  open: boolean;
  health: Health | null;
  sessions: SessionSummary[];
  activeId: string | null;
  locale: Locale;
  thinking?: boolean;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  onNew: () => void;
  onSelect: (id: string) => void;
}) {
  const groups: Array<"today" | "yesterday" | "earlier"> = ["today", "yesterday", "earlier"];
  const owner = health?.ownerName ?? "…";
  const model = health?.model || health?.provider || t("noModel");
  const { reduce, spring } = useMotionPreset();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = needle ? sessions.filter((session) => session.title.toLowerCase().includes(needle)) : sessions;
  let order = 0;
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="px-3 pb-2 pt-4">
        <input className="search" value={query} placeholder={t("search")} aria-label={t("search")} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="flex items-center gap-3 px-4 pb-3">
        <Mark size={40} thinking={thinking} color />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold tracking-tight">{t("appName")}</div>
          <div className="truncate text-xs text-muted">{t("tagline", { name: owner })}</div>
        </div>
      </div>
      <div className="px-3 pb-2">
        <motion.button type="button" className="new-chat" onClick={onNew} whileTap={reduce ? undefined : { scale: 0.98 }}>
          + {t("newChat")}
        </motion.button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 ? <p className="px-3 py-3 text-sm text-muted">{t("noSessions")}</p> : null}
        {groups.map((bucket) => {
          const items = filtered.filter((session) => dayBucket(session.updatedAt) === bucket);
          if (items.length === 0) return null;
          return (
            <div key={bucket} className="mb-3">
              <div className="px-3 pb-1 text-[11px] tracking-wide text-muted">{t(bucket)}</div>
              <AnimatePresence initial={false}>
                {items.map((session) => {
                  const index = order++;
                  const active = session.id === activeId;
                  return (
                    <motion.button
                      key={session.id}
                      type="button"
                      className="session"
                      onClick={() => onSelect(session.id)}
                      initial={reduce ? false : { opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ ...spring, delay: reduce ? 0 : Math.min(index, 8) * 0.035 }}
                    >
                      {active ? <motion.span layoutId="session-highlight" className="session-hl" transition={spring} /> : null}
                      <Mark size={28} color />
                      <span className="label line-clamp-2 text-sm">{session.title}</span>
                      <small>{formatWhen(session.updatedAt, locale)}</small>
                    </motion.button>
                  );
                })}
              </AnimatePresence>
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
