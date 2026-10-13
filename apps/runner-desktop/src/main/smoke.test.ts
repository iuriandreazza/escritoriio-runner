import { describe, expect, it } from 'vitest';
import { planSmoke, SMOKE_FLAG } from './smoke.ts';

describe('the smoke start', () => {
  it('is not asked for by an ordinary start, nor by a link that happens to contain the word', () => {
    expect(planSmoke(['app', '--disable-gpu'], {})).toEqual({ kind: 'normal' });
    expect(planSmoke(['app', 'escritoriio://pair?note=--smoke'], {})).toEqual({ kind: 'normal' });
  });

  it('is asked for by the flag, and then uses the state directory of the environment alone', () => {
    expect(planSmoke(['app', SMOKE_FLAG], { ESCRITORIIO_RUNNER_HOME: '/tmp/scratch' })).toEqual({ kind: 'smoke', stateDirectory: '/tmp/scratch' });
  });

  it.each([undefined, '', '   '])('refuses to run without a state directory of its own (%j)', (home) => {
    const plan = planSmoke(['app', SMOKE_FLAG], { ESCRITORIIO_RUNNER_HOME: home });
    expect(plan.kind).toBe('refused');
    expect(plan.kind === 'refused' && plan.message).toContain('ESCRITORIIO_RUNNER_HOME');
  });
});
