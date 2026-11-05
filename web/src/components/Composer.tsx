import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useMotionPreset } from "../motion";

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  sendLabel,
  stopLabel,
  onPlus,
  plusLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled: boolean;
  placeholder: string;
  sendLabel: string;
  stopLabel: string;
  onPlus?: () => void;
  plusLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { reduce } = useMotionPreset();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="composer-dock">
      <div className="column">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!streaming) onSend();
          }}
        >
          <div className="contents">
            <button type="button" className="plus" aria-label={plusLabel} onClick={onPlus}>
              +
            </button>
            <textarea
              ref={ref}
              rows={1}
              value={value}
              disabled={disabled}
              placeholder={placeholder}
              aria-label={placeholder}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (!streaming) onSend();
                }
              }}
            />
            <motion.button
              type={streaming ? "button" : "submit"}
              className={`send ${streaming ? "stop" : ""}`}
              aria-label={streaming ? stopLabel : sendLabel}
              disabled={!streaming && (disabled || !value.trim())}
              onClick={streaming ? onStop : undefined}
              whileHover={reduce || (!streaming && !value.trim()) ? undefined : { scale: 1.06 }}
              whileTap={reduce ? undefined : { scale: 0.92 }}
              transition={{ type: "spring", stiffness: 500, damping: 28 }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={streaming ? "stop" : "send"}
                  initial={reduce ? false : { opacity: 0, scale: 0.6, rotate: streaming ? -20 : 20 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.6 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className="grid place-items-center"
                >
                  {streaming ? <Square /> : <Arrow />}
                </motion.span>
              </AnimatePresence>
            </motion.button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Square() {
  return <span className="block h-3 w-3 rounded-[3px] bg-current" />;
}
