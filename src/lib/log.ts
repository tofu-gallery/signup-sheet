// The only way the app writes to its log (see TOFU.md, Logs). A line names a fixed place and, for a database error, its
// SQLSTATE and constraint; for another error its class and code; for a bad database setting its fixed sentence. Never
// an error's message (PostgreSQL's can quote the values that failed), a URL (a private link carries its token), a name,
// a contact, a token or an error object.
import pg from 'pg';
import { DatabaseConfigError } from '../../scripts/tofu-database.mjs';

/** `where` must be a fixed phrase written in the code, never anything a request sent. */
export function logFailure(where: string, error: unknown): void {
  console.error(`[signup-sheet] ${where}: ${describe(error)}`);
}

function describe(error: unknown): string {
  if (error instanceof pg.DatabaseError) {
    return `database error ${error.code ?? 'without a code'}${error.constraint ? ` on ${error.constraint}` : ''}`;
  }
  // Its message is one of a few fixed sentences.
  if (error instanceof DatabaseConfigError) return error.message;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `${error.name} ${code}` : error.name;
  }
  return 'unknown failure';
}
