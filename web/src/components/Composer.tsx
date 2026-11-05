import { useEffect, useRef } from "react";

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
  hint,
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
  hint: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
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
          <div className="flex items-end gap-2">
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
            {streaming ? (
              <button type="button" className="stop" aria-label={stopLabel} onClick={onStop}>
                <span className="block h-3 w-3 rounded-[3px] bg-current" />
              </button>
            ) : (
              <button type="submit" className="send" aria-label={sendLabel} disabled={disabled || !value.trim()}>
                <Arrow />
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">{hint}</p>
        </form>
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
