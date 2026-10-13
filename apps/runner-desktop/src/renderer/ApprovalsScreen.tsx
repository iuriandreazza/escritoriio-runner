import { useState } from 'react';
import { useAction, useRunner } from './runner-state.tsx';
import type { PendingApproval } from './runner-state.tsx';
import { Problem, Screen, Text } from './ui.tsx';

const ACCESS_WORDS = {
  'read-only': 'Read only: it can look at the folder and cannot change it.',
  edit: 'Edit: it can change files in the folder, and run commands that can read the rest of this machine.',
} as const;

type Task = Exclude<PendingApproval, { kind: 'clone' }>;
type Clone = Extract<PendingApproval, { kind: 'clone' }>;

/** The buttons and the answer of one ask: Deny comes first, and is what has the focus when the ask is the first thing waiting, so that Enter refuses. */
function Answer({ approval, first, gone }: { readonly approval: PendingApproval; readonly first: boolean; readonly gone: string }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [over, setOver] = useState(false);

  const answer = async (choice: 'approved' | 'denied') => {
    const outcome = await run(() => api.call('approvals:answer', { taskId: approval.taskId, askId: approval.askId, answer: choice }));
    if (outcome && !outcome.answered) setOver(true);
  };

  return (
    <>
      <div className="row">
        <button type="button" autoFocus={first} disabled={busy} onClick={() => void answer('denied')}>
          Deny
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void answer('approved')}>
          Approve
        </button>
      </div>
      <Problem>{problem}</Problem>
      {over ? <p className="muted" role="status">{gone}</p> : null}
    </>
  );
}

function TaskApproval({ approval, first }: { readonly approval: Task; readonly first: boolean }) {
  return (
    <li className="card">
      <h3>
        Folder <Text>{approval.folder}</Text>
      </h3>
      <p className="small">{ACCESS_WORDS[approval.access]}</p>
      <p className="muted small">The instruction, exactly as the office sent it:</p>
      <pre className="instruction" tabIndex={0} role="region" aria-label={`Instruction of task ${approval.taskId}`}>
        <Text>{approval.instruction}</Text>
      </pre>
      <Answer approval={approval} first={first} gone="That task is not waiting any more." />
    </li>
  );
}

function CloneApproval({ approval, first }: { readonly approval: Clone; readonly first: boolean }) {
  return (
    <li className="card">
      <h3>Clone a repository</h3>
      <p className="small">
        The agent of the working folder <strong><Text>{approval.workspace}</Text></strong> asks to clone it into a new folder called <strong><Text>{approval.folder}</Text></strong>.
      </p>
      <p className="muted small">The address, exactly as it would be used:</p>
      <pre className="instruction" tabIndex={0} role="region" aria-label={`Address to clone for task ${approval.taskId}`}>
        <Text>{approval.url}</Text>
      </pre>
      <p className="muted small">Nothing is cloned unless you approve. It is cloned by this app, with your own git credentials, and runs nothing that the repository carries.</p>
      <Answer approval={approval} first={first} gone="That request is not waiting any more." />
    </li>
  );
}

export function ApprovalsScreen() {
  const { live } = useRunner();
  return (
    <Screen title="Approvals" intro="Tasks for folders that ask first, and repositories a working folder wants to clone, wait here." tip={{ topic: 'approving', text: 'Approving lets a task start with exactly the instruction you read, in that folder, or a repository be cloned from exactly the address you read; denying ends it.' }}>
      {live.approvals.length === 0 ? (
        <p className="muted">Nothing is waiting for you.</p>
      ) : (
        <ul className="plain-list" aria-label="Waiting for you">
          {live.approvals.map((approval, index) =>
            approval.kind === 'clone' ? <CloneApproval key={approval.askId} approval={approval} first={index === 0} /> : <TaskApproval key={approval.askId} approval={approval} first={index === 0} />,
          )}
        </ul>
      )}
    </Screen>
  );
}
