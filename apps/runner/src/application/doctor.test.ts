import { describe, expect, it } from 'vitest';
import type { AgentView } from './agents.ts';
import type { DoctorDeps } from './doctor.ts';
import { describeDoctor, judgeAgent, judgeAgentsUsable, judgeClock, judgeConnection, judgeFolders, judgeVersion, runDoctor } from './doctor.ts';
import { detected, FakeAgent, FakePolicyStore, FakeResolver, site, surroundings } from './task-testing.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { FakeDeviceStore, FakeOfficeProbe, pairedDevice } from './testing.ts';

const view = (overrides: Partial<AgentView> = {}): AgentView => ({ kind: 'claude-code', drivable: true, detection: detected, pickedPath: undefined, ...overrides });

describe('how a coding agent stands', () => {
  it.each([
    ['ready and contained', view(), 'ok', /Found 2\.1\.250, logged in, contained by a sandbox/],
    ['one this runner cannot drive', view({ kind: 'codex', drivable: false, detection: undefined }), 'ok', /cannot drive it yet/],
    ['one that could not be looked at', view({ detection: undefined }), 'warn', /could not be looked at/],
    ['not installed', view({ detection: { ...detected, installed: false, path: undefined, version: undefined } }), 'warn', /Not found\./],
    ['not installed at the path that was picked', view({ pickedPath: '/opt/claude', detection: { ...detected, installed: false } }), 'warn', /not at the path that was picked/],
    ['installed in a version it cannot drive', view({ detection: { ...detected, supported: false, problem: 'Update Claude Code.' } }), 'warn', /cannot drive that version\. Update Claude Code\./],
    ['not logged in', view({ detection: { ...detected, loggedIn: false } }), 'warn', /nobody is logged in/],
    ['one whose login is not known', view({ detection: { ...detected, loggedIn: null } }), 'ok', /login not known/],
    ['one with nothing to contain it', view({ detection: { ...detected, containment: 'none' } }), 'warn', /only in a folder marked as trusted/],
  ])('says it for %s', (_name, agent, status, message) => {
    expect(judgeAgent(agent)).toMatchObject({ status, message: expect.stringMatching(message) });
  });

  it('does not say where a coding agent is: the report is meant to be shared', () => {
    expect(judgeAgent(view({ pickedPath: '/Users/ana/bin/claude' })).message).not.toContain('/Users/ana');
    expect(judgeAgent(view()).message).not.toContain(detected.path);
  });

  it('fails when nothing can do work, and is ready when one can', () => {
    expect(judgeAgentsUsable([view({ detection: { ...detected, loggedIn: false } }), view({ kind: 'codex', drivable: false, detection: undefined })])).toMatchObject({ status: 'fail' });
    expect(judgeAgentsUsable([])).toMatchObject({ status: 'fail' });
    expect(judgeAgentsUsable([view()])).toMatchObject({ status: 'ok', message: 'Ready: claude-code.' });
    expect(judgeAgentsUsable([view({ detection: { ...detected, loggedIn: null } })]).status).toBe('ok');
  });
});

describe('how the folders stand', () => {
  it('warns that none is shared, and is fine when every one is where it was', () => {
    expect(judgeFolders([])).toMatchObject({ status: 'warn', message: expect.stringContaining('No folder is shared') });
    expect(judgeFolders([{ folder: site, problem: undefined }])).toMatchObject({ status: 'ok', message: '1 shared, every one where it was when it was shared.' });
  });

  it('names, by label and never by path, the folders that no longer resolve', () => {
    const report = judgeFolders([
      { folder: site, problem: undefined },
      { folder: { ...site, label: 'gone' }, problem: 'The folder is not there any more.' },
    ]);
    expect(report.status).toBe('warn');
    expect(report.message).toContain('"gone" (The folder is not there any more.)');
    expect(report.message).not.toContain('/Users/ana');
  });
});

describe('the clock', () => {
  it.each([
    [0, 'ok'],
    [120_000, 'ok'],
    [120_001, 'warn'],
    [-300_000, 'warn'],
    [undefined, 'ok'],
  ] as const)('is %s ms from the office: %s', (skew, status) => {
    expect(judgeClock(skew).status).toBe(status);
  });

  it('says which way and by how much', () => {
    expect(judgeClock(300_000).message).toContain('5 minutes ahead of the office');
    expect(judgeClock(-150_000).message).toContain('3 minutes behind the office');
  });
});

describe('the version', () => {
  it('fails, with how to update, when it is older than the office needs, and passes otherwise', () => {
    expect(judgeVersion('0.1.0', '0.2.0')).toMatchObject({ status: 'fail', message: expect.stringContaining('Update the runner') });
    expect(judgeVersion('0.2.0', '0.2.0').status).toBe('ok');
    expect(judgeVersion('0.3.0', '0.2.0').status).toBe('ok');
    expect(judgeVersion('0.1.0', undefined).status).toBe('ok');
  });
});

describe('the connection', () => {
  const reached = { reached: true, status: 200, date: null, sentAt: 0, receivedAt: 0, minRunnerVersion: undefined } as const;
  it('says whether the office answered, and with what', () => {
    expect(judgeConnection('office.example.com', reached).status).toBe('ok');
    expect(judgeConnection('office.example.com', { ...reached, status: 502 })).toMatchObject({ status: 'fail', message: 'office.example.com answered, but with HTTP 502.' });
    expect(judgeConnection('office.example.com', { reached: false, reason: 'the connection failed: ECONNREFUSED' })).toMatchObject({ status: 'fail', message: expect.stringContaining('could not be reached') });
  });
});

describe('the doctor', () => {
  function setup() {
    const policy = new FakePolicyStore({ ...EMPTY_POLICY, folders: [site] });
    const resolver = new FakeResolver();
    const devices = new FakeDeviceStore();
    devices.saved = pairedDevice;
    const probe = new FakeOfficeProbe();
    const agent = new FakeAgent();
    const deps: DoctorDeps = { policy, resolver, surroundings, agents: { 'claude-code': agent }, devices, probe, runnerVersion: '0.2.0', os: 'darwin' };
    return { policy, resolver, devices, probe, agent, deps };
  }
  const byId = (checks: readonly { id: string }[], id: string) => checks.find((one) => one.id === id);

  it('looks at everything, and is healthy when nothing fails', async () => {
    const { deps, probe } = setup();
    const report = await runDoctor(deps);
    expect(report.healthy).toBe(true);
    expect(report.checks.map((one) => [one.id, one.status])).toEqual([
      ['runner', 'ok'],
      ['settings', 'ok'],
      ['agents', 'ok'],
      ['agent-claude-code', 'ok'],
      ['agent-codex', 'ok'],
      ['agent-kimi-code', 'ok'],
      ['folders', 'ok'],
      ['connection', 'ok'],
      ['clock', 'ok'],
      ['version', 'ok'],
    ]);
    expect(probe.asked).toEqual([pairedDevice.server]);
  });

  it('is not healthy when a check fails, and says which', async () => {
    const { deps, probe } = setup();
    probe.reach_ = { reached: false, reason: 'the connection failed: ECONNREFUSED' };
    const report = await runDoctor(deps);
    expect(report.healthy).toBe(false);
    expect(byId(report.checks, 'connection')).toMatchObject({ status: 'fail' });
    expect(describeDoctor(report).at(-1)).toBe('Something is failing: see the lines marked FAIL.');
    expect(describeDoctor(report).some((line) => line.startsWith('[FAIL] Connection:'))).toBe(true);
  });

  it('warns, without asking the office anything, when the machine is not paired', async () => {
    const { deps, devices, probe } = setup();
    devices.saved = undefined;
    const report = await runDoctor(deps);
    expect(byId(report.checks, 'connection')).toMatchObject({ status: 'warn' });
    expect(probe.asked).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it('warns about the clock from two minutes and fails a runner older than the office needs, both from what the office answered', async () => {
    const { deps, probe } = setup();
    probe.reach_ = { reached: true, status: 200, date: new Date(1_000_000).toUTCString(), sentAt: 1_000_000 + 200_000, receivedAt: 1_000_000 + 200_000, minRunnerVersion: '0.3.0' };
    const report = await runDoctor(deps);
    expect(byId(report.checks, 'clock')).toMatchObject({ status: 'warn', message: expect.stringContaining('3 minutes ahead') });
    expect(byId(report.checks, 'version')).toMatchObject({ status: 'fail' });
  });

  it('fails when the settings cannot be read, and goes on to look at the rest', async () => {
    const { deps, policy } = setup();
    policy.load = () => Promise.reject(new Error('The settings kept in /Users/ana/x are damaged.'));
    const report = await runDoctor(deps);
    expect(byId(report.checks, 'settings')).toMatchObject({ status: 'fail' });
    expect(byId(report.checks, 'connection')).toMatchObject({ status: 'ok' });
    expect(report.healthy).toBe(false);
  });

  it('fails when the pairing cannot be read', async () => {
    const { deps, devices } = setup();
    devices.load = () => Promise.reject(new Error('damaged'));
    expect(byId((await runDoctor(deps)).checks, 'connection')).toMatchObject({ status: 'fail', message: expect.stringContaining('Pair it again') });
  });

  it('warns of a folder that is no longer where it was', async () => {
    const { deps, resolver } = setup();
    resolver.answers.set(site.path, null);
    expect(byId((await runDoctor(deps)).checks, 'folders')).toMatchObject({ status: 'warn' });
  });

  it('writes the home of the person as ~ in what a tool says of itself, and the places of the runner too', async () => {
    const { deps, agent } = setup();
    agent.detection = { ...detected, installed: false, problem: `Not found in /Users/ana/bin and ${surroundings.stateDirectory}/policy.json` };
    const text = JSON.stringify(await runDoctor(deps));
    expect(text).not.toContain('/Users/ana');
    expect(text).toContain('Not found in ~/bin and <runner>/policy.json');
  });

  it('takes out of everything it says what looks like a secret and the token of the device, wherever it came from', async () => {
    const { deps, agent, probe } = setup();
    agent.detection = { ...detected, installed: false, problem: `Failed with ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv and ${pairedDevice.token}` };
    probe.reach_ = { reached: false, reason: `Bearer ${pairedDevice.token}1234 refused` };
    const text = JSON.stringify(await runDoctor(deps));
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain(pairedDevice.token);
    expect(text).toContain('[secret removed]');
  });
});
