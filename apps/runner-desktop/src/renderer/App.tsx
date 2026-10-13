import { useEffect, useRef, useState } from 'react';
import type { RunnerApi } from '../shared/channels.ts';
import { AgentsScreen } from './AgentsScreen.tsx';
import { ApprovalsScreen } from './ApprovalsScreen.tsx';
import { ConnectionScreen } from './ConnectionScreen.tsx';
import { DoctorScreen } from './DoctorScreen.tsx';
import { FoldersScreen } from './FoldersScreen.tsx';
import { McpScreen } from './McpScreen.tsx';
import { RunnerProvider, useRunner } from './runner-state.tsx';
import { SettingsScreen } from './SettingsScreen.tsx';
import { TasksScreen } from './TasksScreen.tsx';
import { Text } from './ui.tsx';
import { headline, tone } from './connection-words.ts';

const SECTIONS = [
  { id: 'connection', name: 'Connection', screen: ConnectionScreen },
  { id: 'tasks', name: 'Tasks', screen: TasksScreen },
  { id: 'approvals', name: 'Approvals', screen: ApprovalsScreen },
  { id: 'folders', name: 'Folders', screen: FoldersScreen },
  { id: 'agents', name: 'Coding agents', screen: AgentsScreen },
  { id: 'mcp', name: 'MCP servers', screen: McpScreen },
  { id: 'doctor', name: 'Doctor', screen: DoctorScreen },
  { id: 'settings', name: 'Settings', screen: SettingsScreen },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function Messages() {
  const { live, dismiss } = useRunner();
  return (
    <div className="messages">
      {live.messages.map((message) => (
        <div key={message.id} className={`message ${message.kind}`} role={message.kind === 'problem' ? 'alert' : 'status'}>
          <span>
            <Text>{message.text}</Text>
          </span>
          <button type="button" onClick={() => dismiss(message.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const { live } = useRunner();
  const [current, setCurrent] = useState<SectionId>('connection');
  const arrived = useRef(false);

  useEffect(() => {
    // A screen that opens has the focus on its title, so that what it is called is said, and the keyboard starts from there. Not the first time: the page has just opened.
    if (arrived.current) document.getElementById('screen-title')?.focus();
    arrived.current = true;
  }, [current]);

  const counts: Partial<Record<SectionId, string>> = {};
  if (live.approvals.length > 0) counts.approvals = `${live.approvals.length} waiting`;
  if (live.tasks.running.length > 0) counts.tasks = `${live.tasks.running.length} running`;
  const Screen = SECTIONS.find((section) => section.id === current)?.screen ?? ConnectionScreen;

  return (
    <div className="shell">
      <header className="top">
        <h1>Escritoriio Runner</h1>
        {live.connection ? (
          <p className={`chip ${tone(live.connection)}`} role="status" aria-label="Connection status">
            {headline(live.connection)}
          </p>
        ) : null}
      </header>
      <nav className="sections" aria-label="Sections">
        {SECTIONS.map((section) => {
          const count = counts[section.id];
          return (
            <button key={section.id} type="button" aria-current={section.id === current ? 'page' : undefined} aria-label={count ? `${section.name}, ${count}` : undefined} onClick={() => setCurrent(section.id)}>
              {section.name}
              {count ? <span className="count">{count.split(' ')[0]}</span> : null}
            </button>
          );
        })}
      </nav>
      <main>
        <Messages />
        <Screen />
      </main>
    </div>
  );
}

/** The window: a place for each thing the app does. The API is the one the preload gave the page (or a fake, in a test). */
export function App({ api = window.escritoriioRunner }: { readonly api?: RunnerApi }) {
  return (
    <RunnerProvider api={api}>
      <Shell />
    </RunnerProvider>
  );
}
