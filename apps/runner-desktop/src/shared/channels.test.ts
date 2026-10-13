import { describe, expect, it } from 'vitest';
import { CHANNELS, CHANNEL_NAMES, eventSchema, isChannelName } from './channels.ts';

describe('the table of channels', () => {
  it('has a schema for the request and one for the reply of every channel', () => {
    for (const name of CHANNEL_NAMES) {
      expect(CHANNELS[name].request.safeParse, name).toBeTypeOf('function');
      expect(CHANNELS[name].reply.safeParse, name).toBeTypeOf('function');
    }
  });

  it('knows its own names and nothing else', () => {
    expect(isChannelName('folders:add')).toBe(true);
    expect(isChannelName('constructor')).toBe(false);
    expect(isChannelName('__proto__')).toBe(false);
    expect(isChannelName('toString')).toBe(false);
    expect(isChannelName(42)).toBe(false);
  });

  it('takes no path for a folder from the renderer: adding a folder is the picker of the main process', () => {
    const add = CHANNELS['folders:add'].request;
    const choice = { access: 'read-only', approval: 'ask', isolation: 'worktree', trusted: false, agent: null };
    expect(add.safeParse(choice).success).toBe(true);
    expect(add.safeParse({ ...choice, path: '/Users/someone' }).success).toBe(false);
    expect(add.safeParse({ ...choice, realPath: '/' }).success).toBe(false);
    expect(CHANNELS['folders:update'].request.safeParse({ label: 'site', changes: { path: '/' } }).success).toBe(false);
  });

  it('takes no path for a coding agent either: it is picked in a native dialog', () => {
    expect(CHANNELS['agents:set-path'].request.safeParse({ kind: 'claude-code' }).success).toBe(true);
    expect(CHANNELS['agents:set-path'].request.safeParse({ kind: 'claude-code', path: '/usr/bin/evil' }).success).toBe(false);
  });

  it('refuses a request with a field it does not list, on every channel that takes none', () => {
    for (const name of CHANNEL_NAMES) {
      const empty = CHANNELS[name].request.safeParse({});
      if (empty.success) expect(CHANNELS[name].request.safeParse({ extra: 1 }).success, name).toBe(false);
    }
  });

  it('cuts what the office said to a length instead of passing it on whole', () => {
    const view = CHANNELS['tasks:get'].reply.parse({
      running: [{ taskId: 't1', folder: 'site', startedAt: 1, waitingForApproval: false, tail: Array.from({ length: 500 }, () => 'x'.repeat(5_000)) }],
      recent: [],
    });
    expect(view.running[0]?.tail.length).toBeLessThanOrEqual(100);
    expect(view.running[0]?.tail.every((line) => line.length <= 400)).toBe(true);
  });

  it('drops what a reply was not meant to carry', () => {
    const device = CHANNELS['pairing:current'].reply.parse({ host: 'office.example', deviceName: 'laptop', agentName: 'Ana', workspaceName: 'Acme', token: 'secret' });
    expect(JSON.stringify(device)).not.toContain('secret');
  });

  it('reads an event of each kind and refuses one of a kind it does not know', () => {
    expect(eventSchema.safeParse({ kind: 'notice', message: 'done' }).success).toBe(true);
    expect(eventSchema.safeParse({ kind: 'pair-link', linkId: 'abc', host: 'office.example' }).success).toBe(true);
    expect(eventSchema.safeParse({ kind: 'exec', command: 'rm' }).success).toBe(false);
  });

  it('takes a name and the choices of a workspace and no path, no access and no isolation: it is always edited in place', () => {
    const make = CHANNELS['folders:new-workspace'].request;
    const choice = { name: 'build', approval: 'ask', trusted: false, agent: null };
    expect(make.safeParse(choice).success).toBe(true);
    expect(make.safeParse({ ...choice, label: 'Build' }).success).toBe(true);
    for (const extra of [{ path: '/Users/someone' }, { parent: '/' }, { realPath: '/' }, { access: 'read-only' }, { isolation: 'worktree' }, { kind: 'plain' }]) {
      expect(make.safeParse({ ...choice, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(make.safeParse({ ...choice, name: '' }).success).toBe(false);
    expect(make.safeParse({ ...choice, name: 'x'.repeat(257) }).success).toBe(false);
    expect(make.safeParse({ name: 'build' }).success).toBe(false);
  });

  it('lets a name that the runner will refuse reach it, so that the owner reads the runner’s own words', () => {
    expect(CHANNELS['folders:new-workspace'].request.safeParse({ name: '../escape', approval: 'auto', trusted: false, agent: null }).success).toBe(true);
  });

  it('says whether a folder is a workspace, and reads one with no kind as it always was', () => {
    const folder = { label: 'build', path: '/w/build', realPath: '/w/build', access: 'edit', approval: 'ask', isolation: 'in-place', trusted: false, agent: null };
    const [plain, workspace] = CHANNELS['folders:list'].reply.parse([{ folder }, { folder: { ...folder, kind: 'workspace' } }]);
    expect(plain?.folder.kind).toBeUndefined();
    expect(workspace?.folder.kind).toBe('workspace');
    expect(CHANNELS['folders:list'].reply.safeParse([{ folder: { ...folder, kind: 'other' } }]).success).toBe(false);
  });

  it('reads a waiting task with no kind as a task, and a clone with its address whole', () => {
    const task = { askId: 'a1', taskId: 't1', folder: 'site', access: 'edit', instruction: 'Fix it' };
    const clone = { kind: 'clone', askId: 'a2', taskId: 't1', workspace: 'build', url: `https://example.com/${'p'.repeat(400)}.git`, folder: 'repo' };
    const [first, second] = CHANNELS['approvals:list'].reply.parse([task, clone]);
    expect(first).toMatchObject({ kind: 'task', instruction: 'Fix it' });
    expect(second).toEqual(clone);
    expect(CHANNELS['approvals:list'].reply.safeParse([{ ...clone, url: '' }]).success).toBe(false);
    expect(eventSchema.safeParse({ kind: 'approvals', pending: [clone] }).success).toBe(true);
  });
});
