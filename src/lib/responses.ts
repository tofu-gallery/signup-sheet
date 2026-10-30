// Plain answers the routes share: a page with one sentence, a page showing a private link once, a 303 to a path on
// this copy, and the answer for a failure. Both pages use the app's one shell (page.ts); their statuses and cookies are
// the callers'.
import { words } from '../words';
import { ROW_CAPS, RowCapError } from './caps';
import { dbFailure } from './db';
import { type Child, type Href, html, type Html } from './html';
import { logFailure } from './log';
import { htmlResponse, type Nav, PRIVATE } from './page';
import { RequestRefused } from './request';
import { linkBox, linkButton } from './ui';

export { escapeHtml } from './html';
export { PRIVATE } from './page';

export function sentencePage(status: number, sentence: string, headers: Record<string, string> = {}, cookies: string[] = []): Response {
  return htmlResponse(
    status,
    {
      title: status >= 400 ? words.ui.errorTitle(words.appName) : words.appName,
      nav: { kind: 'public' },
      main: html`<div class="sentence"><p role="alert">${sentence}</p><p><a class="go" href="/">${words.appName}</a></p></div>`
    },
    { headers, cookies }
  );
}

/** Where a page that shows a private link once belongs: its title, heading, menu and the way on from it. */
export type LinkPageFrame = {
  /** The document's title: generic, naming nobody (it lands in the browser's history). */
  title: string;
  /** The page's heading (it may name the person: a heading is not kept in the history). */
  heading: string;
  nav: Nav;
  /** The way on once the link is sent: a button, so nobody has to press Back onto the form that made it. */
  next: { href: Href; label: string };
  /** The access-code hint, worded for whoever opens the link (the person themselves by default). */
  hint?: string;
};

/**
 * 200 with a private link shown once (a new link, or the link of a person made for someone else), so the token never
 * sits in an address or the browser's history. `after` adds the page's own ways to send it. The phone's share sheet is
 * never offered for the link itself: it would offer the group chat a parent just came from first. A message that
 * sends it (to themselves, or to the person) is in `after`.
 */
export function linkPage(lines: string[], link: string, cookies: string[], frame: LinkPageFrame, options: { after?: Child; label?: string } = {}): Response {
  // The heading names the link; its box's label says so again only to a screen reader.
  const main: Html = html`<h1>${frame.heading}</h1>
<div class="shown-once">
${lines.map((line, index) => (index === 0 ? html`<p class="done-line">${line}</p>` : html`<p>${line}</p>`))}
${linkBox({ id: 'new-link', label: html`<span class="sr">${options.label ?? words.member.yourLink}</span>`, link, copyLabel: words.me.copyLink, share: false })}
<p class="hint">${frame.hint ?? words.member.accessCode}</p>
${options.after ?? null}
<div class="actions">${linkButton(frame.next.href, frame.next.label, 'secondary')}</div>
</div>`;
  return htmlResponse(200, { title: frame.title, previewTitle: words.me.previewTitle, nav: frame.nav, main }, { cookies });
}

/** 303 to a path on this copy. A relative Location avoids any host confusion behind Tofu's proxy. */
export function seeOther(path: string, setCookies: string[] = []): Response {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('seeOther takes a path on this copy');
  const headers = new Headers({ Location: path, ...PRIVATE });
  for (const cookie of setCookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export type FailureAnswer = { status: number; sentence: string; retryAfter: string | null };

/** Who an answer is for: the organizer is told which row cap was reached and how to make room; anyone else to ask. */
export type Audience = 'organizer' | 'public';

/** An organizer's request (any path under /organizer), else a member's or a visitor's. */
export function audienceOf(request: Request): Audience {
  return new URL(request.url).pathname.startsWith('/organizer/') ? 'organizer' : 'public';
}

/**
 * What an error a route did not handle itself answers: 4xx for a body it refused, 503 busy or unavailable, else 500.
 * Database and other errors are logged here, without their details.
 */
export function failureAnswer(where: string, error: unknown, audience: Audience = 'public'): FailureAnswer {
  if (error instanceof RequestRefused) {
    return { status: error.status, sentence: error.status === 413 ? words.formTooBig : words.formUnreadable, retryAfter: null };
  }
  if (error instanceof RowCapError) {
    const sentence = audience === 'organizer' ? words.rowCapOrganizer(ROW_CAPS[error.table].toLocaleString('en-US'), words.import.capWhat[error.table]) : words.rowCap;
    return { status: 409, sentence, retryAfter: null };
  }
  logFailure(where, error);
  switch (dbFailure(error)) {
    case 'busy':
      return { status: 503, sentence: words.busy, retryAfter: '5' };
    case 'unavailable':
      return { status: 503, sentence: words.waking, retryAfter: '30' };
    default:
      return { status: 500, sentence: words.failed, retryAfter: null };
  }
}

/** failureAnswer as a page. */
export function failureResponse(where: string, error: unknown, audience: Audience = 'public'): Response {
  const failure = failureAnswer(where, error, audience);
  return sentencePage(failure.status, failure.sentence, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {});
}

/** A file to save (an export, a spreadsheet, a calendar file): an attachment with this name, private, never cached. */
export function download(body: string, contentType: string, fileName: string): Response {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(fileName)) throw new Error('a download name outside letters, digits, dots and dashes');
  return new Response(body, {
    headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${fileName}"`, ...PRIVATE }
  });
}
