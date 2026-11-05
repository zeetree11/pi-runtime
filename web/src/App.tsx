import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, applyEvent, fromServerMessage, setToken, streamMessage } from "./api";
import { useMotionPreset } from "./motion";
import { ChatView } from "./components/ChatView";
import { InspectPanel } from "./components/InspectPanel";
import { Mark } from "./components/Mark";
import { Sidebar } from "./components/Sidebar";
import lightHljs from "highlight.js/styles/github.css?url";
import darkHljs from "highlight.js/styles/github-dark.css?url";
import { translate, type Key, type Locale } from "./i18n";
import type { ChatMessage, Health, PendingApproval, PendingProposal, ServerEvent, SessionSummary } from "./types";

const THEME_KEY = "pi-rt-theme";
const LANG_KEY = "pi-rt-lang";

function readHash(): string | null {
  const match = /^#\/c\/([A-Za-z0-9_-]{1,80})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

function initialTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function initialLocale(): Locale {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "token">("loading");
  const [tokenDraft, setTokenDraft] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readHash);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [proposal, setProposal] = useState<PendingProposal | null>(null);
  const cache = useRef(new Map<string, ChatMessage[]>());
  const activeRef = useRef<string | null>(activeId);
  const streamingRef = useRef<string | null>(null);
  activeRef.current = activeId;
  streamingRef.current = streamingId;

  const t = useCallback((key: Key, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
  const { reduce, spring } = useMotionPreset();

  function toggleTheme() {
    if (!reduce) document.documentElement.classList.add("theme-fade");
    setTheme((value) => (value === "dark" ? "light" : "dark"));
    window.setTimeout(() => document.documentElement.classList.remove("theme-fade"), 460);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, locale]);

  const refreshSessions = useCallback(async () => {
    const list = await api.sessions();
    setSessions(list);
  }, []);

  const showCached = useCallback((id: string | null) => {
    setMessages(id ? cache.current.get(id) ?? [] : []);
  }, []);

  const loadSession = useCallback(async (id: string) => {
    if (streamingRef.current === id) return;
    const detail = await api.session(id);
    const mapped = detail.messages.map(fromServerMessage);
    const previous = [...(cache.current.get(id) ?? [])].reverse().find((message) => message.role === "assistant");
    const last = [...mapped].reverse().find((message) => message.role === "assistant");
    if (last && previous?.thinking) last.thinking = previous.thinking;
    if (last && previous && previous.notices.length) last.notices = previous.notices;
    // A failed turn stores the user event and no assistant row. Keep the error the stream just showed.
    if (previous && (previous.error || previous.stopped) && mapped.at(-1)?.role !== "assistant") {
      mapped.push({ ...previous, pending: false });
    }
    cache.current.set(id, mapped);
    if (activeRef.current === id) {
      setMessages(mapped);
      setApproval(detail.pendingApproval);
      setProposal(detail.pendingProposal);
    }
  }, []);

  const connect = useCallback(async () => {
    setStatus("loading");
    try {
      const next = await api.health();
      setHealth(next);
      setStatus("ready");
      await refreshSessions();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setStatus("token");
      else setStatus("offline");
    }
  }, [refreshSessions]);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    const onHash = () => setActiveId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setApproval(null);
      setProposal(null);
      return;
    }
    showCached(activeId);
    if (streamingRef.current === activeId) return;
    void loadSession(activeId).catch(() => {});
  }, [activeId, loadSession, showCached]);

  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setInterval(() => {
      void refreshSessions().catch(() => {});
      const id = activeRef.current;
      if (id && streamingRef.current !== id) void loadSession(id).catch(() => {});
    }, 8000);
    return () => window.clearInterval(timer);
  }, [status, refreshSessions, loadSession]);

  function writeMessages(id: string, recipe: (prev: ChatMessage[]) => ChatMessage[]) {
    const next = recipe(cache.current.get(id) ?? []);
    cache.current.set(id, next);
    if (activeRef.current === id) setMessages(next);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streamingRef.current) return;
    setDraft("");
    let id = activeRef.current;
    if (!id) {
      const created = await api.createSession();
      id = created.id;
      cache.current.set(id, []);
      window.location.hash = `#/c/${id}`;
      setActiveId(id);
      activeRef.current = id;
    }
    const messageId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    writeMessages(id, (prev) => [
      ...prev,
      { key: messageId, role: "user", text: trimmed, tools: [], steps: [], notices: [], attachments: [] },
    ]);
    setStreamingId(id);
    streamingRef.current = id;
    setSidebar(false);
    try {
      await streamMessage(id, trimmed, messageId, (event: ServerEvent) => {
        writeMessages(id!, (prev) => applyEvent(prev, event));
      });
      await refreshSessions();
      streamingRef.current = null;
      setStreamingId(null);
      await loadSession(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeMessages(id, (prev) => applyEvent(prev, { type: "error", message }));
      streamingRef.current = null;
      setStreamingId(null);
    }
  }

  async function stop() {
    const id = streamingRef.current;
    if (!id) return;
    await api.stop(id).catch(() => {});
  }

  const ownerName = health?.ownerName ?? (locale === "zh" ? "你" : "you");

  return (
    <>
      <link rel="stylesheet" href={theme === "dark" ? darkHljs : lightHljs} />
      <div className="app">
        <Sidebar
          open={sidebar}
          health={health}
          sessions={sessions}
          activeId={activeId}
          locale={locale}
          thinking={streamingId !== null}
          t={t}
          onNew={() => {
            window.location.hash = "#/";
            setActiveId(null);
            setSidebar(false);
            setDraft("");
          }}
          onSelect={(id) => {
            window.location.hash = `#/c/${id}`;
            setActiveId(id);
            setSidebar(false);
          }}
        />
        <button type="button" className={`backdrop ${sidebar ? "show" : ""}`} aria-label={t("close")} onClick={() => setSidebar(false)} />
        <main className="main">
          <header className="topbar">
            <button type="button" className="icon-btn menu-btn" aria-label={t("menu")} onClick={() => setSidebar(true)}>
              <MenuIcon />
            </button>
            <div className="brand">
              <Mark size={22} thinking={streamingId !== null} />
              <span>{t("appName")}</span>
            </div>
            <div className="min-w-0 flex-1" />
            <button
              type="button"
              className="icon-btn"
              aria-label={theme === "dark" ? t("themeToLight") : t("themeToDark")}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              type="button"
              className="text-btn px-2 text-sm"
              onClick={() => {
                const next = locale === "zh" ? "en" : "zh";
                localStorage.setItem(LANG_KEY, next);
                setLocale(next);
              }}
            >
              {t("language")}
            </button>
            <button type="button" className={`text-btn px-3 text-sm ${panel ? "text-ink" : ""}`} onClick={() => setPanel((value) => !value)}>
              {t("inspect")}
            </button>
          </header>

          {status === "loading" ? <Centered>{t("connecting")}</Centered> : null}
          {status === "offline" ? (
            <Centered>
              <h1 className="text-xl font-semibold">{t("offlineTitle")}</h1>
              <p className="mt-2 max-w-md text-sm text-muted">{t("offlineBody")}</p>
              <button type="button" className="chip on mt-4" onClick={() => void connect()}>
                {t("retry")}
              </button>
            </Centered>
          ) : null}
          {status === "token" ? (
            <Centered>
              <form
                className="card w-full max-w-sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  setToken(tokenDraft);
                  void connect();
                }}
              >
                <h1 className="text-lg font-semibold">{t("tokenTitle")}</h1>
                <p className="mt-2 text-sm text-muted">{t("tokenBody")}</p>
                <input
                  className="mt-3 w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none"
                  type="password"
                  value={tokenDraft}
                  placeholder={t("tokenPlaceholder")}
                  onChange={(event) => setTokenDraft(event.target.value)}
                  autoFocus
                />
                <button type="submit" className="chip on mt-3">
                  {t("tokenSave")}
                </button>
              </form>
            </Centered>
          ) : null}
          {status === "ready" ? (
            <ChatView
              ownerName={ownerName}
              messages={messages}
              streaming={streamingId !== null}
              busyNote={streamingId && streamingId !== activeId ? t("busyElsewhere") : undefined}
              draft={draft}
              onDraft={setDraft}
              onSend={() => void send(draft)}
              onStop={() => void stop()}
              onSuggest={(text) => void send(text)}
              onPlus={() => setPanel((value) => !value)}
              approval={approval}
              proposal={proposal}
              t={t}
              disabled={false}
            />
          ) : null}
          <AnimatePresence>
            {panel && status === "ready" ? (
              <motion.aside
                className="panel"
                initial={reduce ? false : { x: 36, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={reduce ? undefined : { x: 28, opacity: 0 }}
                transition={spring}
              >
                <InspectPanel chatId={activeId} locale={locale} t={t} onClose={() => setPanel(false)} />
              </motion.aside>
            ) : null}
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center px-6 text-center">{children}</div>;
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 2.5v1.5M9 14v1.5M2.5 9H4M14 9h1.5M4.2 4.2l1 1M12.8 12.8l1 1M13.8 4.2l-1 1M5.2 12.8l-1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M10 2.5a6 6 0 1 0 5.5 8.5A5 5 0 0 1 10 2.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
