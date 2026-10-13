export const SMOKE_FLAG = '--smoke';

export type SmokePlan =
  | { readonly kind: 'normal' }
  | { readonly kind: 'smoke'; readonly stateDirectory: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Whether this start is only a check that the app comes up (the release workflow runs the packaged app so). It must never touch the state of whoever runs
 * it, so it is refused unless the state directory is named: there is no fallback to the real one.
 */
export function planSmoke(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): SmokePlan {
  if (!argv.includes(SMOKE_FLAG)) return { kind: 'normal' };
  const stateDirectory = env.ESCRITORIIO_RUNNER_HOME?.trim();
  if (!stateDirectory) return { kind: 'refused', message: 'smoke failed: ESCRITORIIO_RUNNER_HOME must name a scratch state directory for --smoke.' };
  return { kind: 'smoke', stateDirectory };
}
