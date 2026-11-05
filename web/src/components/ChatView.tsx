import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { greetingKey, type Key } from "../i18n";
import { useMotionPreset } from "../motion";
import type { ChatMessage, PendingApproval, PendingProposal } from "../types";
import { Composer } from "./Composer";
import { Mark } from "./Mark";
import { Message } from "./Message";

const SUGGESTIONS: Key[] = ["suggest1", "suggest2", "suggest3", "suggest4"];

export function ChatView({
  ownerName,
  messages,
  streaming,
  draft,
  onDraft,
  onSend,
  onStop,
  onSuggest,
  onPlus,
  approval,
  proposal,
  busyNote,
  t,
  disabled,
}: {
  ownerName: string;
  messages: ChatMessage[];
  streaming: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onSuggest: (text: string) => void;
  onPlus?: () => void;
  approval: PendingApproval | null;
  proposal: PendingProposal | null;
  busyNote?: string;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  disabled: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seen = useRef(new Set<string>());
  const [away, setAway] = useState(false);
  const { reduce, spring, soft } = useMotionPreset();

  useEffect(() => {
    for (const message of messages) seen.current.add(message.key);
  }, [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    const pending = messages.at(-1)?.pending;
    el.scrollTo({ top: el.scrollHeight, behavior: pending || reduce ? "auto" : "smooth" });
  }, [messages, streaming, reduce]);

  function jump() {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }

  const empty = messages.length === 0;
  return (
    <>
      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAway(!near && messages.length > 0);
        }}
      >
        <div className={`column ${empty ? "flex min-h-[calc(100%-8px)] flex-col justify-center" : "space-y-3 pb-6"}`}>
          {empty ? (
            <motion.div initial={reduce ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="px-1 pb-10">
              <motion.div initial={reduce ? false : { scale: 0.84, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
                <Mark size={56} thinking={streaming} />
              </motion.div>
              <h1 className="greeting">{t("greetLine", { greet: t(greetingKey()), name: ownerName })}</h1>
              <p className="mt-3 max-w-lg text-[15px] text-muted">{t("emptyHint")}</p>
              <div className="mt-7 flex flex-wrap gap-2">
                {SUGGESTIONS.map((key, index) => (
                  <motion.button
                    key={key}
                    type="button"
                    className="chip"
                    disabled={disabled}
                    initial={reduce ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...soft, delay: reduce ? 0 : 0.08 + index * 0.06 }}
                    whileHover={reduce ? undefined : { y: -3 }}
                    whileTap={reduce ? undefined : { scale: 0.98 }}
                    onClick={() => onSuggest(t(key))}
                  >
                    {t(key)}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          ) : (
            messages.map((message) => (
              <Message
                key={message.key}
                message={message}
                fresh={!seen.current.has(message.key)}
                t={t}
                copyLabel={t("copy")}
                copiedLabel={t("copied")}
              />
            ))
          )}
          {approval ? (
            <div className="card">
              <div className="text-xs text-muted">{t("pendingApproval")}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{approval.prompt}</p>
              <div className="mt-3 flex gap-2">
                <button type="button" className="chip on" onClick={() => onSuggest(t("approve"))}>
                  {t("approve")}
                </button>
                <button type="button" className="chip" onClick={() => onSuggest(t("deny"))}>
                  {t("deny")}
                </button>
              </div>
            </div>
          ) : null}
          {proposal ? (
            <div className="card">
              <div className="text-xs text-muted">{t("proposal")}</div>
              <p className="mt-1 text-sm font-medium">{proposal.path}</p>
              {proposal.rationale ? <p className="mt-1 text-sm text-muted">{proposal.rationale}</p> : null}
              <div className="mt-3 flex gap-2">
                <button type="button" className="chip on" onClick={() => onSuggest(t("approve"))}>
                  {t("approve")}
                </button>
                <button type="button" className="chip" onClick={() => onSuggest(t("deny"))}>
                  {t("deny")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <AnimatePresence>
        {away ? (
          <motion.button
            type="button"
            className="jump"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 8 }}
            onClick={jump}
          >
            {t("jumpLatest")}
          </motion.button>
        ) : null}
      </AnimatePresence>
      {busyNote ? <p className="column px-7 pb-2 text-center text-xs text-muted">{busyNote}</p> : null}
      <Composer
        value={draft}
        onChange={onDraft}
        onSend={onSend}
        onStop={onStop}
        streaming={streaming}
        disabled={disabled}
        placeholder={t("composerPlaceholder")}
        sendLabel={t("send")}
        stopLabel={t("stop")}
        onPlus={onPlus}
        plusLabel={t("inspect")}
      />
    </>
  );
}
