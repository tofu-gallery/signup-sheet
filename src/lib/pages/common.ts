// What several pages share: absolute links built from the request's checked origin, the public footer, reading a
// page's `?e=` code, and what importing the export back restores.
import { words } from '../../words';
import { html, type Html, path, webHref } from '../html';
import { FILE_LIMITS } from '../import-format';
import type { Notice } from '../page';
import { IMPORT_LIMIT_BYTES } from '../request';
import { makeOneUrl } from '../settings';
import { errorSentence } from '../ui';

/** This copy's origin (guard.ts expectedOrigin), or '' when the request's host could not be used: links stay relative. */
export type Origin = string;

/** A sheet's public address, for share texts and calendar files. */
export function sheetLink(origin: Origin, slug: string): string {
  return `${origin}/s/${slug}`;
}

/** A person's private link (shown only to them, or once to the organizer who made it). */
export function privateLink(origin: Origin, token: string): string {
  return `${origin}/me/${token}`;
}

/** The public footer: the organizer's name (never their contact), the lost-link lines, the organizer sign-in. */
export function publicFooter(organizerName: string): Html {
  const s = words.sheet;
  const makeOne = webHref(makeOneUrl());
  return html`${organizerName ? html`<p>${s.organizedBy(organizerName)}</p>` : null}
<p>${s.lostLink}</p>
<p>${words.member.landedHere}</p>
<p><a href="${path('/organizer')}">${s.organizerSignIn}</a></p>
${makeOne ? html`<p><a href="${makeOne}">${s.makeOne}</a></p>` : null}`;
}

/** The error notice for the page's `?e=` code (and `n`), or null. `names`: a field this page calls by another name. */
export function codeNotice(query: URLSearchParams, maxima: Record<string, number> = {}, names: Record<string, string> = {}): Notice | null {
  const sentence = errorSentence(query.get('e'), query.get('n'), { maxima, names });
  return sentence ? { kind: 'error', body: sentence } : null;
}

/**
 * The notice for a note refused on a sheet that names its note ("What you'll bring"): it says that name, as the field
 * beside it does (the claim form's own sentence), else codeNotice's.
 */
export function noteNotice(query: URLSearchParams, noteLabel: string): Notice | null {
  if (query.get('e') === 'note' && noteLabel) return { kind: 'error', body: words.formErrors.noteLabelled(noteLabel) };
  return codeNotice(query, {}, noteLabel ? { note: noteLabel } : {});
}

/** Beside the export: what importing it into a new copy restores, and the import's limits a bigger copy passes. */
export function exportRestoreHint(): string {
  return words.org.exportRestore(IMPORT_LIMIT_BYTES / 1024, FILE_LIMITS.people, FILE_LIMITS.sheets, FILE_LIMITS.datesPerSheet, FILE_LIMITS.signups);
}

/** A status notice when the query has `flag`. */
export function flagNotice(query: URLSearchParams, flag: string, sentence: string): Notice | null {
  return query.has(flag) ? { kind: 'done', body: sentence } : null;
}
