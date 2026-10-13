// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoctorScreen } from './DoctorScreen.tsx';
import { fakeApi, HOSTILE, renderWithRunner } from './testing.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = {
  healthy: false,
  checks: [
    { id: 'claude', status: 'ok', title: 'Claude Code', message: 'Found, logged in.' },
    { id: 'clock', status: 'warn', title: 'Clock', message: 'The clock is a little off.' },
    { id: 'connection', status: 'fail', title: 'Connection', message: 'The office did not answer.' },
  ],
} as const;

describe('the doctor', () => {
  it('runs only when asked, and says each check in words, not only in colour', async () => {
    const api = fakeApi({ 'doctor:run': report });
    renderWithRunner(<DoctorScreen />, api);
    expect(api.requests('doctor:run')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    const list = await screen.findByRole('list', { name: 'Checks' });
    expect(list.textContent).toContain('OK');
    expect(list.textContent).toContain('Warning');
    expect(list.textContent).toContain('Failed');
    expect(list.textContent).toContain('The office did not answer.');
    expect(screen.getByText('Something needs a look.')).toBeTruthy();
  });

  it('says when everything is fine', async () => {
    renderWithRunner(<DoctorScreen />, fakeApi({ 'doctor:run': { healthy: true, checks: [report.checks[0]] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    expect(await screen.findByText('Everything is fine.')).toBeTruthy();
  });

  it('copies the report as text, the one the main process already cleaned', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderWithRunner(<DoctorScreen />, fakeApi({ 'doctor:run': report }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the report' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toBe(['Escritoriio Runner: checks', '[ok] Claude Code: Found, logged in.', '[warn] Clock: The clock is a little off.', '[fail] Connection: The office did not answer.'].join('\n'));
    expect(await screen.findByText('Copied.')).toBeTruthy();
    expect((screen.getByLabelText('The report as text') as HTMLTextAreaElement).value).toBe(writeText.mock.calls[0]![0]);
  });

  it('says to copy by hand when the system does not allow it', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    renderWithRunner(<DoctorScreen />, fakeApi({ 'doctor:run': report }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the report' }));
    expect(await screen.findByText(/Could not copy it. Select the text of the report and copy it/)).toBeTruthy();
  });

  it('falls back to the old way of copying when the page is not granted the clipboard', async () => {
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    renderWithRunner(<DoctorScreen />, fakeApi({ 'doctor:run': report }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy the report' }));
    expect(await screen.findByText('Copied.')).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith('copy');
    Reflect.deleteProperty(document, 'execCommand');
  });

  it('says in words when the checks could not run', async () => {
    renderWithRunner(
      <DoctorScreen />,
      fakeApi({
        'doctor:run': () => {
          throw new Error('The checks could not run.');
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The checks could not run.');
  });

  it('shows what a hostile machine put in a message as text', async () => {
    const { container } = renderWithRunner(<DoctorScreen />, fakeApi({ 'doctor:run': { healthy: false, checks: [{ id: 'x', status: 'warn', title: HOSTILE.markup, message: `${HOSTILE.link} ${HOSTILE.rtl}` }] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run the checks' }));
    await screen.findByRole('list', { name: 'Checks' });
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('‹U+202E›');
  });
});
