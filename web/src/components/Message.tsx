import { useEffect, useRef, useState } from "react";
import { fileUrl } from "../api";
import type { Key } from "../i18n";
import type { ChatMessage } from "../types";
import { Markdown } from "./Markdown";

export function Message({
  message,
  t,
  copyLabel,
  copiedLabel,
}: {
  message: ChatMessage;
  t: (key: Key) => string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(Boolean(message.pending && !message.text));
  const [toolsOpen, setToolsOpen] = useState(Boolean(message.pending));
  const [stepsOpen, setStepsOpen] = useState(false);
  const folded = useRef(false);

  useEffect(() => {
    if (!folded.current && !message.pending && message.text) {
      folded.current = true;
      setThinkingOpen(false);
      setToolsOpen(false);
    }
  }, [message.pending, message.text]);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="user-bubble">{message.text}</div>
      </div>
    );
  }

  const showBody = message.text || message.pending || message.error || message.stopped;
  return (
    <article className="pr-2">
      <div className="mb-1 flex items-center gap-2 text-sm text-muted">
        <span className="font-medium text-ink">Tree-Agent</span>
        {message.pending ? (
          <span className="inline-flex items-center gap-2">
            <span className="pulse" />
            {t("streaming")}
          </span>
        ) : null}
      </div>

      {message.notices.map((notice) => (
        <p key={notice} className="mb-2 text-sm text-muted">
          {t("notice")} · {notice}
        </p>
      ))}

      {message.thinking ? (
        <details className="disclosure" open={thinkingOpen} onToggle={(event) => setThinkingOpen(event.currentTarget.open)}>
          <summary>{t("thinking")}</summary>
          <div className="body">{message.thinking}</div>
        </details>
      ) : null}

      {message.tools.length > 0 ? (
        <details className="disclosure" open={toolsOpen} onToggle={(event) => setToolsOpen(event.currentTarget.open)}>
          <summary>
            {t("tools")} · {message.tools.map((tool) => tool.name).join("、")}
          </summary>
          <div className="body">
            {message.tools.map((tool) => (
              <div key={tool.callId} className="tool-row">
                <div className="tool-name">
                  {tool.name}
                  {tool.phase === "start" ? " …" : ""}
                  {tool.isError ? " · error" : ""}
                </div>
                {tool.argsPreview ? <div className="preview">{tool.argsPreview}</div> : null}
                {tool.preview ? <div className="preview">{tool.preview}</div> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {message.steps.length > 0 ? (
        <details className="disclosure" open={stepsOpen} onToggle={(event) => setStepsOpen(event.currentTarget.open)}>
          <summary>{t("steps")}</summary>
          <div className="body">{message.steps.join("\n")}</div>
        </details>
      ) : null}

      {message.attachments.map((file) => (
        <p key={file.path} className="my-2 text-sm">
          <a className="text-accent" href={fileUrl(file.path)}>
            {t("attachment")} · {file.name}
          </a>
          <span className="text-muted"> · {(file.bytes / 1024).toFixed(1)} KB</span>
        </p>
      ))}

      {showBody && message.text ? <Markdown text={message.text} copyLabel={copyLabel} copiedLabel={copiedLabel} /> : null}
      {message.pending && !message.text ? <span className="pulse" /> : null}
      {message.stopped && !message.text ? <p className="text-sm text-muted">{t("stopped")}</p> : null}
      {message.error ? (
        <p className="mt-2 text-sm text-danger">
          {t("failed")} · {message.error}
        </p>
      ) : null}
    </article>
  );
}
