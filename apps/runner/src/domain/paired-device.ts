import { RUNNER_LIMITS } from '@escritoriio/runner-protocol';
import { plainText } from './plain-text.ts';

/** A machine that was paired with an AI member of an office: what it needs to connect, and what to tell its person about it. */
export interface PairedDevice {
  /** The origin of the office, as `normalizeServerAddress` writes it. */
  readonly server: string;
  readonly deviceId: string;
  /** What proves the device to the office. Shown to nobody: not by `status`, not in the logs. */
  readonly token: string;
  readonly deviceName: string;
  readonly agentName: string;
  readonly workspaceName: string;
}

/** The host of a server, as a person reads it and as they are asked about it: it comes from the address they gave, never from the office. */
export const serverHost = (server: string): string => new URL(server).host;

/** A device name the office will take: on one line and short enough. Undefined for one with nothing in it. */
export function cleanDeviceName(name: string): string | undefined {
  return plainText(name, RUNNER_LIMITS.deviceName) || undefined;
}
