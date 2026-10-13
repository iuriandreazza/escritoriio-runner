import { crc32, inflateSync } from 'node:zlib';
import type { ConnectionView } from '@escritoriio/runner';
import { describe, expect, it, vi } from 'vitest';
import { statusIconPng } from './tray-icon.ts';
import { trayMenu, trayStatus, trayTooltip } from './tray-model.ts';

const device = { host: 'office.example', deviceName: 'Laptop', agentName: 'Ana', workspaceName: 'Acme' };
const view = (change: Partial<ConnectionView> = {}): ConnectionView => ({ state: 'connected', device, paused: false, pausedByOffice: false, pausedHere: false, retryInMs: null, slowRetry: false, lastError: null, ...change });

describe('the status in the tray', () => {
  it.each([
    [view({ state: 'not-paired', device: null }), 'not-paired'],
    [view({ state: 'connected' }), 'connected'],
    [view({ state: 'connected', paused: true, pausedHere: true }), 'paused'],
    [view({ state: 'offline', paused: true, pausedHere: true }), 'paused'],
    [view({ state: 'connected', paused: true, pausedByOffice: true }), 'paused'],
    [view({ state: 'offline' }), 'offline'],
    [view({ state: 'connecting' }), 'connecting'],
    [view({ state: 'reconnecting' }), 'connecting'],
  ] as const)('is %#: %s', (connection, status) => {
    expect(trayStatus(connection)).toBe(status);
  });

  it('says in words who the machine works for', () => {
    expect(trayTooltip(view())).toMatch(/Ana/);
    expect(trayTooltip(view({ state: 'not-paired', device: null }))).toMatch(/not paired/i);
    expect(trayTooltip(view({ paused: true, pausedByOffice: true }))).toMatch(/office/i);
  });
});

describe('the menu of the tray', () => {
  const actions = () => ({ setPaused: vi.fn(), openWindow: vi.fn(), quit: vi.fn() });
  const labelsOf = (items: ReturnType<typeof trayMenu>) => items.filter((item) => item.type !== 'separator').map((item) => item.label);

  it('pauses with one click, and resumes with one click', () => {
    const a = actions();
    const running = trayMenu(view(), a).find((item) => item.label === 'Pause');
    running?.click?.();
    expect(a.setPaused).toHaveBeenCalledWith(true);

    const b = actions();
    const paused = trayMenu(view({ paused: true, pausedHere: true }), b).find((item) => item.label === 'Resume');
    paused?.click?.();
    expect(b.setPaused).toHaveBeenCalledWith(false);
  });

  it('has the status, a way to open the window and a way to quit', () => {
    const a = actions();
    const items = trayMenu(view(), a);
    expect(labelsOf(items)).toEqual([expect.stringMatching(/connected/i), 'Pause', 'Open window', 'Quit']);
    expect(items[0]?.enabled).toBe(false);
    items.find((item) => item.label === 'Open window')?.click?.();
    items.find((item) => item.label === 'Quit')?.click?.();
    expect(a.openWindow).toHaveBeenCalledTimes(1);
    expect(a.quit).toHaveBeenCalledTimes(1);
  });

  it('cannot pause a machine that is not paired, and says so', () => {
    const items = trayMenu(view({ state: 'not-paired', device: null }), actions());
    expect(items.find((item) => item.label === 'Pause')?.enabled).toBe(false);
    expect(items[0]?.label).toMatch(/not paired/i);
  });
});

describe('the icon of the tray', () => {
  it('is a real PNG of the size asked, with checksums that hold', () => {
    const png = statusIconPng('connected', 16);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks: { type: string; data: Buffer }[] = [];
    for (let at = 8; at < png.length; ) {
      const length = png.readUInt32BE(at);
      const type = png.toString('latin1', at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks.push({ type, data });
      at += 12 + length;
    }
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const header = chunks[0]!.data;
    expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9]]).toEqual([16, 16, 8, 6]);
    expect(inflateSync(chunks[1]!.data).length).toBe(16 * (1 + 16 * 4));
  });

  it('looks different for each status, so that it can be read at a glance', () => {
    const pictures = (['connected', 'paused', 'offline', 'not-paired', 'connecting'] as const).map((status) => statusIconPng(status, 16).toString('hex'));
    expect(new Set(pictures).size).toBe(pictures.length);
  });
});
