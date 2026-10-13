import { beforeEach, describe, expect, it } from 'vitest';
import { clearAgentPath, describeAgents, setAgentPath } from './agents.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { detected, FakeAgent, FakePolicyStore } from './task-testing.ts';

let policy: FakePolicyStore;
let claude: FakeAgent;

beforeEach(() => {
  policy = new FakePolicyStore(EMPTY_POLICY);
  claude = new FakeAgent('claude-code');
});

const deps = (windows = false) => ({ policy, agents: { 'claude-code': claude }, windows });

describe('the coding agents', () => {
  it('are listed with where each is, its version, whether somebody is logged in, and what contains it', async () => {
    expect(await describeAgents(deps())).toEqual([
      'claude-code',
      '  found:        yes, at /usr/local/bin/claude',
      '  version:      2.1.250',
      '  logged in:    yes',
      '  supported:    yes',
      '  containment:  it has a sandbox of its own on this system',
      'codex',
      '  this runner cannot drive it yet',
      'kimi-code',
      '  this runner cannot drive it yet',
    ]);
  });

  it('say what is wrong, in the words of the adapter, and how a tool that is not logged in is told to log in', async () => {
    claude.detection = { ...detected, loggedIn: false, supported: false, containment: 'none', problem: 'This version is too old: 2.0.0.' };
    const lines = (await describeAgents(deps())).join('\n');
    expect(lines).toContain('logged in:    no: log in to it');
    expect(lines).toContain('supported:    no: this runner cannot drive this version');
    expect(lines).toContain('containment:  none on this system: it runs only in a folder marked as trusted');
    expect(lines).toContain('problem:      This version is too old: 2.0.0.');
  });

  it('say that a tool cannot tell whether somebody is logged in, rather than guessing', async () => {
    claude.detection = { ...detected, loggedIn: null, version: undefined };
    const lines = (await describeAgents(deps())).join('\n');
    expect(lines).toContain('logged in:    not known');
    expect(lines).toContain('version:      not known');
  });

  it('say that one is not found, and that the path the person picked did not lead to it', async () => {
    claude.detection = { ...detected, installed: false, path: undefined, version: undefined, loggedIn: null, problem: 'It is not installed.' };
    expect((await describeAgents(deps())).slice(0, 3)).toEqual(['claude-code', '  found:        no', '  problem:      It is not installed.']);
    policy.policy = { ...EMPTY_POLICY, agentPaths: { 'claude-code': '/opt/claude' } };
    expect((await describeAgents(deps()))[1]).toBe('  found:        no, not at the path you picked');
  });

  it('are looked for where the person said, and that is shown', async () => {
    policy.policy = { ...EMPTY_POLICY, agentPaths: { 'claude-code': '/opt/claude' } };
    expect(await describeAgents(deps())).toContain('  found:        yes, at /usr/local/bin/claude (the path you picked)');
    expect(claude.detects).toEqual(['/opt/claude']);
  });

  it('are shown without what a tool says that could redraw a terminal', async () => {
    claude.detection = { ...detected, version: '2.1.0\u001b[2J', path: '/bin/claude\r\nfake: line' };
    for (const line of await describeAgents(deps())) expect(line).not.toMatch(/\p{Cc}/u);
  });

  it('say that one could not be looked at, when looking fails', async () => {
    claude.detect = () => Promise.reject(new Error('crashed'));
    expect((await describeAgents(deps())).slice(0, 2)).toEqual(['claude-code', '  it could not be looked at']);
  });
});

describe('where the person says a coding agent is', () => {
  it('is kept once what is there is looked at and can be run, and is looked for there from then on', async () => {
    const detection = await setAgentPath(deps(), 'claude-code', '/opt/claude/bin/claude');
    expect(detection).toMatchObject({ installed: true });
    expect(claude.detects).toEqual(['/opt/claude/bin/claude']);
    expect(policy.policy.agentPaths).toEqual({ 'claude-code': '/opt/claude/bin/claude' });
  });

  it('keeps nothing else the policy had', async () => {
    policy.policy = { folders: [], agentPaths: {}, paused: true };
    await setAgentPath(deps(), 'claude-code', '/opt/claude');
    expect(policy.policy).toMatchObject({ paused: true });
  });

  it('is not kept when nothing that can be run is there, and says why', async () => {
    claude.detection = { ...detected, installed: false, problem: 'That is not Claude Code.' };
    await expect(setAgentPath(deps(), 'claude-code', '/opt/other')).rejects.toThrow('Nothing that can be run as claude-code was found at that path. That is not Claude Code.');
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('says what is wrong without a full stop twice when the words of the adapter end in one', async () => {
    claude.detection = { ...detected, installed: false, problem: 'It is not installed.' };
    const failure = setAgentPath(deps(), 'claude-code', '/opt/other');
    await expect(failure).rejects.toThrow('Nothing that can be run as claude-code was found at that path. It is not installed.');
    await expect(failure).rejects.not.toThrow('..');
    claude.detection = { ...detected, installed: false, problem: undefined };
    await expect(setAgentPath(deps(), 'claude-code', '/opt/other')).rejects.toThrow(/^Nothing that can be run as claude-code was found at that path\.$/);
  });

  it('is not kept when what is there is a version this runner cannot drive, and says so', async () => {
    claude.detection = { ...detected, supported: false, problem: 'This version is too old: 2.0.0.' };
    await expect(setAgentPath(deps(), 'claude-code', '/opt/old')).rejects.toThrow('claude-code is at that path, but this runner cannot drive that version of it. This version is too old: 2.0.0.');
    expect(policy.policy).toEqual(EMPTY_POLICY);
  });

  it('is refused when it is not a full path, before anything is run', async () => {
    await expect(setAgentPath(deps(), 'claude-code', 'bin/claude')).rejects.toThrow('That is not the full path of a program.');
    await expect(setAgentPath(deps(true), 'claude-code', '/usr/bin/claude')).rejects.toThrow(/full path/);
    expect(claude.detects).toEqual([]);
    expect(await setAgentPath(deps(true), 'claude-code', 'C:\\Tools\\claude.exe')).toMatchObject({ installed: true });
  });

  it('is refused for a tool this runner cannot drive', async () => {
    await expect(setAgentPath(deps(), 'codex', '/opt/codex')).rejects.toThrow('This runner cannot drive codex yet.');
  });

  it('can be taken back, and the tool is found by itself again', async () => {
    policy.policy = { ...EMPTY_POLICY, agentPaths: { 'claude-code': '/opt/claude' }, paused: true };
    expect(await clearAgentPath(deps(), 'claude-code')).toBe(true);
    expect(policy.policy).toEqual({ ...EMPTY_POLICY, paused: true });
  });

  it('is nothing to take back when there was none', async () => {
    expect(await clearAgentPath(deps(), 'claude-code')).toBe(false);
  });
});
