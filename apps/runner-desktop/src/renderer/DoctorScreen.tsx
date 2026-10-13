import { useState } from 'react';
import type { Reply } from '../shared/channels.ts';
import { visible } from './plain.ts';
import { useAction, useRunner } from './runner-state.tsx';
import { Problem, Screen, Text } from './ui.tsx';

type Report = Reply<'doctor:run'>;

const STATUS_WORDS = { ok: 'OK', warn: 'Warning', fail: 'Failed' } as const;

/** The report as plain text: the main process has already taken the usual secret shapes out of it, and this adds nothing to it. */
const reportText = (report: Report): string => ['Escritoriio Runner: checks', ...report.checks.map((check) => `[${check.status}] ${visible(check.title)}: ${visible(check.message)}`)].join('\n');

/** The clipboard of the page is asked first; a page that is not granted it falls back to the old way, which needs no grant. */
async function copy(text: string, field: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!field) return false;
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

export function DoctorScreen() {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [report, setReport] = useState<Report | undefined>();
  const [copied, setCopied] = useState<boolean | undefined>();
  const [field, setField] = useState<HTMLTextAreaElement | null>(null);

  const check = async () => {
    setCopied(undefined);
    const result = await run(() => api.call('doctor:run', {}));
    if (result) setReport(result);
  };

  return (
    <Screen title="Doctor" intro="Looks at the coding agents, the connection, the folders and the clock." tip={{ topic: 'the report', text: 'The report has the usual secrets taken out before it leaves the machine, so it is safe to send to whoever helps you.' }}>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void check()}>
          Run the checks
        </button>
        {busy ? <span className="muted" role="status">Looking…</span> : null}
      </div>
      <Problem>{problem}</Problem>
      {report ? (
        <>
          <p role="status" className="status-word small-word">
            {report.healthy ? 'Everything is fine.' : 'Something needs a look.'}
          </p>
          <ul className="plain-list" aria-label="Checks">
            {report.checks.map((item) => (
              <li key={item.id} className={`card check ${item.status}`}>
                <p>
                  <span className={`badge ${item.status}`}>{STATUS_WORDS[item.status]}</span> <strong><Text>{item.title}</Text></strong>
                </p>
                <p className="wrap"><Text>{item.message}</Text></p>
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" onClick={() => void copy(reportText(report), field).then(setCopied)}>
              Copy the report
            </button>
            {copied === true ? <span role="status">Copied.</span> : null}
          </div>
          {copied === false ? <p role="status" className="muted">Could not copy it. Select the text of the report and copy it by hand.</p> : null}
          <label className="visually-hidden" htmlFor="report-text">
            The report as text
          </label>
          <textarea id="report-text" ref={setField} className="report" readOnly rows={Math.min(12, report.checks.length + 2)} value={reportText(report)} />
        </>
      ) : null}
    </Screen>
  );
}
