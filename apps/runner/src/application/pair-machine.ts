import { cleanDeviceName, serverHost } from '../domain/paired-device.ts';
import { parsePairInput } from '../domain/pair-input.ts';
import { displayName, plainText } from '../domain/plain-text.ts';
import type { DeviceStore, PairingApi, SystemInfo } from './ports.ts';
import { OwnerError } from './owner-error.ts';

/** What the person is asked about before the code is used up. The names are the office's, cleaned; the host is the one they gave. */
export interface PairQuestion {
  readonly host: string;
  readonly agentName: string;
  readonly workspaceName: string;
  /** What the office will call this machine. */
  readonly deviceName: string;
}

const detailsOf = ({ agentName, workspaceName, deviceName }: PairQuestion): string =>
  `It will work for the AI member "${agentName}" of the workspace "${workspaceName}", and be called "${deviceName}".`;

/** The question, with the address first: it is what the person typed, and the names after it are only what the office says about itself. */
export const describePairQuestion = (question: PairQuestion): string => `Pair this machine with the office at ${question.host}? ${detailsOf(question)}`;

/** The same, said without asking: for when the person already answered with `--yes`. */
export const describePairNotice = (question: PairQuestion): string => `Pairing this machine with the office at ${question.host}. ${detailsOf(question)}`;

export interface PairMachineDeps {
  readonly pairing: PairingApi;
  readonly devices: DeviceStore;
  readonly system: SystemInfo;
  readonly runnerVersion: string;
}

export interface PairMachineRequest {
  /** What the person typed after `pair`: a pairing link, or a server and a code. */
  readonly input: readonly string[];
  /** The name for the device; the machine's own name when there is none. */
  readonly deviceName?: string;
  /** Asks the person whether to go on. Nothing is used up and nothing is kept before it says yes. */
  readonly confirm: (question: PairQuestion) => Promise<boolean>;
}

export type PairOutcome =
  | { readonly paired: false }
  /** What was kept, leaving the token out: it is for the store, and for nobody else. */
  | { readonly paired: true; readonly host: string; readonly agentName: string; readonly workspaceName: string; readonly deviceName: string };

const FALLBACK_DEVICE_NAME = 'My machine';

/**
 * Pairs this machine with the AI member a pairing code was made for. A place to keep the pairing is made sure of first, since the code
 * cannot be used twice and the token the office gives for it is shown once. The person is asked next, with the words the office gave
 * for it (who, of which workspace) next to the address they typed, since a link can be opened by mistake or sent by somebody else: only
 * a yes uses the code up, and only then is anything kept. Throws, with words for the person, when the input is not a pairing, when
 * the pairing could not be kept, or when the office refuses or cannot be reached.
 */
export async function pairMachine(deps: PairMachineDeps, request: PairMachineRequest): Promise<PairOutcome> {
  const input = parsePairInput(request.input);
  if (!input.ok) throw new OwnerError(input.error);
  const { server, code } = input;
  const deviceName = cleanDeviceName(request.deviceName ?? '') ?? cleanDeviceName(deps.system.deviceName()) ?? FALLBACK_DEVICE_NAME;

  await deps.devices.ensureWritable();
  const preview = await deps.pairing.preview(server, code);
  const host = serverHost(server);
  if (!(await request.confirm({ host, agentName: displayName(preview.agentName), workspaceName: displayName(preview.workspaceName), deviceName }))) return { paired: false };

  const pairing = await deps.pairing.pair(server, { code, deviceName, os: deps.system.os(), runnerVersion: deps.runnerVersion });
  const device = {
    server,
    deviceId: pairing.deviceId,
    token: pairing.token,
    deviceName: displayName(pairing.deviceName),
    agentName: displayName(pairing.agentName),
    workspaceName: displayName(pairing.workspaceName),
  };
  try {
    await deps.devices.save(device);
  } catch (error) {
    // The one thing that cannot be undone from here: the code is spent and the office has the machine, but its token was not kept.
    const why = error instanceof Error ? plainText(error.message) : 'unknown error';
    throw new OwnerError(
      `The code was used up and the office made the machine "${device.deviceName}", but it could not be kept here (${why}). Remove it in My machines in the office, fix that, and pair again.`,
      { cause: error },
    );
  }
  return { paired: true, host, agentName: device.agentName, workspaceName: device.workspaceName, deviceName: device.deviceName };
}
