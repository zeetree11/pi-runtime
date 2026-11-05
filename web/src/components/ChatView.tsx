import { useEffect, useRef } from "react";
import { greetingKey, type Key } from "../i18n";
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
  approval: PendingApproval | null;
  proposal: PendingProposal | null;
  busyNote?: string;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  disabled: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming, draft]);

  const empty = messages.length === 0;
  return (
    <>
      <div
        className="transcript"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={`column ${empty ? "flex min-h-full flex-col justify-center" : "space-y-8 py-4"}`}>
          {empty ? (
            <div className="px-2 pb-8">
              <Mark size={44} />
              <h1 className="mt-5 text-[2rem] font-semibold tracking-tight">
                {t("greetLine", { greet: t(greetingKey()), name: ownerName })}
              </h1>
              <p className="mt-2 max-w-xl text-muted">{t("emptyHint")}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {SUGGESTIONS.map((key) => (
                  <button key={key} type="button" className="chip" disabled={disabled} onClick={() => onSuggest(t(key))}>
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <Message key={message.key} message={message} t={t} copyLabel={t("copy")} copiedLabel={t("copied")} />
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
      {busyNote ? <p className="column px-5 pb-2 text-center text-xs text-muted">{busyNote}</p> : null}
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
        hint={t("enterHint")}
      />
    </>
  );
}
