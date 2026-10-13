import { privateFile } from '@escritoriio/runner';
import { z } from 'zod';

const FILE_NAME = 'app-settings.json';

const settingsSchema = z.object({
  /** The first-run question about opening at login was put to the owner, whatever they answered. */
  launchAtLoginAsked: z.boolean(),
  launchAtLogin: z.boolean(),
});

export type AppSettings = z.infer<typeof settingsSchema>;

/** Everything off and nothing asked: what a first run starts from, and what a file that cannot be read means. A choice that is lost is asked again, never assumed. */
export const DEFAULT_SETTINGS: AppSettings = { launchAtLoginAsked: false, launchAtLogin: false };

export interface AppSettingsStore {
  load(): Promise<AppSettings>;
  update(change: Partial<AppSettings>): Promise<AppSettings>;
}

/** What the app itself remembers of its owner's choices, in the state directory beside what the runner keeps. Nothing of the runner's policy is here. */
export function createAppSettingsStore(directory: string): AppSettingsStore {
  const file = privateFile(directory, FILE_NAME);

  async function load(): Promise<AppSettings> {
    const text = await file.read();
    if (text === undefined) return DEFAULT_SETTINGS;
    try {
      const settings = settingsSchema.safeParse(JSON.parse(text));
      return settings.success ? settings.data : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  return {
    load,
    async update(change) {
      const next = { ...(await load()), ...change };
      await file.write(`${JSON.stringify(next, null, 2)}\n`);
      return next;
    },
  };
}
