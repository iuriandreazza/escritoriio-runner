import { RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { describe, expect, it } from 'vitest';
import { cleanDeviceName, serverHost } from './paired-device.ts';

describe('the host of a server', () => {
  it.each([
    ['https://office.example.com', 'office.example.com'],
    ['https://office.example.com:8443', 'office.example.com:8443'],
    ['http://localhost:8201', 'localhost:8201'],
  ])('reads %s as %s', (server, host) => {
    expect(serverHost(server)).toBe(host);
  });
});

describe('the name of a device', () => {
  it('is what the person gave, tidied', () => {
    expect(cleanDeviceName('  Ana\u2019s laptop ')).toBe('Ana\u2019s laptop');
    expect(cleanDeviceName('two\nlines')).toBe('two lines');
  });

  it('is cut to what the office takes', () => {
    expect(cleanDeviceName('x'.repeat(200))).toHaveLength(RUNNER_LIMITS.deviceName);
  });

  it('is nothing when there is nothing in it', () => {
    expect(cleanDeviceName('')).toBeUndefined();
    expect(cleanDeviceName(' \u0000\n ')).toBeUndefined();
  });
});
