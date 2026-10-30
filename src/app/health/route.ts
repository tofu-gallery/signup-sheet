// GET /health: the organizer state and how many listed sheets are open, and nothing else. Like any request, it retires
// the setup seat once ORGANIZER_PASSWORD is saved.
import { organizerAccess } from '../../lib/access';
import { appPool, dbFailure } from '../../lib/db';
import { logFailure } from '../../lib/log';
import { readSettings } from '../../lib/settings';
import { words } from '../../words';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

export async function GET(): Promise<Response> {
  try {
    const pool = appPool();
    const access = await organizerAccess(pool, readSettings());
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from sheets where status = 'open' and listed"
    );
    return Response.json({ app: 'signup-sheet', organizer: access.state, openSheets: rows[0]?.n ?? 0 }, { headers });
  } catch (error) {
    logFailure('health', error);
    const down = dbFailure(error) !== 'error';
    return Response.json(
      { app: 'signup-sheet', error: down ? words.waking : words.failed },
      { status: down ? 503 : 500, headers }
    );
  }
}
