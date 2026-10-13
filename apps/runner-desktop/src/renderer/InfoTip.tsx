import { useEffect, useId, useRef, useState } from 'react';

/** What a screen says about a choice beyond its one short line: the topic names the button, the text is what opens. */
export interface Tip {
  readonly topic: string;
  readonly text: string;
}

/**
 * The longer words of a choice, behind a small (i) button beside it. The text is always text, never markup. It opens on a click, Enter or Space
 * (the native button's own), closes on Escape (the focus goes back to the button) or a press anywhere else, and sits in the flow of the page below
 * the line, as wide as the screen at most: nothing is measured or placed by script, so it cannot run off the window.
 */
export function InfoTip({ topic, children }: { readonly topic: string; readonly children: string }) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      opener.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <span className="info" ref={wrapper}>
      <button ref={opener} type="button" className="info-button" aria-label={`More about ${topic}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="8" cy="4.9" r="1" fill="currentColor" />
          <rect x="7.2" y="7" width="1.6" height="5" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      <span id={id} className="info-pop" hidden={!open}>
        {children}
      </span>
    </span>
  );
}
