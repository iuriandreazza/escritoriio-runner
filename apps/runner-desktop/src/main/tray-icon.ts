import { crc32, deflateSync } from 'node:zlib';

export type TrayStatus = 'connected' | 'paused' | 'offline' | 'not-paired' | 'connecting';

// The icons are drawn here, from a colour and a shape, and are not files: nothing is downloaded, and nothing has a licence. They are not the mark of the
// product on purpose: the tray is where the state of the machine is read at a glance, and a one-colour mark of the same shape in every state would say nothing.
const COLOURS: Readonly<Record<TrayStatus, readonly [number, number, number]>> = {
  connected: [46, 160, 67],
  paused: [219, 171, 9],
  offline: [140, 140, 140],
  'not-paired': [140, 140, 140],
  connecting: [47, 129, 247],
};

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** Whether a pixel of the picture is inside what is drawn: a disc, with a ring left empty for a machine that is not paired and a bar for one that is paused. */
function covered(status: TrayStatus, x: number, y: number, size: number): boolean {
  const centre = (size - 1) / 2;
  const radius = size / 2 - 1;
  const distance = Math.hypot(x - centre, y - centre);
  if (distance > radius) return false;
  if (status === 'not-paired') return distance > radius * 0.55;
  if (status === 'paused') return Math.abs(x - centre) > size * 0.12 || Math.abs(y - centre) > size * 0.28;
  return true;
}

/** A PNG of the status for the tray: a coloured disc, drawn pixel by pixel. */
export function statusIconPng(status: TrayStatus, size: number): Buffer {
  const [red, green, blue] = COLOURS[status];
  const rowLength = 1 + size * 4;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * rowLength + 1 + x * 4;
      if (covered(status, x, y, size)) raw.set([red, green, blue, 255], at);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
