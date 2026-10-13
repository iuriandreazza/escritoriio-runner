/** Bumped when a change cannot be read by the other side. A server refuses, with words, a runner that speaks another one. */
export const RUNNER_PROTOCOL_VERSION = 1;

/** Where a runner opens its socket, on the address it was paired with. It only ever dials out. */
export const RUNNER_SOCKET_PATH = '/runner';

/** The two calls that turn a pairing code into a device token. Neither needs a session: the code is the proof. */
export const RUNNER_PAIR_PATHS = { preview: '/api/runner/pairing/preview', pair: '/api/runner/pair' } as const;

/** What answers, with the time of the office in its `Date` header and the oldest runner it accepts, to a runner that wants to know whether the office can be reached, without opening the socket: a second connection of the same device would replace the first. */
export const RUNNER_REACH_PATH = '/api/health';

/** The most a frame of the runner socket may weigh, in either direction. */
export const MAX_RUNNER_MESSAGE_BYTES = 128 * 1024;

/** How often a runner says it is still there; proxies in between close a connection that stays quiet for longer than this. */
export const RUNNER_PING_MS = 25_000;

/** The coding agents a runner may drive. Which of them a machine has is what it says in `hello`. */
export const CODING_AGENT_KINDS = ['claude-code', 'codex', 'kimi-code'] as const;
export type CodingAgentKind = (typeof CODING_AGENT_KINDS)[number];

/** Why a socket was closed, as the code of the close frame, so that a runner knows whether trying again can help. */
export const RUNNER_CLOSE = {
  /** This runner speaks a protocol version the server does not. Updating the runner is the way on. */
  unsupportedProtocol: 4000,
  /** The device was removed in the office: its token is dead, and only pairing again makes another. */
  revoked: 4001,
  /** The device is not allowed for now (its AI member was turned off, or its person has no office with it); that can change. */
  notAllowed: 4002,
  /** A newer connection of the same device took this one's place. */
  replaced: 4003,
} as const;

/** The ceilings on what a runner may put in a message, so that nothing it says is large or long without a reason. */
export const RUNNER_LIMITS = {
  deviceName: 64,
  runnerVersion: 32,
  os: 16,
  agentVersion: 64,
  agents: 8,
  folderLabel: 64,
  folders: 100,
} as const;
