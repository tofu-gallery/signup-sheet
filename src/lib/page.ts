// The one page shell every HTML answer uses (see TOFU.md, Pages): the document head, the navigation for its audience,
// the notices (an error is announced with role="alert"), the page itself and its footer. One CSS file and one small
// script, both on this copy; no fonts or anything else from another site. Private pages (a person's own, the
// organizer's) get generic titles that name nobody. Every answer is private and never cached.
import { words } from '../words';
import { anchor, type Child, type Href, html, type Html, markupOf, path } from './html';

export const PRIVATE = { 'Cache-Control': 'private, no-store' } as const;

export type Nav =
  | { kind: 'public' }
  | { kind: 'member' }
  /** `via`: a seat holder gets no Sign out (signing out would lose the seat; Give up setup ends it on purpose). */
  | { kind: 'organizer'; via: 'seat' | 'password' }
  | { kind: 'none' };

/**
 * A notice at the top of a page: `body` is the sentence a screen reader announces (an alert or a status line); `after`
 * is shown in the same box but outside that live region (lists of people to tell, with their messages), so pressing
 * Copy there never has the whole list read out again.
 */
export type Notice = { kind: 'error' | 'done' | 'info'; body: Child; after?: Child };

export type Shell = {
  /** The document's title. Private pages use their generic one. */
  title: string;
  /** The title a link preview shows (og:title): for a person's own pages, the generic private-link title. */
  previewTitle?: string;
  canonical?: Href | null;
  nav: Nav;
  notices?: readonly (Notice | null | false)[];
  main: Html;
  footer?: Html | null;
};

function navigation(nav: Nav): Html | null {
  const n = words.nav;
  switch (nav.kind) {
    case 'none':
      return null;
    case 'public':
    case 'member':
      return html`<nav class="top" aria-label="${n.label}"><a class="home" href="${path('/')}">${words.appName}</a><a href="${path('/me')}">${n.mySignups}</a></nav>`;
    case 'organizer':
      return html`<nav class="top organizer" aria-label="${n.label}">
<a class="home" href="${path('/organizer')}">${n.organizer}</a>
<a href="${path('/organizer/people')}">${n.people}</a>
<a href="${path('/organizer/settings')}">${n.settings}</a>
<a href="${path('/organizer/import')}">${n.importExport}</a>
${nav.via === 'password' ? html`<form method="post" action="${path('/organizer/sign-out')}" class="inline"><button type="submit" class="link">${n.signOut}</button></form>` : null}
</nav>`;
  }
}

/** One notice: an error is an alert (read out at once), anything else a status line. */
export function noticeHtml(notice: Notice): Html {
  const role = notice.kind === 'error' ? 'alert' : 'status';
  if (notice.after === undefined) return html`<div class="notice ${notice.kind}" role="${role}">${notice.body}</div>`;
  return html`<div class="notice ${notice.kind}"><div role="${role}">${notice.body}</div>${notice.after}</div>`;
}

/** The whole document. A page that refuses something says so in its title too ("Error: …"). */
export function documentHtml(shell: Shell): string {
  const notices = (shell.notices ?? []).filter((notice): notice is Notice => Boolean(notice));
  const title = notices.some((notice) => notice.kind === 'error') ? words.ui.errorTitle(shell.title) : shell.title;
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<meta name="format-detection" content="telephone=no">
<title>${title}</title>
<meta property="og:title" content="${shell.previewTitle ?? shell.title}">
${shell.canonical ? html`<link rel="canonical" href="${shell.canonical}">` : null}
<link rel="stylesheet" href="${path('/app.css')}">
<script src="${path('/app.js')}" defer></script>
</head>
<body>
<a class="skip" href="${anchor('main')}">${words.nav.skip}</a>
${navigation(shell.nav)}
<main id="main">
${notices.length > 0 ? html`<div class="notices">${notices.map(noticeHtml)}</div>` : null}
${shell.main}
</main>
${shell.footer ? html`<footer class="foot">${shell.footer}</footer>` : null}
</body>
</html>
`;
  return markupOf(page);
}

/** An HTML answer: private, never cached, with any cookies the request set. */
export function htmlResponse(
  status: number,
  shell: Shell,
  options: { headers?: Record<string, string>; cookies?: readonly string[] } = {}
): Response {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE, ...options.headers });
  for (const cookie of options.cookies ?? []) headers.append('Set-Cookie', cookie);
  return new Response(documentHtml(shell), { status, headers });
}
