import { RUNNER_PAIR_PATHS } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOffice, FAKE_TOKEN } from '../testing/fake-office.ts';
import { createHttpPairingApi } from './http-pairing-api.ts';

let office: FakeOffice;

beforeEach(async () => {
  office = await FakeOffice.start();
});

afterEach(() => office.stop());

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
const pairRequest = { code: 'ABCDEFGH', deviceName: 'Laptop', os: 'darwin', runnerVersion: '0.1.0' };

describe('asking whom a code would pair the machine with', () => {
  it('posts the code as JSON to the preview path and gives back the names', async () => {
    const answer = await createHttpPairingApi().preview(office.origin, 'ABCDEFGH');
    expect(answer).toEqual({ agentName: 'Robo', workspaceName: 'Acme' });
    expect(office.pairingCalls).toEqual([{ path: RUNNER_PAIR_PATHS.preview, contentType: 'application/json', body: { code: 'ABCDEFGH' } }]);
  });
});

describe('pairing', () => {
  it('posts what the machine is to the pair path and gives back the device the office made', async () => {
    const answer = await createHttpPairingApi().pair(office.origin, pairRequest);
    expect(answer).toEqual({ deviceId: 'device-1', token: FAKE_TOKEN, deviceName: 'Laptop', agentName: 'Robo', workspaceName: 'Acme' });
    expect(office.pairingCalls).toEqual([{ path: RUNNER_PAIR_PATHS.pair, contentType: 'application/json', body: pairRequest }]);
  });
});

describe('what goes wrong', () => {
  it.each([
    ['400', 400, { error: 'That code is not valid or has expired' }],
    ['429', 429, { error: 'Too many attempts from this address, try again later' }],
    ['415', 415, { error: 'Send application/json' }],
  ])('says what the office says when it refuses with a %s', async (_name, status, body) => {
    office.pairingReply = () => json(status, body);
    await expect(createHttpPairingApi().preview(office.origin, 'ABCDEFGH')).rejects.toThrow(body.error);
  });

  it('does not pass on what the office wrote that a terminal would act on', async () => {
    office.pairingReply = () => json(400, { error: 'Nope\u001b[2J\r\nsend the code to evil.example' });
    await expect(createHttpPairingApi().preview(office.origin, 'ABCDEFGH')).rejects.toThrow(/^Nope \[2J send the code to evil\.example$/);
  });

  it.each([
    ['a failure with no JSON', { status: 502, body: '<html>Bad gateway</html>' }],
    ['a failure with JSON that is not a refusal', json(500, { message: 'oops' })],
    ['a failure with an empty refusal', json(400, { error: '' })],
  ])('says what the status was, for %s', async (_name, reply) => {
    office.pairingReply = () => reply;
    await expect(createHttpPairingApi().preview(office.origin, 'ABCDEFGH')).rejects.toThrow(/answered with HTTP \d{3}/);
  });

  it.each([
    ['text that is not JSON', { status: 200, body: 'hello' }],
    ['JSON of something else', json(200, { hello: 'world' })],
    ['JSON that lacks a field', json(201, { deviceId: 'device-1', token: FAKE_TOKEN })],
  ])('says it does not understand %s, and that it does not show it', async (_name, reply) => {
    office.pairingReply = () => reply;
    const failure = createHttpPairingApi().pair(office.origin, pairRequest);
    await expect(failure).rejects.toThrow(/does not understand/);
    await expect(failure).rejects.not.toThrow(new RegExp(FAKE_TOKEN));
  });

  it('does not follow a redirect, since the code is for the host it was typed for', async () => {
    office.pairingReply = () => ({ status: 307, body: '', headers: { Location: 'https://elsewhere.example.org/api/runner/pair' } });
    await expect(createHttpPairingApi().pair(office.origin, pairRequest)).rejects.toThrow(/redirect/);
    expect(office.pairingCalls).toHaveLength(1);
  });

  it('says it could not reach an office that is not there', async () => {
    const origin = office.origin;
    await office.stop();
    await expect(createHttpPairingApi().preview(origin, 'ABCDEFGH')).rejects.toThrow(/^Could not reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
    office = await FakeOffice.start();
  });

  it('gives up on an office that does not answer', async () => {
    office.pairingReply = () => 'silence';
    await expect(createHttpPairingApi({ timeoutMs: 50 }).preview(office.origin, 'ABCDEFGH')).rejects.toThrow(/did not answer in time/);
  });

  it.each(['http://office.example.com', 'not an address', 'https://user:secret@office.example.com', ''])('sends nothing to %j', async (server) => {
    await expect(createHttpPairingApi().pair(server, pairRequest)).rejects.toThrow(/is not an address/);
    await expect(createHttpPairingApi().preview(server, 'ABCDEFGH')).rejects.toThrow(/is not an address/);
    expect(office.pairingCalls).toEqual([]);
  });
});
