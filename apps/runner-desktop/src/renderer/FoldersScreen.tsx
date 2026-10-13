import { useState } from 'react';
import { AGENT_NAMES } from './agents.ts';
import { visible as visibleLabel } from './plain.ts';
import type { FolderOptionValues } from './FolderOptions.tsx';
import { FolderOptions, NARROWEST, WORKING_FOLDER } from './FolderOptions.tsx';
import { InfoTip } from './InfoTip.tsx';
import type { Reply } from '../shared/channels.ts';
import { useAction, useLook, useRunner } from './runner-state.tsx';
import { ConfirmAction, Loading, Problem, Screen, Text } from './ui.tsx';

type FolderView = Reply<'folders:list'>[number];

const ACCESS = { 'read-only': 'Read only', edit: 'Edit' } as const;
const APPROVAL = { auto: 'Runs without asking', ask: 'Asks you first' } as const;
const WORKING_FOLDER_LINE = 'The agent may create folders in it and ask to clone repositories, which you approve one by one.';

const ISOLATION = { worktree: 'A copy on its own branch', 'in-place': 'In place' } as const;

function changesOf(initial: FolderOptionValues, next: FolderOptionValues) {
  const entries = (Object.keys(initial) as (keyof FolderOptionValues)[]).filter((key) => initial[key] !== next[key]).map((key) => [key, next[key]]);
  return Object.fromEntries(entries) as Partial<FolderOptionValues>;
}

function Folder({ view, onChanged }: { readonly view: FolderView; readonly onChanged: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [said, setSaid] = useState<string | undefined>();
  const { folder } = view;
  const current: FolderOptionValues = { access: folder.access, approval: folder.approval, isolation: folder.isolation, trusted: folder.trusted, agent: folder.agent };

  return (
    <li className="card">
      <div className="row between">
        <h3>
          <Text>{folder.label}</Text>
        </h3>
        <div className="row">
          <button type="button" aria-expanded={editing} disabled={busy} onClick={() => setEditing(!editing)}>
            Change options
          </button>
          <ConfirmAction
            label="Remove"
            question="Stop sharing this folder? Nothing is deleted."
            confirmLabel="Yes, stop sharing"
            disabled={busy}
            onConfirm={() => void run(() => api.call('folders:remove', { label: folder.label })).then((done) => done && onChanged())}
          />
        </div>
      </div>
      <p className="muted small wrap">
        <code><Text>{folder.path}</Text></code>
      </p>
      <ul className="tags" aria-label={`How ${visibleLabel(folder.label)} is shared`}>
        {folder.kind === 'workspace' ? <li className="badge">Working folder</li> : null}
        <li className={folder.access === 'edit' ? 'badge warn' : 'badge'}>{ACCESS[folder.access]}</li>
        <li className="badge">{APPROVAL[folder.approval]}</li>
        <li className="badge">{ISOLATION[folder.isolation]}</li>
        <li className={folder.trusted ? 'badge warn' : 'badge'}>{folder.trusted ? 'Trusted' : 'Not trusted'}</li>
        <li className="badge">{folder.agent ? AGENT_NAMES[folder.agent] : 'Any coding agent'}</li>
      </ul>
      {folder.kind === 'workspace' ? <p className="muted small">{WORKING_FOLDER_LINE}</p> : null}
      {view.problem ? (
        <p className="problem-line" role="status">
          <Text>{view.problem}</Text>
        </p>
      ) : null}
      {editing ? (
        <FolderOptions
          initial={current}
          withLabel={false}
          workingFolder={folder.kind === 'workspace'}
          name={`Options of ${visibleLabel(folder.label)}`}
          submitLabel="Save changes"
          busy={busy}
          onSubmit={(values) =>
            void run(() => api.call('folders:update', { label: folder.label, changes: changesOf(current, values) })).then((done) => {
              if (!done) return;
              setSaid(done.updated ? undefined : 'Nothing was changed.');
              if (done.updated) setEditing(false);
              onChanged();
            })
          }
        />
      ) : null}
      <Problem>{problem}</Problem>
      {said ? <p className="muted" role="status">{said}</p> : null}
    </li>
  );
}

function AddFolder({ onAdded }: { readonly onAdded: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | undefined>();

  const add = async (values: FolderOptionValues, label: string) => {
    setSaid(undefined);
    const outcome = await run(() => api.call('folders:add', label === '' ? values : { ...values, label }));
    if (!outcome) return;
    if (outcome.added) {
      setSaid(`Shared "${visibleLabel(outcome.label ?? 'the folder')}".`);
      setOpen(false);
      onAdded();
    } else {
      setSaid(outcome.message ?? 'The folder was not shared.');
    }
  };

  return (
    <section className="card" aria-label="Add a folder">
      {open ? null : (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Add a folder
        </button>
      )}
      {open ? (
        <>
          <h3>Share a folder</h3>
          <p className="muted">You pick the folder in the system's own window, next. The first choices are the narrowest.</p>
          <FolderOptions initial={NARROWEST} withLabel name="Share a folder" submitLabel="Choose the folder…" busy={busy} onSubmit={(values, label) => void add(values, label)} />
        </>
      ) : null}
      <Problem>{problem}</Problem>
      {said ? <p role="status">{said}</p> : null}
    </section>
  );
}

function NewWorkingFolder({ onMade }: { readonly onMade: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | undefined>();

  const make = async ({ approval, trusted, agent }: FolderOptionValues, label: string, name: string) => {
    setSaid(undefined);
    const outcome = await run(() => api.call('folders:new-workspace', { name, approval, trusted, agent, ...(label === '' ? {} : { label }) }));
    if (!outcome) return;
    if (outcome.added) {
      setSaid(`Made and shared "${visibleLabel(outcome.label ?? name)}".`);
      setOpen(false);
      onMade();
    } else {
      setSaid(outcome.message ?? 'The folder was not made.');
    }
  };

  return (
    <section className="card" aria-label="New empty working folder">
      {open ? null : (
        <button type="button" onClick={() => setOpen(true)}>
          New empty working folder
        </button>
      )}
      {open ? (
        <>
          <h3>
            New empty working folder{' '}
            <InfoTip topic="the working folder">
              An empty folder that this app makes for the agent to build in. The agent builds in it with no copy and no branch, so what it does is in the folder at once. It has file tools and a shell like any folder it may edit. It may create folders inside it without asking you (each a git repository), and may ask to clone repositories, which you approve one by one on the Approvals screen. Nothing is pushed.
            </InfoTip>
          </h3>
          <p className="muted">You pick where to make it in the system's own window, next, and a window of the app asks before anything is made.</p>
          <FolderOptions initial={WORKING_FOLDER} withLabel withName workingFolder name="New empty working folder" submitLabel="Choose where to make it…" busy={busy} onSubmit={(values, label, name) => void make(values, label, name)} />
        </>
      ) : null}
      <Problem>{problem}</Problem>
      {said ? <p role="status">{said}</p> : null}
    </section>
  );
}

export function FoldersScreen() {
  const { look, reload } = useLook('folders:list');
  return (
    <Screen title="Folders" intro="The folders this machine shares with the office." tip={{ topic: 'shared folders', text: 'Nothing else on the machine is reachable by a task, and the list changes only here, by you.' }}>
      <AddFolder onAdded={reload} />
      <NewWorkingFolder onMade={reload} />
      {look.status === 'loading' ? <Loading what="the folders" /> : null}
      {look.status === 'failed' ? <Problem>{look.problem}</Problem> : null}
      {look.status === 'ready' && look.value.length === 0 ? <p className="muted">No folder is shared yet. Add one to let the office's AI member work in it.</p> : null}
      {look.status === 'ready' && look.value.length > 0 ? (
        <ul className="plain-list" aria-label="Shared folders">
          {look.value.map((view) => (
            <Folder key={view.folder.label} view={view} onChanged={reload} />
          ))}
        </ul>
      ) : null}
    </Screen>
  );
}
