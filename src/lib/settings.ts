// The two settings every key and access decision comes from. Read once per request and passed on, so the modules that
// use them can be tested without touching process.env.

export type Settings = {
  /** DATABASE_URL, trimmed. Every key the app derives starts from it (tokens.ts). */
  databaseUrl: string;
  /** ORGANIZER_PASSWORD, trimmed; '' when it is not saved. */
  organizerPassword: string;
};

/** MAKE_ONE_URL, the public footer's "Make one for your group" (shown only when it is an https address). */
export function makeOneUrl(env: Record<string, string | undefined> = process.env): string {
  return env.MAKE_ONE_URL?.trim() ?? '';
}

export function readSettings(env: Record<string, string | undefined> = process.env): Settings {
  return {
    databaseUrl: env.DATABASE_URL?.trim() ?? '',
    organizerPassword: env.ORGANIZER_PASSWORD?.trim() ?? ''
  };
}
