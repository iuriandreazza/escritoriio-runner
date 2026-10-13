import { MAX_RUNNER_MESSAGE_BYTES, TASK_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { idOfUnreadableOffer } from './unreadable-offer.ts';

const offer = (fields: Record<string, unknown>): string => JSON.stringify({ type: 'task.offer', taskId: 't1', folder: 'site', agent: 'claude-code', instruction: 'Fix it', ...fields });

describe('the id of an offer that could not be read', () => {
  it.each([
    ['an instruction that is too long', offer({ instruction: 'x'.repeat(TASK_LIMITS.instruction + 1) })],
    ['a coding agent that is not known', offer({ agent: 'gpt-9' })],
    ['a field that is not there', JSON.stringify({ type: 'task.offer', taskId: 't1' })],
    ['a field of another kind', offer({ folder: 7 })],
  ])('is the id of the offer with %s', (_what, raw) => {
    expect(idOfUnreadableOffer(raw)).toBe('t1');
  });

  it('is the id as it was written, when it is one that a branch can be named for', () => {
    expect(idOfUnreadableOffer(offer({ taskId: '3f1c-9A_b', agent: 'gpt' }))).toBe('3f1c-9A_b');
    expect(idOfUnreadableOffer(offer({ taskId: 'a'.repeat(TASK_LIMITS.taskId), agent: 'gpt' }))).toBe('a'.repeat(TASK_LIMITS.taskId));
  });

  it.each([
    ['an id that is too long', offer({ taskId: 'a'.repeat(TASK_LIMITS.taskId + 1) })],
    ['an id with a slash', offer({ taskId: '../x' })],
    ['an id with a space', offer({ taskId: 'a b' })],
    ['an id that is not text', offer({ taskId: 7 })],
    ['no id', JSON.stringify({ type: 'task.offer', agent: 'gpt' })],
    ['an empty id', offer({ taskId: '' })],
    ['a message that is not an offer', JSON.stringify({ type: 'task.cancel', taskId: 't1' })],
    ['a message of a type nobody knows', JSON.stringify({ type: 'something.new', taskId: 't1' })],
    ['a message with no type', JSON.stringify({ taskId: 't1' })],
    ['something that is not JSON', 'task.offer t1'],
    ['JSON that is not an object', '"task.offer"'],
    ['null', 'null'],
    ['an array', '[{"type":"task.offer","taskId":"t1"}]'],
    ['a message that is too long to have been read', offer({ instruction: 'x'.repeat(MAX_RUNNER_MESSAGE_BYTES) })],
  ])('is nothing for %s', (_what, raw) => {
    expect(idOfUnreadableOffer(raw)).toBeUndefined();
  });
});
