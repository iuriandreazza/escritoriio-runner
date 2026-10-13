import { RUNNER_CLOSE } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import type { ConnectionEnd, Decision } from './connection-end.ts';
import { decideAfter } from './connection-end.ts';

const closed = (code: number): ConnectionEnd => ({ kind: 'closed', code });
const refused = (status: number): ConnectionEnd => ({ kind: 'refused', status });
const failed = (reason: string): ConnectionEnd => ({ kind: 'failed', reason });

describe('what a runner does when its connection ends', () => {
  it.each<[string, ConnectionEnd, Partial<Decision>]>([
    ['the office removed the device', closed(RUNNER_CLOSE.revoked), { action: 'stop', cause: 'revoked' }],
    ['the office speaks another protocol', closed(RUNNER_CLOSE.unsupportedProtocol), { action: 'stop', cause: 'unsupported-protocol' }],
    ['another connection of the device took its place', closed(RUNNER_CLOSE.replaced), { action: 'stop', cause: 'replaced' }],
    ['the office does not know the token', refused(401), { action: 'stop', cause: 'unknown-device' }],
    ['the device is not allowed for now, said by a close', closed(RUNNER_CLOSE.notAllowed), { action: 'retry', slow: true }],
    ['the device is not allowed for now, said by a refusal', refused(403), { action: 'retry', slow: true }],
    ['a proxy had no server to give', refused(502), { action: 'retry', slow: false }],
    ['the office is busy', refused(429), { action: 'retry', slow: false }],
    ['the office is down for a moment', refused(503), { action: 'retry', slow: false }],
    ['the connection was dropped without a word', closed(1006), { action: 'retry', slow: false }],
    ['the office is going away', closed(1001), { action: 'retry', slow: false }],
    ['the office turned away a runner that was too quiet', closed(1008), { action: 'retry', slow: false }],
    ['a close of a code nobody knows', closed(4999), { action: 'retry', slow: false }],
    ['the office could not be reached', failed('connect ECONNREFUSED 127.0.0.1:1'), { action: 'retry', slow: false }],
  ])('%s', (_name, end, expected) => {
    expect(decideAfter(end)).toMatchObject(expected);
  });

  it('says to a person, in its own words, why it stopped and what to do', () => {
    const stops = [closed(RUNNER_CLOSE.revoked), closed(RUNNER_CLOSE.unsupportedProtocol), closed(RUNNER_CLOSE.replaced), refused(401)].map(decideAfter);
    const messages = stops.map((decision) => (decision.action === 'stop' ? decision.message : ''));
    expect(messages[0]).toMatch(/removed in the office.*pair/i);
    expect(messages[1]).toMatch(/update the runner/i);
    expect(messages[2]).toMatch(/another process/i);
    expect(messages[3]).toMatch(/does not know this device.*pair/i);
  });

  it('gives the same words, its own, whether a device that is not allowed was told by a close or by a refusal', () => {
    const words = decideAfter(refused(403));
    expect(words).toEqual({ action: 'retry', slow: true, reason: expect.stringContaining('not allowed to work for now') });
    expect(decideAfter(closed(RUNNER_CLOSE.notAllowed))).toEqual(words);
  });

  it('has a reason for each way a connection is lost', () => {
    expect(decideAfter(refused(502))).toMatchObject({ reason: expect.stringContaining('502') });
    expect(decideAfter(closed(1006))).toMatchObject({ reason: expect.stringContaining('lost') });
    expect(decideAfter(failed(''))).toMatchObject({ reason: expect.stringContaining('could not be reached') });
  });

  it('gives the reason of a failure with nothing in it that a terminal would act on', () => {
    expect(decideAfter(failed('the connection failed: ECONN\u001b[2JREFUSED'))).toMatchObject({ reason: 'the connection failed: ECONN [2JREFUSED' });
  });
});
