/** Where the credentials of a person live, under their home. They are named one by one: a command or a file tool can reach most of the machine. */
export const CREDENTIAL_PLACES: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.azure',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.config/git/credentials',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.claude.json',
  '.claude/.credentials.json',
  'Library/Keychains',
];

const joinUnder = (home: string, place: string): string => `${home.replace(/[\\/]+$/, '')}/${place}`;

/** The credential places of a home folder, as paths; where the coding agent keeps its settings elsewhere, its login is there too. */
export function credentialPaths(home: string, claudeConfigDirectory: string | undefined): string[] {
  const places = CREDENTIAL_PLACES.map((place) => joinUnder(home, place));
  if (claudeConfigDirectory) places.push(joinUnder(claudeConfigDirectory, '.credentials.json'));
  return places;
}
