// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { McpScreen } from './McpScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(cleanup);

const tickets = { label: 'tickets', commandLine: 'node /opt/tickets/server.js --verbose', folder: 'website', envNames: ['TICKETS_TOKEN'], approvedTools: ['search'] };
const tools = {
  label: 'tickets',
  tools: [
    { name: 'search', standing: 'approved', summary: 'Search the tickets.', readOnly: true },
    { name: 'close', standing: 'new', summary: 'Close a ticket.', readOnly: false },
    { name: 'comment', standing: 'changed', summary: 'Comment on a ticket.', readOnly: false },
  ],
} as const;
const card = () => screen.getByRole('heading', { name: 'tickets' }).closest('li')!;

describe('the MCP servers', () => {
  it('says what they are and that the office hears of their names only', async () => {
    renderWithRunner(<McpScreen />);
    expect(await screen.findByText(/No MCP server is set up/)).toBeTruthy();
    expect(screen.getByText(/run on this machine, as you, with nothing to contain them/)).toBeTruthy();
  });

  it('lists a server with how it is run, its folder, the names of its variables and the tools approved', async () => {
    renderWithRunner(<McpScreen />, fakeApi({ 'mcp:list': [tickets] }));
    await screen.findByRole('heading', { name: 'tickets' });
    expect(card().textContent).toContain('node /opt/tickets/server.js --verbose');
    expect(card().textContent).toContain('website');
    expect(card().textContent).toContain('TICKETS_TOKEN');
    expect(card().textContent).toContain('search');
  });

  it('adds a server: the words of the form become a request, and the native window decides', async () => {
    const api = fakeApi({ 'mcp:list': [], 'folders:list': [{ folder: { label: 'website', path: '/w', realPath: '/w', access: 'read-only', approval: 'auto', isolation: 'worktree', trusted: false, agent: null } }], 'mcp:add': { added: true, label: 'tickets' } });
    renderWithRunner(<McpScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a server' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'tickets' } });
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'node' } });
    fireEvent.change(screen.getByLabelText('Arguments, one per line'), { target: { value: '/opt/tickets/server.js\n\n--verbose' } });
    fireEvent.change(screen.getByLabelText('Environment, one NAME=value per line'), { target: { value: 'TICKETS_TOKEN=secret' } });
    await screen.findByRole('option', { name: 'website' });
    fireEvent.change(screen.getByLabelText('Folder it works in (optional)'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the server…' }));
    await waitFor(() => expect(api.requests('mcp:add')).toEqual([{ label: 'tickets', command: 'node', args: ['/opt/tickets/server.js', '--verbose'], env: ['TICKETS_TOKEN=secret'], folder: 'website' }]));
    expect(await screen.findByText('Added "tickets".')).toBeTruthy();
  });

  it('says when it was not added', async () => {
    renderWithRunner(<McpScreen />, fakeApi({ 'mcp:add': { added: false } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add a server' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the server…' }));
    expect(await screen.findByText('Nothing was added.')).toBeTruthy();
  });

  it('shows the tools as the server describes them, and which are approved, new or changed', async () => {
    renderWithRunner(<McpScreen />, fakeApi({ 'mcp:list': [tickets], 'mcp:tools': tools }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools' }));
    const list = await within(card()).findByRole('list', { name: 'Tools of tickets' });
    expect(list.textContent).toContain('Approved');
    expect(list.textContent).toContain('New: not approved yet');
    expect(list.textContent).toContain('Changed: not used until you approve it again');
    expect(list.textContent).toContain('Search the tickets.');
    expect(list.textContent).toContain('Only reads');
    expect(list.textContent).toContain('Can change things');
  });

  it('approves the ticked tools, and denies them, each by its name', async () => {
    const api = fakeApi({ 'mcp:list': [tickets], 'mcp:tools': tools, 'mcp:approve': { approved: ['close'], waiting: 1 }, 'mcp:deny': { denied: ['close'] } });
    renderWithRunner(<McpScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools' }));
    await within(card()).findByRole('list', { name: 'Tools of tickets' });
    expect((within(card()).getByRole('button', { name: 'Approve ticked' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card()).getByRole('checkbox', { name: 'close' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Approve ticked' }));
    await waitFor(() => expect(api.requests('mcp:approve')).toEqual([{ label: 'tickets', tools: ['close'] }]));
    expect(await within(card()).findByText(/Approved 1\. 1 still waits/)).toBeTruthy();

    fireEvent.click(within(card()).getByRole('checkbox', { name: 'close' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Deny ticked' }));
    await waitFor(() => expect(api.requests('mcp:deny')).toEqual([{ label: 'tickets', tools: ['close'] }]));
  });

  it('says in words when the server could not be asked', async () => {
    renderWithRunner(
      <McpScreen />,
      fakeApi({
        'mcp:list': [tickets],
        'mcp:tools': () => {
          throw new Error('The server did not start.');
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The server did not start.');
  });

  it('removes after asking', async () => {
    const api = fakeApi({ 'mcp:list': [tickets], 'mcp:remove': { label: 'tickets' } });
    renderWithRunner(<McpScreen />, api);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(api.requests('mcp:remove')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }));
    await waitFor(() => expect(api.requests('mcp:remove')).toEqual([{ label: 'tickets' }]));
  });

  it('shows what a hostile server says as text, never markup or a link', async () => {
    const hostileTools = { label: 'tickets', tools: [{ name: HOSTILE.markup.slice(0, 40), standing: 'new', summary: `${HOSTILE.markup} ${HOSTILE.link} ${HOSTILE.rtl}`, readOnly: true }] } as const;
    const { container } = renderWithRunner(<McpScreen />, fakeApi({ 'mcp:list': [{ ...tickets, commandLine: HOSTILE.link }], 'mcp:tools': hostileTools }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show tools' }));
    await screen.findByRole('list', { name: 'Tools of tickets' });
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('javascript:alert(1)');
    expect(container.textContent).toContain('‹U+202E›');
  });
});
