// The one way the app writes HTML (see TOFU.md, Privacy). Every page is built with the `html` tagged template, which
// escapes every value it is given, by default and in every context:
//
// - Text and quoted attribute values are escaped (& < > " ' as numeric references), so a name, a note or a sheet's
//   words are always plain text, never markup. Nothing is ever turned into a link automatically.
// - Only fragments this module made (the result of another `html`, or of `raw`-free helpers here) pass unescaped, and
//   only where markup may stand: never inside an attribute.
// - An address attribute (href, action, src, formaction) takes only an Href, which is made by checking the address:
//   a path on this copy, or one of the share and calendar targets (share.ts SHARE_TARGETS), or an https page. A plain
//   string there is a bug, and so is a value in an unquoted attribute, an event handler or a style attribute: each
//   throws while the page is built, so a test of the page finds it.
//
// No React renders these pages, and nothing sets raw inner HTML: route handlers answer whole HTML documents.
import { isShareHref } from './share';

/** & < > " ' as numeric character references: safe in text and inside a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const fragments = new WeakSet<object>();
const hrefs = new WeakSet<object>();

/** Markup this module made. Nothing else is ever written unescaped. */
export type Html = { readonly markup: string };
/** An address that was checked (see `path`, `shareHref`, `webHref`). */
export type Href = { readonly href: string };

/** What a template may hold: markup, an address, text, a number, or nothing (null, undefined, false); or a list of them. */
export type Child = Html | Href | string | number | null | undefined | false | readonly Child[];

function fragment(markup: string): Html {
  const made = Object.freeze({ markup });
  fragments.add(made);
  return made;
}

function isFragment(value: unknown): value is Html {
  return typeof value === 'object' && value !== null && fragments.has(value);
}

function isHref(value: unknown): value is Href {
  return typeof value === 'object' && value !== null && hrefs.has(value);
}

function checkedHref(href: string): Href {
  const made = Object.freeze({ href });
  hrefs.add(made);
  return made;
}

// A path on this copy: one slash, then no second slash or backslash, and only characters that need no escaping in a URL.
const LOCAL_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/?=&%#:@!$*+,;]*$/;

/** A path on this copy, such as '/s/snacks' or '/me/<token>/calendar/7.ics'. Anything else is a bug and throws. */
export function path(value: string): Href {
  if (value.length > 2000 || !LOCAL_PATH.test(value)) throw new Error('not a path on this copy');
  return checkedHref(value);
}

/** A WhatsApp, Messages, Mail or Google Calendar address, every part of it already encoded (share.ts). */
export function shareHref(value: string): Href {
  if (!isShareHref(value)) throw new Error('not a share or calendar address');
  return checkedHref(value);
}

/** An https page elsewhere (the footer's "Make one for your group"), or null when the address is anything else. */
export function webHref(value: string): Href | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || /[\s<>"'`\\]/.test(value)) return null;
    return checkedHref(url.href);
  } catch {
    return null;
  }
}

/** A place on the same page ('#main'). */
export function anchor(id: string): Href {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(id)) throw new Error('not an element id');
  return checkedHref(`#${id}`);
}

/** An absolute address on this copy, from the request's checked origin (guard.ts expectedOrigin). */
export function originHref(origin: string, value: string): Href {
  if (!/^https?:\/\/[a-z0-9.:[\]-]+$/.test(origin)) throw new Error('not an origin');
  path(value);
  return checkedHref(`${origin}${value}`);
}

const ADDRESS_ATTRIBUTES = new Set(['href', 'action', 'src', 'formaction']);

type Place = 'text' | 'tag' | 'attribute' | 'address';

/**
 * Where the next value lands, from the markup written so far: in text, inside a tag between attributes, inside a quoted
 * attribute value, or inside an address attribute's value. Values were escaped before they were added, so the only
 * `<`, `>` and `"` in `written` are the template's own.
 */
function placeOf(written: string): Place {
  const open = written.lastIndexOf('<');
  const close = written.lastIndexOf('>');
  if (open <= close) {
    // An attribute begun outside any tag (a template of attributes alone) would not be checked: use `attr` instead.
    if (/[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*"[^"<>]*$/.test(written.slice(close + 1))) throw new Error('a value in an attribute outside its tag');
    return 'text';
  }
  const tag = written.slice(open);
  const quotes = tag.split('"').length - 1;
  if (quotes % 2 === 0) {
    if (/=\s*$/.test(tag)) throw new Error('a value in an unquoted attribute');
    return 'tag';
  }
  const name = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"[^"]*$/.exec(tag)?.[1]?.toLowerCase();
  if (!name || name.startsWith('on') || name === 'style' || name === 'srcdoc') throw new Error(`a value in the attribute ${name ?? '?'}`);
  return ADDRESS_ATTRIBUTES.has(name) ? 'address' : 'attribute';
}

function rendered(value: Child, place: Place): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map((item) => rendered(item, place)).join('');
  switch (place) {
    case 'text':
      if (isFragment(value)) return value.markup;
      if (isHref(value)) return escapeHtml(value.href);
      if (typeof value === 'string' || typeof value === 'number') return escapeHtml(String(value));
      break;
    case 'tag':
      // Between attributes, only markup made here (`flag`, `attributes`) may stand: never text.
      if (isFragment(value)) return value.markup;
      break;
    case 'attribute':
      if (typeof value === 'string' || typeof value === 'number') return escapeHtml(String(value));
      if (isHref(value)) return escapeHtml(value.href);
      break;
    case 'address':
      if (isHref(value)) return escapeHtml(value.href);
      break;
  }
  throw new Error(`a value of the wrong kind for its place in the page (${place})`);
}

/** The tagged template every page uses: `html\`<p>${name}</p>\``. */
export function html(strings: TemplateStringsArray, ...values: Child[]): Html {
  let written = strings[0] ?? '';
  for (let index = 0; index < values.length; index += 1) {
    written += rendered(values[index] as Child, placeOf(written));
    written += strings[index + 1] ?? '';
  }
  return fragment(written);
}

/** Fragments one after another. */
export function join(parts: readonly Child[], separator: Html | null = null): Html {
  const kept = parts.filter((part) => part !== null && part !== undefined && part !== false);
  return html`${kept.flatMap((part, index) => (index > 0 && separator ? [separator, part] : [part]))}`;
}

/**
 * One attribute with its value escaped (` maxlength="80"`), or nothing for null, undefined or false: for the place
 * between attributes. Never an address, an event handler or a style.
 */
export function attr(name: string, value: string | number | null | undefined | false): Html {
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name.startsWith('on') || ADDRESS_ATTRIBUTES.has(name) || name === 'style' || name === 'srcdoc') {
    throw new Error(`the attribute ${name} cannot be written this way`);
  }
  if (value === null || value === undefined || value === false) return fragment('');
  return fragment(` ${name}="${escapeHtml(String(value))}"`);
}

/** A boolean attribute (` checked`, ` required` …) when `on`, for the place between attributes. */
export function flag(name: 'checked' | 'selected' | 'disabled' | 'required' | 'hidden' | 'open' | 'readonly' | 'multiple', on: boolean): Html {
  return fragment(on ? ` ${name}` : '');
}

/** The finished markup, for a response body. */
export function markupOf(page: Html): string {
  return page.markup;
}
