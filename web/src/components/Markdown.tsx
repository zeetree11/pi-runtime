import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

export function Markdown({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const components: Components = {
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children }) {
      const fenced = Boolean(className);
      if (!fenced) return <code>{children}</code>;
      const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
      const raw = String(children).replace(/\n$/, "");
      return (
        <div className="code-block">
          <div className="code-bar">
            <span>{language}</span>
            <CopyButton text={raw} copyLabel={copyLabel} copiedLabel={copiedLabel} />
          </div>
          <pre>
            <code className={className}>{children}</code>
          </pre>
        </div>
      );
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };

  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "ok" : "copy"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.16 }}
        >
          {copied ? copiedLabel : copyLabel}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
