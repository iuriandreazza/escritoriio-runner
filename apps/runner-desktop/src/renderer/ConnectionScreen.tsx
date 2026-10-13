import { useState } from 'react';
import { headline, tone } from './connection-words.ts';
import { InfoTip } from './InfoTip.tsx';
import { PairingForm, PendingLink } from './PairingForm.tsx';
import { useAction, useRunner } from './runner-state.tsx';
import type { ConnectionView } from './runner-state.tsx';
import { Problem, Screen, Text } from './ui.tsx';

function Facts({ view }: { readonly view: ConnectionView }) {
  if (!view.device) return null;
  const { agentName, workspaceName, host, deviceName } = view.device;
  return (
    <ul className="facts" aria-label="This machine">
      <li>
        <span className="label">AI member</span> <span><Text>{agentName}</Text></span>
      </li>
      <li>
        <span className="label">Workspace</span> <span><Text>{workspaceName}</Text></span>
      </li>
      <li>
        <span className="label">Office</span> <span><Text>{host}</Text></span>
      </li>
      <li>
        <span className="label">This machine is called</span> <span><Text>{deviceName}</Text></span>
      </li>
    </ul>
  );
}

function PauseButton({ view }: { readonly view: ConnectionView }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const resuming = view.pausedHere;
  return (
    <>
      <button type="button" className={resuming ? 'big primary' : 'big'} disabled={busy} onClick={() => void run(() => api.call('pause:set', { paused: !resuming }))}>
        {resuming ? 'Resume' : 'Pause'}
      </button>
      <Problem>{problem}</Problem>
    </>
  );
}

function StartButton() {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [refusal, setRefusal] = useState<string | undefined>();
  const start = async () => {
    setRefusal(undefined);
    const outcome = await run(() => api.call('connection:start', {}));
    if (outcome && !outcome.started) setRefusal(outcome.message ?? 'The connection did not start.');
  };
  return (
    <>
      <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
        Start
      </button>
      <Problem>{refusal ?? problem}</Problem>
    </>
  );
}

function Pairing({ view }: { readonly view: ConnectionView }) {
  const { live } = useRunner();
  if (view.state === 'not-paired') {
    return (
      <>
        {live.pendingLink ? <PendingLink linkId={live.pendingLink.linkId} host={live.pendingLink.host} /> : null}
        <section className="card" aria-labelledby="pair-title">
          <h3 id="pair-title">Pair this machine</h3>
          <p className="muted">
            Ask for a code in the office, in My machines.{' '}
            <InfoTip topic="pairing">Pairing makes this machine work for one AI member of an office.</InfoTip>
          </p>
          <PairingForm />
        </section>
      </>
    );
  }
  if (view.state !== 'offline') {
    return (
      <p className="hint">
        Pairing again is possible only when the connection is off.{' '}
        <InfoTip topic="pairing again">The connection holds the pairing it is using. Pairing with another AI member is possible when the connection is off.</InfoTip>
      </p>
    );
  }
  return (
    <>
      {live.pendingLink ? <PendingLink linkId={live.pendingLink.linkId} host={live.pendingLink.host} /> : null}
      <details className="card">
        <summary>Pair with a different AI member</summary>
        <PairingForm />
      </details>
    </>
  );
}

export function ConnectionScreen() {
  const { live } = useRunner();
  const view = live.connection;
  if (!view) return <Screen title="Connection">{live.loadProblem ? <Problem>{live.loadProblem}</Problem> : <p className="muted" role="status">Looking at the connection…</p>}</Screen>;

  return (
    <Screen title="Connection">
      <section className={`status ${tone(view)}`} aria-label="Status">
        <p className="status-word">{headline(view)}</p>
        {view.pausedHere && view.pausedByOffice ? <p className="muted">It is also paused from the office, which has to resume it too.</p> : null}
        {view.pausedByOffice && !view.pausedHere ? <p className="muted">The office paused this machine, and only the office can resume it. You can also pause it here.</p> : null}
        {view.pausedHere && !view.pausedByOffice ? <p className="muted">No task is taken until you resume.</p> : null}
        {view.state === 'reconnecting' && view.retryInMs !== null ? <p className="muted">{`Trying again in about ${Math.max(1, Math.round(view.retryInMs / 1000))} s.`}</p> : null}
        {view.state === 'reconnecting' && view.slowRetry ? <p className="muted">The office has been unreachable for a while, so it tries less often.</p> : null}
        {view.lastError ? (
          <p className="problem-line">
            <span className="label">Last problem</span> <span><Text>{view.lastError}</Text></span>
          </p>
        ) : null}
        <Facts view={view} />
        {view.state !== 'not-paired' ? (
          <div className="row">
            <PauseButton view={view} />
            {view.state === 'offline' ? <StartButton /> : null}
          </div>
        ) : null}
      </section>
      <Pairing view={view} />
    </Screen>
  );
}
