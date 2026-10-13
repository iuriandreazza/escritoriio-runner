// Decides, from the environment, what electron-builder is allowed to sign with. It exists because electron-builder takes what it finds: on a Mac that is
// whatever identity is in the keychain, and an empty secret of a workflow arrives as an empty variable. A build that was not asked to be signed must not
// be signed by accident with somebody's certificate, and a certificate of one system must not leak into another's build.

const SIGNING_MAC = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME'];
const SIGNING_WINDOWS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
const NOTARIZING = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

const has = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';
const without = (env, names) => Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));

export function signingPlan(env, platform) {
  // A secret that is not set arrives as an empty string: it counts as absent, and is removed so that nobody downstream reads it as set.
  const present = Object.fromEntries(Object.entries(env).filter(([name, value]) => ![...SIGNING_MAC, ...SIGNING_WINDOWS, ...NOTARIZING].includes(name) || (typeof value === 'string' && value.trim() !== '')));
  // Apple Silicon refuses to start code whose signature does not hold, and electron-builder that skips signing leaves Electron's own signature
  // broken by the changes it makes to the app: so an unsigned Mac build is signed ad hoc (identity "-", no certificate, no promise to anybody),
  // which is the least that lets it start. The hardened runtime is left off for it: with it an ad-hoc app needs an entitlement to load its own
  // frameworks (they carry no team to compare), and only a notarized app has to have the runtime.
  const unsigned = (kept, args = []) => ({ signed: false, notarized: false, label: 'unsigned', args, env: { ...without(kept, [...SIGNING_MAC, ...SIGNING_WINDOWS, ...NOTARIZING]), CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });

  if (platform === 'darwin') {
    if (!has(present, 'CSC_LINK') && !has(present, 'CSC_NAME')) return unsigned(present, ['-c.mac.identity=-', '-c.mac.hardenedRuntime=false']);
    const notarized = NOTARIZING.every((name) => has(present, name));
    // Half of the notarization credentials would make electron-builder fail late, after a long build: all of them or none.
    const kept = without(present, [...SIGNING_WINDOWS, ...(notarized ? [] : NOTARIZING)]);
    return { signed: true, notarized, label: notarized ? 'signed and notarized' : 'signed, not notarized', args: [], env: kept };
  }
  if (platform === 'win32') {
    if (!has(present, 'WIN_CSC_LINK')) return unsigned(present);
    // electron-builder falls back to CSC_LINK on Windows when WIN_CSC_LINK is missing; that is the Mac certificate and must never be used here.
    return { signed: true, notarized: false, label: 'signed', args: [], env: without(present, [...SIGNING_MAC, ...NOTARIZING]) };
  }
  // Linux packages are not signed: what vouches for them is the checksum list and the build provenance attestation.
  return unsigned(present);
}
