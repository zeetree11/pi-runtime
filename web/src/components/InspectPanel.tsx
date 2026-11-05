import { useEffect, useState } from "react";
import { api } from "../api";
import { formatNumber, formatWhen, type Key, type Locale } from "../i18n";
import type { KnowledgeDoc, McpItem, MemoryItem, PersonaFile, PublicConfig, ReminderItem, SkillItem, StateItem } from "../types";

type Tab = "memory" | "skills" | "mcp" | "knowledge" | "persona" | "reminders" | "state" | "config";

const TABS: Tab[] = ["memory", "skills", "mcp", "knowledge", "persona", "reminders", "state", "config"];

export function InspectPanel({
  chatId,
  locale,
  t,
  onClose,
}: {
  chatId: string | null;
  locale: Locale;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("memory");
  const [history, setHistory] = useState(false);
  const [category, setCategory] = useState<"all" | "preference" | "fact" | "event">("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [memory, setMemory] = useState<MemoryItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [mcp, setMcp] = useState<McpItem[]>([]);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [docStats, setDocStats] = useState<{ documents: number; chunks: number } | null>(null);
  const [soul, setSoul] = useState<PersonaFile>(null);
  const [contracts, setContracts] = useState<PersonaFile>(null);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [state, setState] = useState<StateItem[]>([]);
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      api.memory(history),
      api.skills(),
      api.mcp(),
      api.knowledge(),
      api.persona(),
      api.reminders(),
      api.state(chatId),
      api.config(),
    ])
      .then(([mem, skillRes, mcpRes, knowledge, persona, reminderRes, stateRes, cfg]) => {
        if (cancelled) return;
        setMemory(mem.items);
        setSkills(skillRes.skills);
        setMcp(mcpRes.servers);
        setDocs(knowledge.documents);
        setDocStats(knowledge.stats);
        setSoul(persona.soul);
        setContracts(persona.contracts);
        setReminders(reminderRes.pending);
        setState(stateRes.items);
        setConfig(cfg);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [history, chatId]);

  const shown = memory.filter((item) => category === "all" || item.category === category);

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold">{t("inspect")}</h2>
        <button type="button" className="icon-btn" aria-label={t("close")} onClick={onClose}>
          ×
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto px-4 pb-3">
        {TABS.map((item) => (
          <button key={item} type="button" className={`chip ${tab === item ? "on" : ""}`} onClick={() => setTab(item)}>
            {t(item)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {loading ? <p className="text-sm text-muted">{t("connecting")}</p> : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {!loading && tab === "memory" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {(["all", "preference", "fact", "event"] as const).map((item) => (
                <button key={item} type="button" className={`chip ${category === item ? "on" : ""}`} onClick={() => setCategory(item)}>
                  {t(item === "all" ? "allCategories" : item)}
                </button>
              ))}
              <button type="button" className={`chip ${history ? "on" : ""}`} onClick={() => setHistory((value) => !value)}>
                {history ? t("includeHistory") : t("activeOnly")}
              </button>
            </div>
            {shown.length === 0 ? <p className="text-sm text-muted">{t("emptyMemory")}</p> : null}
            {shown.map((item) => (
              <article key={item.id} className="card">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <span className="chip on">{t(item.category === "preference" || item.category === "fact" || item.category === "event" ? item.category : "fact")}</span>
                  <span>{item.status}</span>
                  <span className="ml-auto">{t("importance")} {item.importance}</span>
                </div>
                <h3 className="text-sm font-medium">{item.key}</h3>
                <p className="mt-1 text-sm">{item.content}</p>
                <p className="mt-2 text-xs text-muted">
                  {t("subject")} · {item.subject}
                  {item.useCount ? ` · ${t("useCount", { n: item.useCount })}` : ""}
                </p>
                {item.evidenceQuote ? (
                  <blockquote className="mt-2 border-l-2 border-accent pl-2 text-xs text-muted">
                    {t("evidence")} #{item.evidenceEventId ?? "—"} · {item.evidenceQuote}
                  </blockquote>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "skills" ? (
          <div className="space-y-2">
            {skills.length === 0 ? <p className="text-sm text-muted">{t("emptySkills")}</p> : null}
            {skills.map((skill) => (
              <article key={skill.name} className="card" title={skill.path}>
                <div className="text-sm font-medium">{skill.name}</div>
                <p className="mt-1 text-sm text-muted">{skill.description || "—"}</p>
                <p className="mt-2 text-xs text-muted">
                  {skill.scope === "project" ? t("scopeProject") : t("scopeUser")} · {t("chars", { n: formatNumber(skill.bytes, locale) })}
                </p>
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "mcp" ? (
          <div className="space-y-2">
            {mcp.length === 0 ? <p className="text-sm text-muted">{t("emptyMcp")}</p> : null}
            {mcp.map((server) => (
              <article key={server.name} className="card">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{server.name}</span>
                  <span className="text-xs text-muted">{server.enabled ? t("enabled") : t("disabled")}</span>
                </div>
                {server.command ? <p className="mt-1 break-all font-mono text-xs text-muted">{server.command}</p> : null}
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "knowledge" ? (
          <div className="space-y-2">
            {docStats ? (
              <p className="text-xs text-muted">
                {t("documents")} {docStats.documents} · {t("chunks")} {docStats.chunks}
              </p>
            ) : null}
            {docs.length === 0 ? <p className="text-sm text-muted">{t("emptyKnowledge")}</p> : null}
            {docs.map((doc) => (
              <article key={doc.source} className="card">
                <div className="text-sm font-medium">{doc.source}</div>
                <p className="mt-1 text-xs text-muted">
                  {t("chunks")} {doc.chunks} · {t("chars", { n: formatNumber(doc.chars, locale) })}
                </p>
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "persona" ? (
          <div className="space-y-3">
            {!soul && !contracts ? <p className="text-sm text-muted">{t("emptyPersona")}</p> : null}
            {soul ? <PersonaCard title={t("soul")} file={soul} /> : null}
            {contracts ? <PersonaCard title={t("contracts")} file={contracts} /> : null}
          </div>
        ) : null}
        {!loading && tab === "reminders" ? (
          <div className="space-y-2">
            {reminders.length === 0 ? <p className="text-sm text-muted">{t("emptyReminders")}</p> : null}
            {reminders.map((item) => (
              <article key={item.id} className="card">
                <p className="text-sm">{item.text}</p>
                <p className="mt-1 text-xs text-muted">
                  {t("due")} {formatWhen(item.dueAt, locale)} · {item.channel}
                </p>
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "state" ? (
          <div className="space-y-2">
            {state.length === 0 ? <p className="text-sm text-muted">{t("emptyState")}</p> : null}
            {state.map((item) => (
              <article key={`${item.scope}:${item.key}`} className="card">
                <div className="text-sm font-medium">{item.key}</div>
                <p className="mt-1 text-sm">{item.value}</p>
                <p className="mt-1 text-xs text-muted">
                  {item.scope} · {t("expires")} {formatWhen(item.expires_at, locale)}
                </p>
              </article>
            ))}
          </div>
        ) : null}
        {!loading && tab === "config" && config ? <ConfigView config={config} locale={locale} t={t} /> : null}
      </div>
    </aside>
  );
}

function PersonaCard({ title, file }: { title: string; file: NonNullable<PersonaFile> }) {
  return (
    <article className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-muted">
          {file.chars}/{file.limit} · {file.percent}%
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent" style={{ width: `${Math.min(100, file.percent)}%` }} />
      </div>
      <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">{file.text}</pre>
    </article>
  );
}

function ConfigView({
  config,
  locale,
  t,
}: {
  config: PublicConfig;
  locale: Locale;
  t: (key: Key, vars?: Record<string, string | number>) => string;
}) {
  const rows: Array<[string, string]> = [
    [t("owner"), config.ownerName],
    [t("provider"), config.provider ?? "—"],
    [t("modelLabel"), config.model ?? t("noModel")],
    [t("workspace"), config.workspace],
    [t("sandbox"), config.sandbox],
    [t("memory"), config.memory.enabled ? t("memoryOn") : t("memoryOff")],
    [t("autoExtract"), config.memory.autoExtract ? t("on") : t("off")],
    [t("summary"), config.context.summaryEnabled ? t("summaryOn") : t("summaryOff")],
    [t("dailyBudget"), config.limits.dailyTokens > 0 ? formatNumber(config.limits.dailyTokens, locale) : t("unlimited")],
    [t("taskBudget"), config.limits.taskTokens > 0 ? formatNumber(config.limits.taskTokens, locale) : t("unlimited")],
  ];
  return (
    <dl className="space-y-3">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="break-all text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
