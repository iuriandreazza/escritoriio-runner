import { useState } from 'react';
import type { Reply } from '../shared/channels.ts';
import { AGENT_NAMES } from './agents.ts';
import { useAction, useLook, useRunner } from './runner-state.tsx';
import { Loading, Problem, Screen, Text } from './ui.tsx';

type AgentView = Reply<'agents:inspect'>[number];

const CONTAINMENT = {
  sandbox: 'Contained by the sandbox of the system.',
  none: 'No containment here: it runs only in trusted folders.',
} as const;

function Login({ loggedIn }: { readonly loggedIn: boolean | null }) {
  if (loggedIn === null) return <>Login not checked</>;
  return <>{loggedIn ? 'Logged in' : 'Not logged in'}</>;
}

function Agent({ agent, onChanged }: { readonly agent: AgentView; readonly onChanged: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [said, setSaid] = useState<string | undefined>();
  const found = agent.detection;

  const choose = async () => {
    setSaid(undefined);
    const outcome = await run(() => api.call('agents:set-path', { kind: agent.kind }));
    if (!outcome) return;
    if (outcome.picked) onChanged();
    else setSaid('No file was chosen.');
  };

  return (
    <li className="card">
      <h3>{AGENT_NAMES[agent.kind]}</h3>
      {agent.drivable ? null : <p className="muted">This coding agent cannot be driven by this runner yet.</p>}
      {found ? (
        <ul className="facts" aria-label={`What was found of ${AGENT_NAMES[agent.kind]}`}>
          <li>{found.installed ? 'Found' : 'Not found'}</li>
          {found.path ? (
            <li>
              <span className="label">Where</span> <code><Text>{found.path}</Text></code>
            </li>
          ) : null}
          {found.version ? (
            <li>
              <span className="label">Version</span> <span><Text>{found.version}</Text></span>
            </li>
          ) : null}
          {found.installed ? (
            <li>
              <Login loggedIn={found.loggedIn} />
            </li>
          ) : null}
          {found.installed && !found.supported ? <li>This version is not supported</li> : null}
          <li>{CONTAINMENT[found.containment]}</li>
        </ul>
      ) : (
        <p className="muted">Not looked at yet.</p>
      )}
      {found?.problem ? (
        <p className="problem-line">
          <Text>{found.problem}</Text>
        </p>
      ) : null}
      {agent.pickedPath ? (
        <p className="small">
          <span className="label">Chosen by you</span> <code><Text>{agent.pickedPath}</Text></code>
        </p>
      ) : null}
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void choose()}>
          Choose where it is…
        </button>
        {agent.pickedPath ? (
          <button type="button" disabled={busy} onClick={() => void run(() => api.call('agents:clear-path', { kind: agent.kind })).then((done) => done && onChanged())}>
            Look for it by itself
          </button>
        ) : null}
      </div>
      <Problem>{problem}</Problem>
      {said ? <p className="muted" role="status">{said}</p> : null}
    </li>
  );
}

export function AgentsScreen() {
  const { look, reload } = useLook('agents:inspect');
  return (
    <Screen title="Coding agents" intro="The programs that do the work on this machine." tip={{ topic: 'finding a coding agent', text: "If one is not found by itself, choose where it is in the system's own window." }}>
      <div className="row">
        <button type="button" onClick={reload}>
          Look again
        </button>
      </div>
      {look.status === 'loading' ? <Loading what="the coding agents" /> : null}
      {look.status === 'failed' ? <Problem>{look.problem}</Problem> : null}
      {look.status === 'ready' ? (
        <ul className="plain-list" aria-label="Coding agents">
          {look.value.map((agent) => (
            <Agent key={agent.kind} agent={agent} onChanged={reload} />
          ))}
        </ul>
      ) : null}
    </Screen>
  );
}
