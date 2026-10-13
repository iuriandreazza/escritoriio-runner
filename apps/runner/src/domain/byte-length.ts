const encoder = new TextEncoder();

/** How many bytes a text takes as UTF-8, which is what the limits on what a task says and on a frame are counted in. */
export const byteLength = (text: string): number => encoder.encode(text).length;
