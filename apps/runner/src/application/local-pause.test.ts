import { describe, expect, it } from 'vitest';
import { describeLocalPause, setLocalPause } from './local-pause.ts';
import { EMPTY_POLICY } from './task-ports.ts';
import { FakePolicyStore, site } from './task-testing.ts';

describe('pausing on the machine', () => {
  it('keeps that it is paused, and nothing else of the policy changes', async () => {
    const policy = new FakePolicyStore({ folders: [site], agentPaths: { 'claude-code': '/opt/claude' }, paused: false });
    expect(await setLocalPause(policy, true)).toBe(true);
    expect(policy.policy).toEqual({ folders: [site], agentPaths: { 'claude-code': '/opt/claude' }, paused: true });
  });

  it('is resumed the same way', async () => {
    const policy = new FakePolicyStore({ ...EMPTY_POLICY, paused: true });
    expect(await setLocalPause(policy, false)).toBe(true);
    expect(policy.policy.paused).toBe(false);
  });

  it('writes nothing when it was so already', async () => {
    const policy = new FakePolicyStore(EMPTY_POLICY);
    expect(await setLocalPause(policy, false)).toBe(false);
    expect(policy.writes).toBe(0);
  });

  it('says what it means', () => {
    expect(describeLocalPause(true, true).join('\n')).toMatch(/^Paused\..*takes no task.*stopped.*within a second.*resume/s);
    expect(describeLocalPause(true, false)[0]).toBe('It was paused already.');
    expect(describeLocalPause(false, true).join('\n')).toMatch(/^Resumed\..*the office paused this machine as well/s);
    expect(describeLocalPause(false, false)[0]).toBe('It was not paused.');
  });
});
