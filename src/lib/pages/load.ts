// Pages read from the database and answered (see TOFU.md, Pages). A route's GET calls these after its own checks (an
// organizer route after organizerGet or organizerPost, so the organizer check is always the first query), and a POST
// calls the same ones to show its form again with what was typed and why it was refused. Each reads only what its
// audience may see (views.ts): the public pages never read a contact, a paid state or a link.
import type pg from 'pg';
import { words } from '../../words';
import { type Organizer, requireOrganizer } from '../access';
import { readCookie, type Scheme } from '../cookies';
import { originHref } from '../html';
import { memberAuth } from '../identity';
import { htmlResponse } from '../page';
import { seeOther, sentencePage } from '../responses';
import { readSettings } from '../settings';
import { newRequestId } from '../tokens';
import {
  groupView,
  myPlacesOnSheet,
  organizerDate,
  organizerSlot,
  organizerView,
  publicSheetView,
  rosterChoices,
  rosterView
} from '../views';
import { type SettingsValues, settingsShell, settingsValuesOf } from './group';
import { type PersonValues, rosterShell } from './people';
import { claimShell, type ClaimValues, sheetShell } from './public';
import {
  addDateShell,
  type AddValues,
  addSlotShell,
  addSomeoneShell,
  type DateValues,
  dateValuesOf,
  editDateShell,
  editSheetShell,
  editSlotShell,
  type SheetValues,
  sheetValuesOf,
  type SlotValues
} from './sheet-admin';

type Context = { pool: pg.Pool; headers: Headers; scheme: Scheme; origin: string; query: URLSearchParams; now: Date };

function missing(cookies: readonly string[] = []): Response {
  return sentencePage(404, words.notFound, {}, [...cookies]);
}

// --- Public ---------------------------------------------------------------------------------------------------------

/**
 * A sheet's public page (`/s/<slug>`, or `/` when it is the one open sheet, with its own address as canonical). A draft
 * is shown only to the organizer, and only after the organizer check; to anyone else it does not exist (null).
 */
export async function sheetResponse(context: Context, slug: string, options: { inPlace: boolean }): Promise<Response | null> {
  let sheet = await publicSheetView(context.pool, slug, { draft: false });
  let preview = false;
  if (!sheet) {
    const signedIn = await requireOrganizer(context.pool, context.headers, readSettings());
    if (signedIn) {
      sheet = await publicSheetView(context.pool, slug, { draft: true });
      preview = sheet !== null;
    }
  }
  if (!sheet) return null;
  const auth = await memberAuth(context.pool, readCookie(context.headers, 'ss_me', context.scheme));
  const remembered = auth ? await myPlacesOnSheet(context.pool, auth.personId, slug) : null;
  const canonical = options.inPlace && context.origin ? originHref(context.origin, `/s/${slug}`) : null;
  return htmlResponse(200, sheetShell({ sheet, remembered, preview, query: context.query, now: context.now, canonical }));
}

export type ClaimForm = {
  slug: string;
  slotId: string;
  /** Which of the page's forms was sent and is shown again, or null for a fresh page. */
  sent: 'me' | 'new' | null;
  /** The sent form's request id, kept when it can be used again (never used yet); null for a new one. */
  rid: string | null;
  values: ClaimValues;
  code: string | null;
};

/** The claim form, fresh (GET) or shown again after a refusal (the claim POST, 400). */
export async function claimResponse(context: Omit<Context, 'origin' | 'query'>, form: ClaimForm, status: number, cookies: readonly string[] = []): Promise<Response> {
  const sheet = await publicSheetView(context.pool, form.slug, { draft: false });
  if (!sheet) return missing(cookies);
  const date = sheet.dates.find((each) => each.slots.some((slot) => slot.id === form.slotId));
  const slot = date?.slots.find((each) => each.id === form.slotId);
  if (!date || !slot) return seeOther(`/s/${form.slug}?e=gone`, [...cookies]);
  const auth = await memberAuth(context.pool, readCookie(context.headers, 'ss_me', context.scheme));
  const person = auth ? await myPlacesOnSheet(context.pool, auth.personId, form.slug) : null;
  const rids = {
    me: form.sent === 'me' && form.rid ? form.rid : newRequestId(),
    new: form.sent === 'new' && form.rid ? form.rid : newRequestId()
  };
  const shell = claimShell({
    sheet,
    date,
    slot,
    remembered: person ? { name: person.name, here: person.places.some((place) => place.slotId === slot.id) } : null,
    sent: form.sent,
    rids,
    values: form.values,
    code: form.code,
    now: context.now
  });
  return htmlResponse(status, shell, { cookies });
}

// --- The organizer's forms ------------------------------------------------------------------------------------------

export async function editSheetResponse(pool: pg.Pool, organizer: Organizer, slug: string, form: { values: SheetValues | null; code: string | null }, status = 200): Promise<Response> {
  const sheet = await organizerView(pool, slug);
  if (!sheet) return missing();
  return htmlResponse(status, editSheetShell(organizer, sheet, form.values ?? sheetValuesOf(sheet), form.code));
}

export async function addDateResponse(pool: pg.Pool, organizer: Organizer, slug: string, form: { values: DateValues; code: string | null }, status = 200): Promise<Response> {
  const sheet = await organizerView(pool, slug);
  if (!sheet) return missing();
  return htmlResponse(status, addDateShell(organizer, sheet, form.values, form.code));
}

export async function editDateResponse(pool: pg.Pool, organizer: Organizer, dateId: string, form: { values: DateValues | null; code: string | null }, status = 200): Promise<Response> {
  const date = await organizerDate(pool, dateId);
  if (!date) return missing();
  return htmlResponse(status, editDateShell(organizer, date, form.values ?? dateValuesOf(date), form.code));
}

export async function addSlotResponse(pool: pg.Pool, organizer: Organizer, dateId: string, form: { values: SlotValues; code: string | null }, status = 200): Promise<Response> {
  const date = await organizerDate(pool, dateId);
  if (!date) return missing();
  return htmlResponse(status, addSlotShell(organizer, date, form.values, form.code));
}

export async function editSlotResponse(
  pool: pg.Pool,
  organizer: Organizer,
  slotId: string,
  form: { values: SlotValues | null; code: string | null; n: string | null },
  status = 200
): Promise<Response> {
  const slot = await organizerSlot(pool, slotId);
  if (!slot) return missing();
  const values = form.values ?? { label: slot.slotLabel, capacity: String(slot.capacity), description: slot.slotDescription };
  return htmlResponse(status, editSlotShell(organizer, slot, values, form.code, form.n));
}

export async function addSomeoneResponse(
  pool: pg.Pool,
  organizer: Organizer,
  slotId: string,
  form: { rid: string | null; values: AddValues; code: string | null },
  status = 200
): Promise<Response> {
  const slot = await organizerSlot(pool, slotId);
  if (!slot) return missing();
  const roster = await rosterChoices(pool);
  return htmlResponse(status, addSomeoneShell(organizer, slot, roster, form.rid ?? newRequestId(), form.values, form.code));
}

export async function settingsResponse(pool: pg.Pool, organizer: Organizer, form: { values: SettingsValues | null; code: string | null; saved: boolean }, status = 200): Promise<Response> {
  const values = form.values ?? settingsValuesOf(await groupView(pool));
  return htmlResponse(status, settingsShell(organizer, values, form.code, form.saved));
}

export async function rosterResponse(pool: pg.Pool, organizer: Organizer, query: URLSearchParams, form: { values: PersonValues; code: string | null }, status = 200): Promise<Response> {
  const people = await rosterView(pool);
  const group = await groupView(pool);
  return htmlResponse(status, rosterShell(organizer, people, group, query, form.values, form.code));
}
