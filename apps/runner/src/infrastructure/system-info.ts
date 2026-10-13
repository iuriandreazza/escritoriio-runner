import { hostname } from 'node:os';
import type { SystemInfo } from '../application/ports.ts';

export function createSystemInfo(): SystemInfo {
  return { os: () => process.platform, deviceName: () => hostname() };
}
