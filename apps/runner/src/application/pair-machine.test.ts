import { pairingLink } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import type { PairMachineRequest, PairQuestion } from './pair-machine.ts';
import { describePairNotice, describePairQuestion, pairMachine } from './pair-machine.ts';
import { FakeDeviceStore, FakePairingApi, fakeSystem, pairedDevice } from './testing.ts';

function setup(system = fakeSystem()) {
  const calls: string[] = [];
  const pairing = new FakePairingApi(calls);
  const devices = new FakeDeviceStore(calls);
  const questions: PairQuestion[] = [];
  const run = (request: Partial<PairMachineRequest> & { answer?: boolean } = {}) => {
    const { answer = true, ...rest } = request;
    return pairMachine(
      { pairing, devices, system, runnerVersion: '0.1.0' },
      {
        input: ['https://office.example.com', 'abcd-efgh'],
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(answer);
        },
        ...rest,
      },
    );
  };
  return { pairing, devices, calls, questions, run };
}

describe('pairing a machine', () => {
  it('asks who it would be paired with, and where, before it uses the code', async () => {
    const { pairing, questions, run } = setup();
    let pairingsWhenAsked = -1;
    await run({
      confirm: (question) => {
        questions.push(question);
        pairingsWhenAsked = pairing.pairings.length;
        return Promise.resolve(true);
      },
    });
    expect(pairing.previews).toEqual([{ server: 'https://office.example.com', code: 'ABCDEFGH' }]);
    expect(questions).toEqual([{ host: 'office.example.com', agentName: 'Robo', workspaceName: 'Acme', deviceName: 'Ana\u2019s MacBook' }]);
    expect(pairingsWhenAsked).toBe(0);
  });

  it('keeps the device when the person says yes, and gives back what it kept without the token', async () => {
    const { pairing, devices, run } = setup();
    const outcome = await run();
    expect(pairing.pairings).toEqual([{ server: 'https://office.example.com', request: { code: 'ABCDEFGH', deviceName: 'Ana\u2019s MacBook', os: 'darwin', runnerVersion: '0.1.0' } }]);
    expect(devices.saved).toEqual({ ...pairedDevice, deviceName: 'Ana\u2019s MacBook' });
    expect(outcome).toEqual({ paired: true, host: 'office.example.com', agentName: 'Robo', workspaceName: 'Acme', deviceName: 'Ana\u2019s MacBook' });
    expect(JSON.stringify(outcome)).not.toContain(pairedDevice.token);
  });

  it('does not use the code up, nor keep anything, when the person says no', async () => {
    const { pairing, devices, run } = setup();
    expect(await run({ answer: false })).toEqual({ paired: false });
    expect(pairing.pairings).toEqual([]);
    expect(devices.saved).toBeUndefined();
  });

  it('reads the pairing link the office shows', async () => {
    const { pairing, run } = setup();
    await run({ input: [pairingLink('https://office.example.com', 'ABCDEFGH')] });
    expect(pairing.previews).toEqual([{ server: 'https://office.example.com', code: 'ABCDEFGH' }]);
  });

  it('writes the code and the address the way the protocol compares them', async () => {
    const { pairing, run } = setup();
    await run({ input: ['office.example.com/', 'abcd efgh'] });
    expect(pairing.previews).toEqual([{ server: 'https://office.example.com', code: 'ABCDEFGH' }]);
    expect(pairing.pairings[0]?.request.code).toBe('ABCDEFGH');
  });

  it('names the device as the person said, tidied', async () => {
    const { pairing, run } = setup();
    await run({ deviceName: '  Office desktop\n' });
    expect(pairing.pairings[0]?.request.deviceName).toBe('Office desktop');
  });

  it('names the device after the machine when the person says nothing, cut to what the office takes', async () => {
    const { pairing, run } = setup(fakeSystem({ deviceName: `${'long-host-name-'.repeat(10)}` }));
    await run();
    expect(pairing.pairings[0]?.request.deviceName).toHaveLength(64);
  });

  it('has a name of its own for a machine that has none', async () => {
    const { pairing, run } = setup(fakeSystem({ deviceName: '' }));
    await run();
    expect(pairing.pairings[0]?.request.deviceName).toBe('My machine');
  });

  it('refuses what is not a pairing, before it asks the office anything', async () => {
    const { pairing, run } = setup();
    await expect(run({ input: ['office.example.com'] })).rejects.toThrow(/pairing link/);
    await expect(run({ input: ['http://office.example.com', 'ABCDEFGH'] })).rejects.toThrow(/https/);
    expect(pairing.previews).toEqual([]);
  });

  it('gives the words of the office when it refuses the code, and asks nothing of the person', async () => {
    const { pairing, devices, questions, run } = setup();
    pairing.refusePreviewWith = new Error('That code is not valid or has expired');
    await expect(run()).rejects.toThrow('That code is not valid or has expired');
    expect(questions).toEqual([]);
    expect(devices.saved).toBeUndefined();
  });

  it('keeps nothing when the office refuses the code at the last moment, and says why', async () => {
    const { pairing, devices, run } = setup();
    pairing.refusePairWith = new Error('That code is not valid or has expired');
    await expect(run()).rejects.toThrow('That code is not valid or has expired');
    expect(devices.saved).toBeUndefined();
  });

  it('shows the person nothing the office wrote that a terminal would act on', async () => {
    const { pairing, questions, devices, run } = setup();
    pairing.whoItPairsWith = { agentName: 'Robo\r\u001b[2KPair with nobody at example.com', workspaceName: 'Ac\u001bme' };
    await run();
    expect(questions[0]).toEqual({ host: 'office.example.com', agentName: 'Robo [2KPair with nobody at example.com', workspaceName: 'Ac me', deviceName: 'Ana\u2019s MacBook' });
    expect(devices.saved?.agentName).toBe('Robo [2KPair with nobody at example.com');
  });

  it('takes the address it asks about from what the person gave, not from what the office says', async () => {
    const { pairing, questions, run } = setup();
    pairing.whoItPairsWith = { agentName: 'Robo of office.example.com', workspaceName: 'at office.example.com' };
    await run({ input: ['https://elsewhere.example.org', 'ABCDEFGH'] });
    expect(questions[0]?.host).toBe('elsewhere.example.org');
  });

  it('has no double quote of the office in what it asks, nor in what it keeps, since one could close the quotes the names are shown in', async () => {
    const { pairing, questions, devices, run } = setup();
    pairing.whoItPairsWith = { agentName: 'Robo" of the workspace "Other', workspaceName: 'Acme", and be called "Nothing' };
    await run();
    expect(questions[0]).toMatchObject({ agentName: "Robo' of the workspace 'Other", workspaceName: "Acme', and be called 'Nothing" });
    expect(devices.saved).toMatchObject({ agentName: "Robo' of the workspace 'Other", workspaceName: "Acme', and be called 'Nothing" });
  });

  it('makes sure the pairing can be kept before it asks the office anything, since the code cannot be used twice', async () => {
    const { calls, run } = setup();
    await run();
    expect(calls).toEqual(['ensureWritable', 'preview', 'pair', 'save']);
  });

  it('stops before the office is asked anything when the pairing could not be kept', async () => {
    const { pairing, devices, questions, calls, run } = setup();
    devices.refuseToBeWritableWith = new Error('EACCES: permission denied, mkdir /state');
    await expect(run()).rejects.toThrow('EACCES: permission denied, mkdir /state');
    expect(calls).toEqual(['ensureWritable']);
    expect(pairing.previews).toEqual([]);
    expect(questions).toEqual([]);
  });

  it('says plainly, when the pairing could not be kept after the code was used, what happened and what to do, and never shows the token', async () => {
    const { devices, run } = setup();
    devices.refuseToSaveWith = new Error('ENOSPC: no space left on device');
    const failure = run();
    await expect(failure).rejects.toThrow(/code was used up.*the office made the machine "Ana\u2019s MacBook".*could not be kept here \(ENOSPC: no space left on device\).*Remove it in My machines.*pair again/);
    await expect(failure).rejects.not.toThrow(new RegExp(pairedDevice.token));
    expect(devices.saved).toBeUndefined();
  });
});

describe('the question', () => {
  const question = { host: 'office.example.com', agentName: 'Robo', workspaceName: 'Acme', deviceName: 'Laptop' };

  it('names the office the person typed first, and then what the office says about itself, as data between quotes', () => {
    expect(describePairQuestion(question)).toBe('Pair this machine with the office at office.example.com? It will work for the AI member "Robo" of the workspace "Acme", and be called "Laptop".');
  });

  it('says the same as a notice when the person already answered', () => {
    expect(describePairNotice(question)).toBe('Pairing this machine with the office at office.example.com. It will work for the AI member "Robo" of the workspace "Acme", and be called "Laptop".');
  });
});
