import { useState } from 'react';
import type { Reply } from '../shared/channels.ts';
import { visible } from './plain.ts';
import { useAction, useLook, useRunner } from './runner-state.tsx';
import { InfoTip } from './InfoTip.tsx';
import { ConfirmAction, Field, Loading, Problem, Screen, Text } from './ui.tsx';

type ServerView = Reply<'mcp:list'>[number];
type ToolView = Reply<'mcp:tools'>['tools'][number];

const STANDING = { approved: 'Approved', new: 'New: not approved yet', changed: 'Changed: not used until you approve it again' } as const;

const EMPTY_FORM = { label: '', command: '', args: '', env: '', folder: '' };

const lines = (text: string): string[] => text.split('\n').filter((line) => line.trim() !== '');

function Tools({ label, onChanged }: { readonly label: string; readonly onChanged: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [tools, setTools] = useState<readonly ToolView[] | undefined>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<string | undefined>();

  const load = async () => {
    const answer = await run(() => api.call('mcp:tools', { label }));
    if (answer) setTools(answer.tools);
    return answer;
  };
  const untick = () => setTicked(new Set());
  const names = [...ticked];

  const approve = async () => {
    const outcome = await run(() => api.call('mcp:approve', { label, tools: names }));
    if (!outcome) return;
    setSaid(`Approved ${outcome.approved.length}. ${outcome.waiting} still ${outcome.waiting === 1 ? 'waits' : 'wait'}.`);
    untick();
    onChanged();
    await load();
  };
  const deny = async () => {
    const outcome = await run(() => api.call('mcp:deny', { label, tools: names }));
    if (!outcome) return;
    setSaid(`Denied ${outcome.denied.length}.`);
    untick();
    onChanged();
    await load();
  };

  return (
    <div className="stack">
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void load()}>
          Show tools
        </button>
        {busy && !tools ? <span className="muted" role="status">Starting the server to ask what it offers…</span> : null}
      </div>
      {tools ? (
        <>
          <ul className="plain-list" aria-label={`Tools of ${visible(label)}`}>
            {tools.map((tool) => (
              <li key={tool.name} className="tool">
                <input
                  type="checkbox"
                  id={`tool-${label}-${tool.name}`}
                  aria-label={visible(tool.name)}
                  checked={ticked.has(tool.name)}
                  onChange={(event) => setTicked((current) => (event.target.checked ? new Set([...current, tool.name]) : new Set([...current].filter((name) => name !== tool.name))))}
                />
                <div>
                  <p>
                    <strong><Text>{tool.name}</Text></strong> <span className={tool.standing === 'approved' ? 'badge' : 'badge warn'}>{STANDING[tool.standing]}</span>{' '}
                    <span className="badge">{tool.readOnly ? 'Only reads' : 'Can change things'}</span>
                  </p>
                  <p className="muted small wrap"><Text>{tool.summary}</Text></p>
                </div>
              </li>
            ))}
          </ul>
          <p className="hint">
            A window shows each tool before you approve it.{' '}
            <InfoTip topic="approving tools">What is kept is a fingerprint of what you saw, so a tool the server changes later is not used until you approve it again.</InfoTip>
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy || ticked.size === 0} onClick={() => void approve()}>
              Approve ticked
            </button>
            <button type="button" disabled={busy || ticked.size === 0} onClick={() => void deny()}>
              Deny ticked
            </button>
          </div>
        </>
      ) : null}
      <Problem>{problem}</Problem>
      {said ? <p role="status">{said}</p> : null}
    </div>
  );
}

function Server({ server, onChanged }: { readonly server: ServerView; readonly onChanged: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  return (
    <li className="card">
      <div className="row between">
        <h3>
          <Text>{server.label}</Text>
        </h3>
        <ConfirmAction
          label="Remove"
          question="Remove this server? The office can no longer use its tools."
          confirmLabel="Yes, remove it"
          disabled={busy}
          onConfirm={() => void run(() => api.call('mcp:remove', { label: server.label })).then((done) => done && onChanged())}
        />
      </div>
      <p className="small wrap">
        <code><Text>{server.commandLine}</Text></code>
      </p>
      <ul className="facts" aria-label={`About ${visible(server.label)}`}>
        <li>
          <span className="label">Folder</span> <span>{server.folder ? <Text>{server.folder}</Text> : 'None'}</span>
        </li>
        <li>
          <span className="label">Variables</span> <span>{server.envNames.length > 0 ? <Text>{server.envNames.join(', ')}</Text> : 'None'}</span>
          {server.envNames.length > 0 ? <span className="muted small"> (their values are not shown)</span> : null}
        </li>
        <li>
          <span className="label">Tools the office may use</span> <span>{server.approvedTools.length > 0 ? <Text>{server.approvedTools.join(', ')}</Text> : 'None yet'}</span>
        </li>
      </ul>
      <Tools label={server.label} onChanged={onChanged} />
      <Problem>{problem}</Problem>
    </li>
  );
}

function FolderChoices() {
  const { look } = useLook('folders:list');
  return look.status === 'ready' ? (
    <>
      {look.value.map(({ folder }) => (
        <option key={folder.label} value={folder.label}>
          {visible(folder.label)}
        </option>
      ))}
    </>
  ) : null;
}

function AddServer({ onAdded }: { readonly onAdded: () => void }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<string | undefined>();
  const [form, setForm] = useState(EMPTY_FORM);
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const close = () => {
    setOpen(false);
    setForm(EMPTY_FORM);
  };

  const add = async () => {
    setSaid(undefined);
    const outcome = await run(() => api.call('mcp:add', { label: form.label.trim(), command: form.command.trim(), args: lines(form.args), env: lines(form.env), folder: form.folder === '' ? null : form.folder }));
    if (!outcome) return;
    if (outcome.added) {
      setSaid(`Added "${visible(outcome.label ?? form.label)}".`);
      close();
      onAdded();
    } else {
      setSaid('Nothing was added.');
    }
  };

  return (
    <section className="card" aria-label="Add a server">
      {open ? (
        <form
          className="stack"
          aria-label="Add an MCP server"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <h3>Add a server</h3>
          <Field label="Name" hint="What the office calls it.">
            {(props) => <input {...props} type="text" value={form.label} maxLength={64} onChange={(event) => set('label', event.target.value)} />}
          </Field>
          <Field label="Program" hint="As you would type it in a terminal.">
            {(props) => <input {...props} type="text" value={form.command} onChange={(event) => set('command', event.target.value)} spellCheck={false} />}
          </Field>
          <Field label="Arguments, one per line">{(props) => <textarea {...props} rows={3} value={form.args} onChange={(event) => set('args', event.target.value)} spellCheck={false} />}</Field>
          <Field label="Environment, one NAME=value per line" hint="Values stay on this machine.">
            {(props) => <textarea {...props} rows={2} value={form.env} onChange={(event) => set('env', event.target.value)} spellCheck={false} />}
          </Field>
          <Field label="Folder it works in (optional)">
            {(props) => (
              <select {...props} value={form.folder} onChange={(event) => set('folder', event.target.value)}>
                <option value="">None</option>
                <FolderChoices />
              </select>
            )}
          </Field>
          <p className="hint">
            A window of the app asks first, and only a yes keeps the server.{' '}
            <InfoTip topic="adding a server">The window shows you what will run, as you, with nothing to contain it. The office is told the names of the variables at most.</InfoTip>
          </p>
          <div className="row">
            <button type="submit" className="primary" disabled={busy || form.label.trim() === '' || form.command.trim() === ''}>
              Add the server…
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Add a server
        </button>
      )}
      <Problem>{problem}</Problem>
      {said ? <p role="status">{said}</p> : null}
    </section>
  );
}

export function McpScreen() {
  const { look, reload } = useLook('mcp:list');
  return (
    <Screen title="MCP servers" intro="Programs that run on this machine, as you, with nothing to contain them." tip={{ topic: 'MCP servers', text: 'The office is told the name of a server and the tools you approved, nothing of how it is run.' }}>
      <AddServer onAdded={reload} />
      {look.status === 'loading' ? <Loading what="the servers" /> : null}
      {look.status === 'failed' ? <Problem>{look.problem}</Problem> : null}
      {look.status === 'ready' && look.value.length === 0 ? <p className="muted">No MCP server is set up on this machine.</p> : null}
      {look.status === 'ready' && look.value.length > 0 ? (
        <ul className="plain-list" aria-label="MCP servers">
          {look.value.map((server) => (
            <Server key={server.label} server={server} onChanged={reload} />
          ))}
        </ul>
      ) : null}
    </Screen>
  );
}
