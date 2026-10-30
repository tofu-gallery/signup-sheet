// The one HTML renderer (html.ts): every value is escaped for where it lands, addresses must be checked ones, and a value
// in a place no value may go (an event handler, a style, an unquoted attribute) stops the page from being built.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, escapeHtml, flag, html, markupOf, originHref, path, shareHref, webHref } from '../../src/lib/html';
import { documentHtml } from '../../src/lib/page';
import { errorSentence, linkBox, shareBox } from '../../src/lib/ui';
import { words } from '../../src/words';

const NASTY = `<script>alert("x")</script> & 'quoted' "double"`;

test('text and quoted attribute values are escaped; nothing typed is ever markup', () => {
  const page = markupOf(html`<p title="${NASTY}">${NASTY}</p>`);
  assert.ok(!page.includes('<script>'), page);
  assert.ok(!page.includes('"double"'), 'no raw double quote from a value');
  assert.equal(page, `<p title="${escapeHtml(NASTY)}">${escapeHtml(NASTY)}</p>`);
  // A value cannot close its attribute and open an event handler.
  const input = markupOf(html`<input value="${'" onfocus="alert(1)'}">`);
  assert.equal(input, '<input value="&#34; onfocus=&#34;alert(1)">');
  // Numbers, nothing, lists and fragments.
  assert.equal(markupOf(html`<p>${3}${null}${undefined}${false}${['a', html`<b>${'<i>'}</b>`]}</p>`), '<p>3a<b>&#60;i&#62;</b></p>');
});

test('an object that only looks like a fragment or an address is refused, never written as it is', () => {
  const forged = { markup: '<script>alert(1)</script>' } as unknown as Parameters<typeof html>[1];
  assert.throws(() => html`<p>${forged}</p>`);
  const forgedHref = { href: 'javascript:alert(1)' } as unknown as Parameters<typeof html>[1];
  assert.throws(() => html`<a href="${forgedHref}">x</a>`);
});

test('an address attribute takes only a checked address', () => {
  assert.throws(() => html`<a href="${'javascript:alert(1)'}">x</a>`, /wrong kind/);
  assert.throws(() => html`<a href="${'/s/snacks'}">x</a>`, /wrong kind/, 'even a harmless path must come through path()');
  assert.throws(() => html`<form action="${'https://evil.example'}"></form>`, /wrong kind/);
  assert.equal(markupOf(html`<a href="${path('/s/snacks?e=gone')}">x</a>`), '<a href="/s/snacks?e=gone">x</a>');
  for (const bad of ['//evil.example', '/\\evil.example', 'javascript:alert(1)', 'https://evil.example', '/s/"onmouseover', '/s/<x>', '/s/ x']) {
    assert.throws(() => path(bad), bad);
  }
  assert.throws(() => shareHref('javascript:alert(1)'));
  assert.throws(() => shareHref('https://wa.me/?text=a b'), 'a share address must be encoded');
  assert.equal(shareHref('sms:?&body=Hi%20there').href, 'sms:?&body=Hi%20there');
  assert.equal(webHref('javascript:alert(1)'), null);
  assert.equal(webHref('http://example.com/'), null);
  assert.equal(webHref('https://user:pw@example.com/'), null);
  assert.equal(webHref('https://example.com/make')?.href, 'https://example.com/make');
  assert.throws(() => originHref('https://example.com"><x', '/s/a'));
  assert.equal(originHref('http://127.0.0.1:3000', '/s/a').href, 'http://127.0.0.1:3000/s/a');
});

test('no value goes into an event handler, a style, an unquoted attribute, or between attributes as text', () => {
  assert.throws(() => html`<a onclick="${'alert(1)'}">x</a>`);
  assert.throws(() => html`<p style="${'color:red'}">x</p>`);
  assert.throws(() => html`<input value=${'x'}>`);
  assert.throws(() => html`<input ${'autofocus onfocus=alert(1)'}>`);
  assert.throws(() => html`<p title="${html`<b>x</b>`}">x</p>`, 'markup inside an attribute');
  assert.throws(() => attr('onclick', 'x'));
  assert.throws(() => attr('href', '/x'));
  assert.throws(() => attr('style', 'x'));
  assert.equal(markupOf(html`<input${attr('maxlength', 80)}${attr('pattern', '"x"')}${flag('required', true)}${attr('min', null)}>`), '<input maxlength="80" pattern="&#34;x&#34;" required>');
});

test('the shell escapes the title and keeps private titles generic; share and link boxes escape what they show', () => {
  const page = documentHtml({ title: NASTY, previewTitle: NASTY, nav: { kind: 'public' }, main: html`<p>x</p>` });
  assert.ok(!page.includes('<script>alert'), 'the title is text');
  assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(page, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(page, /<script src="\/app\.js" defer><\/script>/);

  const text = { subject: NASTY, text: `${NASTY}</textarea><script>alert(2)</script>` };
  const box = markupOf(shareBox({ id: 'box', label: 'Label', text, links: { whatsapp: `https://wa.me/?text=${encodeURIComponent(text.text)}`, sms: null, email: null } }));
  assert.ok(!box.includes('<script>'), box);
  assert.ok(!box.includes('</textarea><script>'), 'the message cannot close its box');
  assert.ok(box.includes('https://wa.me/?text=%3Cscript%3E'), 'the link is encoded, never raw markup');
  const link = markupOf(linkBox({ id: 'l', label: 'Your private link', link: 'http://127.0.0.1:3000/me/abc"><script>' }));
  assert.ok(!link.includes('"><script>'), link);
});

test('an error code becomes one of the app\'s sentences, or nothing: a made-up code is never shown', () => {
  assert.equal(errorSentence('name-required'), `${words.fields.name}: ${words.text.required}`);
  assert.equal(errorSentence('contact-card'), `${words.fields.contact}: ${words.text.card}`);
  assert.equal(errorSentence('dateTaken'), words.formErrors.dateTaken);
  assert.equal(errorSentence('capacity', '3'), words.formErrors.capacity(3));
  assert.equal(errorSentence('<script>'), null);
  assert.equal(errorSentence('somethingElse'), null);
  assert.equal(errorSentence('nosuchfield-required'), null);
  assert.equal(errorSentence('label-too_long', null, { names: { label: 'Label' }, maxima: { label: 80 } }), 'Label: That\'s too long: keep it to 80 characters.');
});
