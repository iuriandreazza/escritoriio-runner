import { useLayoutEffect, useRef } from 'react';
import { formatDuration } from './format.ts';
import { terminalLine } from './plain.ts';
import type { TasksView } from './runner-state.tsx';
import { useAction, useRunner } from './runner-state.tsx';
import { ConfirmAction, Problem, Screen, Text } from './ui.tsx';

const NEAR_THE_END_PX = 24;

/** The last lines of a task. It follows the end as lines come, unless the owner scrolled up to read: then it stays where they put it. */
function Tail({ taskId, lines }: { readonly taskId: string; readonly lines: readonly string[] }) {
  const log = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <pre
      ref={log}
      className="tail"
      role="log"
      tabIndex={0}
      aria-label={`Output of task ${taskId}`}
      aria-live="off"
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_THE_END_PX;
      }}
    >
      {lines.map(terminalLine).join('\n')}
    </pre>
  );
}

function RunningTask({ task }: { readonly task: TasksView['running'][number] }) {
  const { api } = useRunner();
  const { busy, problem, run } = useAction();
  return (
    <li className="card">
      <div className="row between">
        <h4>
          <Text>{task.folder}</Text> <span className="muted small"><Text>{task.taskId}</Text></span>
        </h4>
        <ConfirmAction label="Cancel task" question="Cancel this task? It is stopped now." confirmLabel="Yes, cancel it" keepLabel="Keep it running" disabled={busy} onConfirm={() => void run(() => api.call('tasks:cancel', { taskId: task.taskId }))} />
      </div>
      <p className="muted small">{`Started at ${new Date(task.startedAt).toLocaleTimeString()}`}</p>
      {task.waitingForApproval ? <p className="badge warn">Waiting for your approval</p> : null}
      {task.tail.length > 0 ? <Tail taskId={task.taskId} lines={task.tail} /> : <p className="muted">Nothing has been printed yet.</p>}
      <Problem>{problem}</Problem>
    </li>
  );
}

export function TasksScreen() {
  const { live } = useRunner();
  const { running, recent } = live.tasks;
  return (
    <Screen title="Tasks" intro="What this machine is doing for the office, and what it did lately.">
      <h3>Running</h3>
      {running.length === 0 ? (
        <p className="muted">Nothing is running.</p>
      ) : (
        <ul className="plain-list" aria-label="Running tasks">
          {running.map((task) => (
            <RunningTask key={task.taskId} task={task} />
          ))}
        </ul>
      )}
      <h3>Ended</h3>
      {recent.length === 0 ? (
        <p className="muted">No task has ended since this app started.</p>
      ) : (
        <ul className="plain-list" aria-label="Recent tasks">
          {recent.map((task) => (
            <li key={task.taskId} className="card">
              <p>
                <strong><Text>{task.outcome}</Text></strong> <span className="muted">in {formatDuration(task.durationMs)}</span> <span className="muted small"><Text>{task.taskId}</Text></span>
              </p>
              {task.branch ? (
                <p className="small">
                  Branch <code><Text>{task.branch}</Text></code>
                </p>
              ) : null}
              <p className="wrap"><Text>{task.summary}</Text></p>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
