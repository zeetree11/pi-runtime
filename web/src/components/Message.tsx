import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { fileUrl } from "../api";
import type { Key } from "../i18n";
import { useMotionPreset } from "../motion";
import type { ChatMessage, LiveTool } from "../types";
import { Markdown } from "./Markdown";

export function Message({
  message,
  fresh,
  t,
  copyLabel,
  copiedLabel,
}: {
  message: ChatMessage;
  fresh: boolean;
  t: (key: Key) => string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const { reduce, spring } = useMotionPreset();
  const enter = fresh && !reduce ? { opacity: 0, y: 14 } : false;

  if (message.role === "user") {
    return (
      <motion.div className="flex justify-end" initial={enter} animate={{ opacity: 1, y: 0 }} transition={spring}>
        <div className="user-bubble">{message.text}</div>
      </motion.div>
    );
  }

  const waiting = Boolean(message.pending && !message.text);
  return (
    <motion.article className="assistant-copy" initial={enter} animate={{ opacity: 1, y: 0 }} transition={spring}>
      {message.notices.map((notice) => (
        <p key={notice} className="status-line">
          {t("notice")} · {notice}
        </p>
      ))}

      {waiting ? <ThinkingLabel label={t("thinkingNow")} /> : null}
      {message.thinking ? <Fold title={t("thinking")} text={message.thinking} startOpen={waiting} /> : null}
      {message.tools.map((tool) => (
        <ToolCard key={tool.callId} tool={tool} />
      ))}
      {message.steps.length > 0 ? <Fold title={t("steps")} text={message.steps.join("\n")} startOpen={false} /> : null}
      {message.attachments.map((file) => (
        <a key={file.path} className="status-line" href={fileUrl(file.path)}>
          {t("attachment")} · {file.name}
        </a>
      ))}

      {message.text ? (
        <div className={`assistant-bubble ${message.pending ? "streaming-copy" : ""}`}>
          <Markdown text={message.text} copyLabel={copyLabel} copiedLabel={copiedLabel} />
        </div>
      ) : null}
      {message.stopped && !message.text ? <p className="text-sm text-muted">{t("stopped")}</p> : null}
      {message.error ? (
        <p className="mt-2 text-sm text-danger">
          {t("failed")} · {message.error}
        </p>
      ) : null}
    </motion.article>
  );
}

function ThinkingLabel({ label }: { label: string }) {
  return (
    <p className="mb-2">
      <span className="shimmer">{label}</span>
      <span className="dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </p>
  );
}

function Fold({ title, text, startOpen }: { title: string; text: string; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const { reduce, spring } = useMotionPreset();
  return (
    <div>
      <button type="button" className="status-line" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Check />
        <span>{title}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="body"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }}
            transition={spring}
            style={{ overflow: "hidden" }}
          >
            <div className="fold-body">{text}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ToolCard({ tool }: { tool: LiveTool }) {
  const running = tool.phase !== "end";
  const [open, setOpen] = useState(running);
  const { reduce, spring } = useMotionPreset();
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  const detail = [tool.argsPreview, tool.preview].filter(Boolean).join("\n");
  return (
    <div>
      <button type="button" className="status-line" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Status done={!running} error={Boolean(tool.isError)} />
        <span>{tool.name}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && detail ? (
          <motion.div
            key="body"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }}
            transition={spring}
            style={{ overflow: "hidden" }}
          >
            <div className="tool-body">
              <div className="preview">{detail}</div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Status({ done, error }: { done: boolean; error: boolean }) {
  return (
    <span className="grid h-4 w-4 place-items-center">
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span key="ok" className="check" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
            {error ? <Cross /> : <Check />}
          </motion.span>
        ) : (
          <motion.span key="spin" className="spinner" exit={{ opacity: 0 }} />
        )}
      </AnimatePresence>
    </span>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.2 5.7 10 11 4.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4 4l6 6M10 4 4 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
