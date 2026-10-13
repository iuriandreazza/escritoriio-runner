import { useState } from 'react';
import { useAction, useLook, useRunner } from './runner-state.tsx';
import type { UpdateState } from './runner-state.tsx';
import { InfoTip } from './InfoTip.tsx';
import { Loading, Problem, Screen, Text } from './ui.tsx';

function updateWords(update: UpdateState): string {
  const version = update.version ?? 'a new version';
  switch (update.state) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Looking for an update…';
    case 'none':
      return 'You have the latest version.';
    case 'available':
      return `Version ${version} is available.`;
    case 'downloading':
      return `Downloading version ${version}…`;
    case 'downloaded':
      return `Version ${version} is downloaded. It is installed when you restart the app.`;
    case 'unavailable':
      return 'Updates are not looked for here.';
    case 'error':
      return 'The update failed.';
  }
}

function LaunchAtLogin({ enabled, supported }: { readonly enabled: boolean; readonly supported: boolean }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [value, setValue] = useState(enabled);
  const [said, setSaid] = useState<string | undefined>();

  const change = async (wanted: boolean) => {
    setSaid(undefined);
    const outcome = await run(() => api.call('app:set-launch-at-login', { enabled: wanted }));
    if (!outcome) return;
    setValue(outcome.launchAtLogin);
    if (outcome.launchAtLogin !== wanted) setSaid('The system did not change it.');
  };

  return (
    <div className="choice">
      <input id="launch-at-login" type="checkbox" checked={value} disabled={!supported || busy} aria-describedby="launch-words" onChange={(event) => void change(event.target.checked)} />
      <span className="choice-head">
        <label htmlFor="launch-at-login">Open the app when I log in</label>
        <InfoTip topic="opening at login">Off by default. When it is on, the app starts by itself each time you log in to this computer and connects this machine to your office while it runs. It runs tasks only in the folders you shared.</InfoTip>
      </span>
      <p className="hint" id="launch-words">
        Starts the app by itself when you log in.
        {supported ? '' : ' This system cannot do it, so it cannot be turned on.'}
      </p>
      <Problem>{problem}</Problem>
      {said ? <p role="status" className="muted">{said}</p> : null}
    </div>
  );
}

function Updates({ supported }: { readonly supported: boolean }) {
  const { api, live, applyUpdate } = useRunner();
  const { busy, problem, run } = useAction();
  const { update } = live;
  const working = update.state === 'checking' || update.state === 'downloading';

  return (
    <section className="card" aria-labelledby="updates-title">
      <h3 id="updates-title">Updates</h3>
      <p role="status">{updateWords(update)}</p>
      {update.message ? (
        <p className="problem-line">
          <Text>{update.message}</Text>
        </p>
      ) : null}
      {supported ? null : (
        <p className="hint">
          Only an installed app looks for updates.{' '}
          <InfoTip topic="updates here">This one runs from its sources, and is updated by installing a new version.</InfoTip>
        </p>
      )}
      <div className="row">
        <button type="button" disabled={!supported || busy || working} onClick={() => void run(() => api.call('app:check-update', {})).then((state) => state && applyUpdate(state))}>
          Check for an update
        </button>
        {update.state === 'available' || update.state === 'downloaded' ? (
          <button type="button" className="primary" disabled={busy || working} onClick={() => void run(() => api.call('app:accept-update', {})).then((state) => state && applyUpdate(state))}>
            Accept the update…
          </button>
        ) : null}
      </div>
      <p className="hint">
        Nothing is downloaded or installed without your yes.{' '}
        <InfoTip topic="updating">The app never replaces itself on its own. Accepting opens a window that asks you before anything is downloaded, and another before the app restarts.</InfoTip>
      </p>
      <Problem>{problem}</Problem>
    </section>
  );
}

export function SettingsScreen() {
  const { look } = useLook('app:info');
  return (
    <Screen title="Settings">
      {look.status === 'loading' ? <Loading what="the settings" /> : null}
      {look.status === 'failed' ? <Problem>{look.problem}</Problem> : null}
      {look.status === 'ready' ? (
        <>
          <section className="card" aria-labelledby="start-title">
            <h3 id="start-title">Start</h3>
            <LaunchAtLogin enabled={look.value.launchAtLogin} supported={look.value.launchAtLoginSupported} />
          </section>
          <Updates supported={look.value.updatesSupported} />
          <section className="card" aria-labelledby="about-title">
            <h3 id="about-title">About</h3>
            <ul className="facts" aria-label="About this app">
              <li>
                <span className="label">App</span> <span><Text>{look.value.appVersion}</Text></span>
              </li>
              <li>
                <span className="label">Runner</span> <span><Text>{look.value.runnerVersion}</Text></span>
              </li>
              <li>
                <span className="label">System</span> <span><Text>{look.value.platform}</Text></span>
              </li>
              <li>
                <span className="label">State folder</span> <code><Text>{look.value.stateDirectory}</Text></code>{' '}
                <InfoTip topic="the state folder">The state folder is where this machine keeps its pairing and its settings. The token of the pairing is kept apart, protected by the system whenever it can.</InfoTip>
              </li>
            </ul>
          </section>
        </>
      ) : null}
    </Screen>
  );
}
