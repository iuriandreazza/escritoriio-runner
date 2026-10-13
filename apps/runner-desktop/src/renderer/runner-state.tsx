import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ChannelName, Reply, Request, RunnerApi, RunnerEvent } from '../shared/channels.ts';
import { wordsOf } from './plain.ts';

export type ConnectionView = Reply<'connection:get'>;
export type TasksView = Reply<'tasks:get'>;
export type PendingApproval = Reply<'approvals:list'>[number];
export type PairLink = NonNullable<Reply<'pairing:pending-link'>>;
export type UpdateState = Reply<'app:check-update'>;

export interface Message {
  readonly id: number;
  readonly kind: 'notice' | 'problem';
  readonly text: string;
}

/** What the screens share, kept up to date by what the main process pushes: the connection, the tasks, the approvals, a pairing link and the updater. */
export interface LiveState {
  readonly connection: ConnectionView | undefined;
  readonly tasks: TasksView;
  readonly approvals: readonly PendingApproval[];
  readonly pendingLink: PairLink | null;
  readonly update: UpdateState;
  readonly messages: readonly Message[];
  /** Words, when the first look at the app failed: nothing else can be shown until it is known. */
  readonly loadProblem: string | undefined;
}

interface Runner {
  readonly api: RunnerApi;
  readonly live: LiveState;
  dismiss(id: number): void;
  /** The updater answered a call of the window: what it says is the newest, whether or not an event came for it. */
  applyUpdate(state: UpdateState): void;
  /** Reads the connection and the pairing link again: after a pairing, or an action whose effect shows there. */
  refresh(): Promise<void>;
}

const RunnerContext = createContext<Runner | undefined>(undefined);

export function useRunner(): Runner {
  const runner = useContext(RunnerContext);
  if (!runner) throw new Error('A screen needs the runner around it.');
  return runner;
}

const MAX_MESSAGES = 3;
const NO_TASKS: TasksView = { running: [], recent: [] };

/** Gives the screens the API of the preload and the live state. The API is a prop so that a test gives it a fake: the page itself gives `window.escritoriioRunner`. */
export function RunnerProvider({ api, children }: { readonly api: RunnerApi; readonly children: ReactNode }) {
  const [connection, setConnection] = useState<ConnectionView | undefined>();
  const [tasks, setTasks] = useState<TasksView>(NO_TASKS);
  const [approvals, setApprovals] = useState<readonly PendingApproval[]>([]);
  const [pendingLink, setPendingLink] = useState<PairLink | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ state: 'idle' });
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [loadProblem, setLoadProblem] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    const [view, link] = await Promise.all([api.call('connection:get', {}), api.call('pairing:pending-link', {})]);
    setConnection(view);
    setPendingLink(link);
  }, [api]);

  useEffect(() => {
    // What an event said is newer than what a first look read: an event that came while the look was on its way is not overwritten by it.
    const heard = new Set<RunnerEvent['kind']>();
    let counter = 0;
    const say = (kind: Message['kind'], text: string) => setMessages((current) => [...current, { id: (counter += 1), kind, text }].slice(-MAX_MESSAGES));

    const stop = api.onEvent((event) => {
      heard.add(event.kind);
      switch (event.kind) {
        case 'connection':
          return setConnection(event.view);
        case 'tasks':
          return setTasks(event.view);
        case 'approvals':
          return setApprovals(event.pending);
        case 'pair-link':
          return setPendingLink({ linkId: event.linkId, host: event.host });
        case 'update':
          return setUpdate(event.update);
        case 'notice':
          return say('notice', event.message);
        case 'problem':
          return say('problem', event.message);
      }
    });

    const first = <C extends ChannelName>(kind: RunnerEvent['kind'], channel: C, keep: (reply: Reply<C>) => void) =>
      api.call(channel, {} as Request<C>).then(
        (reply) => {
          if (!heard.has(kind)) keep(reply);
        },
        (error: unknown) => setLoadProblem(wordsOf(error)),
      );
    void first('connection', 'connection:get', setConnection);
    void first('tasks', 'tasks:get', setTasks);
    void first('approvals', 'approvals:list', setApprovals);
    void first('pair-link', 'pairing:pending-link', setPendingLink);
    return stop;
  }, [api]);

  const dismiss = useCallback((id: number) => setMessages((current) => current.filter((message) => message.id !== id)), []);
  const value = useMemo<Runner>(
    () => ({ api, dismiss, refresh, applyUpdate: setUpdate, live: { connection, tasks, approvals, pendingLink, update, messages, loadProblem } }),
    [api, dismiss, refresh, connection, tasks, approvals, pendingLink, update, messages, loadProblem],
  );
  return <RunnerContext value={value}>{children}</RunnerContext>;
}

// --- one look at a channel, and one action ----------------------------------------------------------------------

type LookChannel = 'folders:list' | 'agents:inspect' | 'mcp:list' | 'app:info';

export type Look<T> = { readonly status: 'loading' } | { readonly status: 'failed'; readonly problem: string } | { readonly status: 'ready'; readonly value: T };

/** Asks a channel that takes nothing for its answer when the screen opens, and again whenever `reload` is called. */
export function useLook<C extends LookChannel>(channel: C): { readonly look: Look<Reply<C>>; reload(): void } {
  const { api } = useRunner();
  const [look, setLook] = useState<Look<Reply<C>>>({ status: 'loading' });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let current = true;
    api.call(channel, {} as Request<C>).then(
      (value) => current && setLook({ status: 'ready', value }),
      (error: unknown) => current && setLook({ status: 'failed', problem: wordsOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [api, channel, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { look, reload };
}

/** What an action of the owner is doing: it cannot be started twice, and when it fails it says why in words. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setProblem(undefined);
    try {
      return await work();
    } catch (error) {
      setProblem(wordsOf(error));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, problem, run, clear: useCallback(() => setProblem(undefined), []) };
}
