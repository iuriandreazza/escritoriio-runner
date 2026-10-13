import { createHash } from 'node:crypto';

/** The hash that the definition of a tool is approved by. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
