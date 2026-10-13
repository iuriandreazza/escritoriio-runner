import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import { InfoTip } from './InfoTip.tsx';
import type { Tip } from './InfoTip.tsx';
import { visible } from './plain.ts';

/** A text from the office or the machine: always text, with what hides or reorders shown by its code point. The one way such a text is drawn. */
export function Text({ children }: { readonly children: string }) {
  return <>{visible(children)}</>;
}

/** A failure, in words. Spoken at once by a screen reader. */
export function Problem({ children }: { readonly children: string | undefined }) {
  return children ? (
    <p className="problem" role="alert">
      <Text>{children}</Text>
    </p>
  ) : null;
}

export function Loading({ what }: { readonly what: string }) {
  return <p className="muted" role="status">{`Looking at ${what}…`}</p>;
}

/**
 * A button that asks before it does: pressing it shows the question with the safe answer first and focused, so that Enter keeps things as they are.
 * Nothing the office says is in the question: it is words of the app.
 */
export function ConfirmAction({
  label,
  question,
  confirmLabel,
  keepLabel = 'Keep it',
  disabled = false,
  onConfirm,
}: {
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly keepLabel?: string;
  readonly disabled?: boolean;
  readonly onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();

  const close = () => {
    setAsking(false);
    // The question goes away, and so does what had the focus: it goes back to the button that asked.
    requestAnimationFrame(() => opener.current?.focus());
  };

  if (!asking) {
    return (
      <button ref={opener} type="button" className="danger-outline" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div role="group" aria-labelledby={id} className="confirm" onKeyDown={(event) => event.key === 'Escape' && close()}>
      <span id={id}>{question}</span>
      <button type="button" autoFocus onClick={close}>
        {keepLabel}
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

export function Screen({ title, intro, tip, children }: { readonly title: string; readonly intro?: string; readonly tip?: Tip; readonly children: ReactNode }) {
  return (
    <section className="screen" aria-labelledby="screen-title">
      <h2 id="screen-title" tabIndex={-1}>
        {title}
      </h2>
      {intro ? (
        <p className="muted">
          {intro}
          {tip ? <> <InfoTip topic={tip.topic}>{tip.text}</InfoTip></> : null}
        </p>
      ) : null}
      {children}
    </section>
  );
}

export function Field({ label, hint, tip, children }: { readonly label: string; readonly hint?: string; readonly tip?: Tip; readonly children: (props: { id: string; 'aria-describedby'?: string }) => ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <span className="choice-head">
        <label htmlFor={id}>{label}</label>
        {tip ? <InfoTip topic={tip.topic}>{tip.text}</InfoTip> : null}
      </span>
      {children({ id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
