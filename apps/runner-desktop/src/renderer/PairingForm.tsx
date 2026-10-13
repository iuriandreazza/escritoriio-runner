import { useState } from 'react';
import { useAction, useRunner } from './runner-state.tsx';
import { InfoTip } from './InfoTip.tsx';
import { Field, Problem, Text } from './ui.tsx';
import { visible } from './plain.ts';

const NOT_A_LINK = 'That is not a pairing link. A pairing link starts with escritoriio://pair and comes from the office.';

type Target = { readonly server: string; readonly code: string } | { readonly problem: string };

/** What the owner typed or pasted: a pairing link, which has the address and the code in it, or an address and a code of their own. */
export function readPairing(typed: string, code: string): Target {
  const text = typed.trim();
  if (/^escritoriio:/i.test(text)) {
    try {
      const link = new URL(text);
      const server = link.searchParams.get('server');
      const linked = link.searchParams.get('code');
      if (link.hostname !== 'pair' || !server || !linked) return { problem: NOT_A_LINK };
      return { server, code: linked };
    } catch {
      return { problem: NOT_A_LINK };
    }
  }
  return { server: text, code: code.trim() };
}

/** The address and code of an office, typed or pasted as a link. The window only passes them on: the office's own words are shown in a native dialog before the code is used. */
export function PairingForm() {
  const { api, refresh } = useRunner();
  const { busy, problem, run, clear } = useAction();
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [outcome, setOutcome] = useState<string | undefined>();
  const [refused, setRefused] = useState<string | undefined>();

  const isLink = /^escritoriio:/i.test(typed.trim());
  const ready = typed.trim() !== '' && (isLink || code.trim() !== '');

  const pair = async () => {
    setOutcome(undefined);
    clear();
    const target = readPairing(typed, code);
    if ('problem' in target) return setRefused(target.problem);
    setRefused(undefined);
    const name = deviceName.trim();
    const done = await run(() => api.call('pairing:pair', name === '' ? target : { ...target, deviceName: name }));
    if (!done) return;
    setOutcome(done.paired ? `Paired with ${visible(done.agentName ?? 'an AI member')} of ${visible(done.workspaceName ?? 'the office')}.` : 'Nothing was paired. The code was not used.');
    await run(refresh);
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void pair();
      }}
    >
      <Field
        label="Pairing link or the address of the office"
        hint="Paste the link, or type the address."
        tip={{ topic: 'the link or address', text: 'Paste the link the office gave you (it starts with escritoriio://pair), or type the address of the office, such as https://office.example.' }}
      >
        {(props) => <input {...props} type="text" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label="Code" hint={isLink ? 'The link has the code in it.' : 'Such as ABCD-EFGH.'}>
        {(props) => <input {...props} type="text" value={isLink ? '' : code} disabled={isLink} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} />}
      </Field>
      <Field label="Name of this machine (optional)">{(props) => <input {...props} type="text" value={deviceName} maxLength={64} onChange={(event) => setDeviceName(event.target.value)} />}</Field>
      <p className="hint">
        A window of the app asks before the code is used.{' '}
        <InfoTip topic="the question">It shows you who this machine would work for, in the words of the office. Nothing is used up until you say yes there.</InfoTip>
      </p>
      <div className="row">
        <button type="submit" className="primary" disabled={!ready || busy}>
          Pair
        </button>
      </div>
      <Problem>{refused ?? problem}</Problem>
      {outcome ? <p role="status">{outcome}</p> : null}
    </form>
  );
}

/** A link of the office that the system opened here: it waits to be reviewed, and nothing is used until the owner says so. */
export function PendingLink({ linkId, host }: { readonly linkId: string; readonly host: string }) {
  const { api, refresh } = useRunner();
  const { busy, problem, run } = useAction();
  const [outcome, setOutcome] = useState<string | undefined>();

  const pair = async () => {
    const done = await run(() => api.call('pairing:pair', { linkId }));
    if (!done) return;
    setOutcome(done.paired ? `Paired with ${visible(done.agentName ?? 'an AI member')} of ${visible(done.workspaceName ?? 'the office')}.` : 'Nothing was paired. The code was not used.');
    await run(refresh);
  };

  return (
    <section className="card" aria-labelledby="link-title">
      <h3 id="link-title">A link was opened</h3>
      <p>
        A link from <strong><Text>{host}</Text></strong> is waiting. A window of the app asks before the code is used.{' '}
        <InfoTip topic="the link">Pairing shows you the office's own words in a window of the app, and only a yes there uses the code.</InfoTip>
      </p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void pair()} aria-label={`Pair with ${visible(host)}`}>
          Pair
        </button>
      </div>
      <Problem>{problem}</Problem>
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
