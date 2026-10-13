import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RUNNER_REACH_PATH } from '@escritoriio/runner-protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpOfficeProbe } from './http-office-probe.ts';

let server: Server;
let origin: string;
let answer: (request: IncomingMessage, response: ServerResponse) => void;
const requests: { url: string | undefined; authorization: string | undefined }[] = [];

beforeEach(async () => {
  requests.length = 0;
  answer = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', revision: 'abc', minRunnerVersion: '0.1.0' }));
  };
  server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('asking the office whether it is there', () => {
  it('reads its time and the oldest runner it lets in from a plain request, with no token', async () => {
    const reach = await createHttpOfficeProbe().reach(origin);
    expect(reach).toMatchObject({ reached: true, status: 200, minRunnerVersion: '0.1.0' });
    expect(reach.reached && reach.date).toMatch(/GMT$/);
    expect(reach.reached && reach.receivedAt >= reach.sentAt).toBe(true);
    expect(requests).toEqual([{ url: RUNNER_REACH_PATH, authorization: undefined }]);
  });

  it('is reached all the same by an office that answers with something that is not JSON, or says no minimum', async () => {
    answer = (_request, response) => void response.end('<html>hello</html>');
    expect(await createHttpOfficeProbe().reach(origin)).toMatchObject({ reached: true, minRunnerVersion: undefined });
    answer = (_request, response) => void response.end(JSON.stringify({ status: 'ok' }));
    expect(await createHttpOfficeProbe().reach(origin)).toMatchObject({ reached: true, minRunnerVersion: undefined });
  });

  it('says the status of an office that answers with an error, and does not follow a redirect', async () => {
    answer = (_request, response) => {
      response.writeHead(302, { Location: 'https://elsewhere.example.com/' });
      response.end();
    };
    expect(await createHttpOfficeProbe().reach(origin)).toMatchObject({ reached: true, status: 302 });
    expect(requests).toHaveLength(1);
  });

  it('says it when nothing answers, with the network’s word, and when it is too slow', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await createHttpOfficeProbe().reach(origin)).toEqual({ reached: false, reason: 'ECONNREFUSED' });
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const slow = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await createHttpOfficeProbe({ timeoutMs: 50 }).reach(slow)).toEqual({ reached: false, reason: 'it did not answer in time' });
    server.closeAllConnections();
  });

  it('does not ask an address the runner would not pair with', async () => {
    expect(await createHttpOfficeProbe().reach('http://office.example.com')).toMatchObject({ reached: false });
    expect(requests).toEqual([]);
  });
});
