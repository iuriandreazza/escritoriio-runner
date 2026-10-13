import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentKind } from './agents.ts';
import { AGENT_KINDS, AGENT_NAMES } from './agents.ts';
import type { Request } from '../shared/channels.ts';
import { InfoTip } from './InfoTip.tsx';
import { Field } from './ui.tsx';

type Share = Omit<Request<'folders:add'>, 'label'>;
export type FolderOptionValues = Share;

export const NARROWEST: FolderOptionValues = { access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null };

/** What a working folder starts from: it is always edited in place, so what is left to choose is whether each task asks first, trust and the agent. */
export const WORKING_FOLDER: FolderOptionValues = { access: 'edit', approval: 'ask', isolation: 'in-place', trusted: false, agent: null };

/** A choice: its name, one short plain line (every fact that widens what the machine does stays in it), and the longer words behind the (i) button, if there are any. */
type Words = readonly [name: string, line: string, more?: string];

/** What each choice means, in the words of the runner's own questions: what is agreed to is what is read here. */
const WORDS = {
  access: {
    'read-only': ['Read only', 'Reads the files of this folder. Runs nothing.'],
    edit: ['Edit', 'Changes the files and runs commands, and the shell can read the rest of this machine.', 'The coding agent gets file tools and a shell. The shell is inside the sandbox of the system where there is one (no network, the places where credentials are kept hidden), but it can read the rest of this machine, not only this folder. The file tools are not inside that sandbox.'],
  },
  approval: {
    auto: ['Run what the office asks', 'Each task starts without asking you.'],
    ask: ['Ask me first', 'Each task waits for your approval.', 'You see the instruction exactly as the office sent it, and the task starts only after you approve it, on the Approvals screen.'],
  },
  isolation: {
    worktree: ['A copy on its own branch', 'Your files are not touched.', 'The task works on a copy of the files on its own branch. It needs a git repository with a commit, and nothing is pushed.'],
    'in-place': ['In place', 'Works on the files themselves, with no copy.', 'There is no copy and no branch: what the task changes is in your files at once, mixed with what you had not committed.'],
  },
} as const satisfies Record<string, Record<string, Words>>;

function Choice<V extends string>({ name, value, current, onPick, words }: { readonly name: string; readonly value: V; readonly current: V; readonly onPick: (value: V) => void; readonly words: Words }) {
  const id = useId();
  const [label, line, more] = words;
  return (
    <div className="choice">
      <input type="radio" id={id} name={name} checked={current === value} onChange={() => onPick(value)} aria-describedby={`${id}-words`} />
      <span className="choice-head">
        <label htmlFor={id}>{label}</label>
        {more ? <InfoTip topic={label.toLowerCase()}>{more}</InfoTip> : null}
      </span>
      <p className="hint" id={`${id}-words`}>
        {line}
      </p>
    </div>
  );
}

function Group({ legend, children }: { readonly legend: string; readonly children: ReactNode }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

/**
 * The choices of how a folder is shared. It never has a path in it: where the folder is is picked by the system's own dialog, in the main process.
 * A working folder is always edited in place, so it is not asked for the access or where the task works; with `withName` the folder is one that is made, and its name is asked.
 */
export function FolderOptions({
  initial,
  withLabel,
  withName = false,
  workingFolder = false,
  submitLabel,
  name: formName,
  busy,
  onSubmit,
}: {
  readonly initial: FolderOptionValues;
  readonly withLabel: boolean;
  readonly withName?: boolean;
  readonly workingFolder?: boolean;
  readonly submitLabel: string;
  readonly name: string;
  readonly busy: boolean;
  readonly onSubmit: (values: FolderOptionValues, label: string, name: string) => void;
}) {
  const [values, setValues] = useState<FolderOptionValues>(initial);
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const change = <K extends keyof FolderOptionValues>(key: K, value: FolderOptionValues[K]) => setValues((current) => ({ ...current, [key]: value }));
  const unchanged = !withLabel && (Object.keys(initial) as (keyof FolderOptionValues)[]).every((key) => initial[key] === values[key]);
  const nameless = withName && name.trim() === '';

  return (
    <form
      className="stack"
      aria-label={formName}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values, label.trim(), name.trim());
      }}
    >
      {withName ? (
        <Field label="Name of the new folder" hint="One name, not a path. The folder is made inside the folder you choose next, and only if it is not there yet.">
          {(props) => <input {...props} type="text" value={name} maxLength={64} required onChange={(event) => setName(event.target.value)} />}
        </Field>
      ) : null}
      {withLabel ? (
        <Field label="Name in the office (optional)" hint="A name, not a path. It is the folder's own name unless you type one.">
          {(props) => <input {...props} type="text" value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} />}
        </Field>
      ) : null}
      {workingFolder ? (
        <p className="hint">A working folder is always edited in place, with no copy, and is given file tools and a shell. Its access and where it works cannot be changed.</p>
      ) : (
        <Group legend="What a coding agent may do">
          {(['read-only', 'edit'] as const).map((value) => (
            <Choice key={value} name={`${formName}-access`} value={value} current={values.access} onPick={(picked) => change('access', picked)} words={WORDS.access[value]} />
          ))}
        </Group>
      )}
      <Group legend="Who decides that a task starts">
        {(['auto', 'ask'] as const).map((value) => (
          <Choice key={value} name={`${formName}-approval`} value={value} current={values.approval} onPick={(picked) => change('approval', picked)} words={WORDS.approval[value]} />
        ))}
      </Group>
      {workingFolder ? null : (
        <Group legend="Where the task works">
          {(['worktree', 'in-place'] as const).map((value) => (
            <Choice key={value} name={`${formName}-isolation`} value={value} current={values.isolation} onPick={(picked) => change('isolation', picked)} words={WORDS.isolation[value]} />
          ))}
        </Group>
      )}
      <div className="choice">
        <TrustedBox checked={values.trusted} onChange={(checked) => change('trusted', checked)} />
      </div>
      <Field label="Coding agent" hint="Used when a task does not ask for another.">
        {(props) => (
          <select {...props} value={values.agent ?? ''} onChange={(event) => change('agent', event.target.value === '' ? null : (event.target.value as AgentKind))}>
            <option value="">Any coding agent</option>
            {AGENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {AGENT_NAMES[kind]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="hint">
        A window of the app asks first, and only a yes keeps it.{' '}
        <InfoTip topic="the question">Sharing a folder, and any change that widens what this machine does, is shown to you in a window of the app, in full, before it takes effect.</InfoTip>
      </p>
      <div className="row">
        <button type="submit" className="primary" disabled={busy || unchanged || nameless}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function TrustedBox({ checked, onChange }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <>
      <input type="checkbox" id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} aria-describedby={`${id}-words`} />
      <span className="choice-head">
        <label htmlFor={id}>Trusted</label>
        <InfoTip topic="trusted">A coding agent that cannot be contained on this system (no sandbox of its own here) may run in this folder, with everything your user account can reach. Leave it off unless you know the folder holds nothing it should not touch.</InfoTip>
      </span>
      <p className="hint" id={`${id}-words`}>
        Lets an agent with no sandbox run here, with all your account can reach.
      </p>
    </>
  );
}
