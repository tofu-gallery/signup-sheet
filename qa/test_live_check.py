#!/usr/bin/env python3
"""Unit tests for qa/live-check.py, with a fake transport and a fake clock: no network, no server.

    python3 -I qa/test_live_check.py

They check the page reader, the budgets, the deadline, the pace, the retry rules, what stops a run, what is kept out
of output and evidence, the private state and its lock. The whole modes against the real app's route handlers are
test/db/live-check.test.ts (no HTTP either); a run against a server is in docs/verification.md.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# Loaded by path (`python3 -I` puts no script folder on sys.path), with no bytecode left behind in qa/.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('live_check', os.path.join(HERE, 'live-check.py'))
lc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lc)

# Obvious made-up values, never real ones.
TOKEN = 'T' * 43
OTHER_TOKEN = 'U' * 43
SEAT = 'seat.' + 'S' * 43
APP_PAGE = '<!doctype html>\n<html lang="en">\n<head><link rel="stylesheet" href="/app.css"></head><body>{}</body></html>'


def read(path: str) -> str:
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def write(path: str, text: str) -> None:
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(text)


def page(body: str) -> bytes:
    return APP_PAGE.format(body).encode('utf-8')


def html_answer(status: int, body: str, headers=None):
    return status, [('Content-Type', 'text/html; charset=utf-8')] + list(headers or []), page(body)


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeTransport:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []
        self.lock = threading.Lock()

    def send(self, method, path, headers, body, timeout):
        with self.lock:
            self.calls.append((method, path, dict(headers), body))
        answer = self.handler(method, path, headers, body)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def prepare(self, timeout):
        return None

    def exchange(self, conn, method, path, headers, body):
        return self.send(method, path, headers, body, 0)


def client(handler, budget=10, clock=None, evidence=None):
    clock = clock or Clock()
    redact = lc.Redactor()
    made = lc.Client('https://copy.example.test', FakeTransport(handler), budget, evidence, redact, clock=clock, sleep=clock.sleep)
    return made, clock


class RedactionTests(unittest.TestCase):
    def test_links_cookies_and_long_runs_are_replaced(self):
        redact = lc.Redactor()
        text = f'/me/{TOKEN} and {SEAT} and pw.123.{"P" * 43} and https%3A%2F%2Fx%2Fme%2F{TOKEN}'
        shown = redact(text)
        self.assertNotIn(TOKEN, shown)
        self.assertNotIn('S' * 43, shown)
        self.assertNotIn('P' * 43, shown)
        self.assertIn('seat.[redacted]', shown)

    def test_secrets_in_every_form_and_people_by_whole_word(self):
        redact = lc.Redactor()
        redact.secret('hunter-two-password')
        redact.person("Frank's family", 'frank@example.com', 'Frank')
        shown = redact("pw hunter-two-password hunter-two-password%20 Frank&#39;s family frank%40example.com Frankly Frank.")
        self.assertNotIn('hunter-two-password', shown)
        self.assertNotIn('Frank&#39;s family', shown)
        self.assertNotIn('frank%40example.com', shown)
        self.assertIn('Frankly', shown, 'a short name is replaced only as a whole word')
        self.assertIn('[person].', shown)

    def test_app_escape_matches_the_app(self):
        self.assertEqual(lc.app_escape('<a href="x">\'&'), '&#60;a href=&#34;x&#34;&#62;&#39;&#38;')


class CookieTests(unittest.TestCase):
    def test_attributes_and_removal(self):
        cookie = lc.SetCookie('__Host-ss_org=seat.abc; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure')
        self.assertEqual((cookie.name, cookie.value, cookie.max_age), ('__Host-ss_org', 'seat.abc', 604800))
        self.assertIn('httponly', cookie.attrs)
        jar = lc.Jar('a')
        jar.take(lc.Response('GET', '/', 200, [('Set-Cookie', 'ss_me=abc; Path=/; Max-Age=10')], b''))
        self.assertEqual(jar.header(), 'ss_me=abc')
        jar.take(lc.Response('GET', '/', 200, [('Set-Cookie', 'ss_me=; Path=/; Max-Age=0')], b''))
        self.assertIsNone(jar.header())

    def test_cookie_rules_differ_by_scheme(self):
        made, _ = client(lambda *a: (200, [], b''))
        ok, problems = lc.cookie_attributes_ok(made, lc.SetCookie('ss_org=seat.x; Path=/; HttpOnly; SameSite=Lax'))
        self.assertFalse(ok)
        self.assertIn('__Host-', problems)
        self.assertIn('Secure', problems)
        ok, _ = lc.cookie_attributes_ok(made, lc.SetCookie('__Host-ss_org=seat.x; Path=/; Max-Age=5; HttpOnly; SameSite=Lax; Secure'))
        self.assertTrue(ok)
        ok, problems = lc.cookie_attributes_ok(made, lc.SetCookie('__Host-ss_org=x; Path=/; Domain=trytofu.app; HttpOnly; SameSite=Lax; Secure'))
        self.assertFalse(ok)
        self.assertIn('Domain', problems)


SHEET = '''
<p class="group">Tigers</p><h1>Snack sign-up</h1>
<section class="date"><h2 class="when"><span class="cal" aria-hidden="true"><span class="mon">Nov</span><span class="num">7</span></span>
<span class="what"><span class="day">Saturday, November 7</span><span class="times">9:00 AM–10:30 AM</span></span></h2>
<ul class="slots">
<li class="slot"><div class="slot-main"><span class="slot-name">Snacks</span><span class="count">1 of 1 taken</span></div>
<ul class="people"><li>Mike&#39;s family <span class="note">Oranges &#38; water</span></li></ul></li>
<li class="slot"><div class="slot-main"><span class="slot-name">Drivers</span><span class="count">2 places left</span></div>
<a class="button primary take" href="/s/snacks/slots/12">Take it</a></li>
</ul></section>
<details class="earlier"><summary>Earlier dates (1)</summary><section class="date"><h2 class="when"><span class="what"><span class="day">Saturday, October 31</span></span></h2></section></details>
'''


class ReaderTests(unittest.TestCase):
    def test_sheet_dates_slots_people_and_links(self):
        dates = lc.read_sheet(lc.parse_html(page(SHEET).decode()))
        self.assertEqual([d['day'] for d in dates], ['Saturday, November 7', 'Saturday, October 31'])
        self.assertTrue(dates[1]['earlier'])
        snacks, drivers = dates[0]['slots']
        self.assertEqual(snacks['people'], [{'name': "Mike's family", 'note': 'Oranges & water'}])
        self.assertEqual(snacks['count'], '1 of 1 taken')
        self.assertEqual(snacks['href'], '')
        self.assertEqual(lc.slot_id_of(drivers, 'snacks'), '12')
        self.assertEqual(lc.find_slot(dates, date(2026, 11, 7), 'Drivers'), drivers)
        self.assertIsNone(lc.find_slot(dates, date(2026, 10, 31), 'Snacks'), 'earlier dates are not a place to claim')

    def test_forms_as_a_browser_sends_them(self):
        root = lc.parse_html(page('''
<form method="post" action="/s/snacks/slots/12/claim" class="stack"><input type="hidden" name="rid" value="r-1">
<input id="n" name="name" type="text" value="">
<textarea name="note" rows="2">Bring &#38; share</textarea>
<input type="checkbox" name="paid" value="1"><input type="checkbox" name="listed" value="1" checked>
<select name="day"><option value="mon">Monday</option><option value="thu" selected>Thursday</option></select>
<input id="hp" name="ss_hp" type="text" value="" tabindex="-1"><button type="submit" class="primary">Sign up</button></form>
<form method="post" action="/forget" class="inline"><input type="hidden" name="to" value="/s/a?x=1&#38;y=2"></form>''').decode())
        claim = lc.forms(root, action='/s/snacks/slots/12/claim')[0]
        self.assertEqual(claim.value('note'), 'Bring & share')
        self.assertIsNone(claim.value('paid'))
        self.assertEqual(claim.value('listed'), '1')
        self.assertEqual(claim.value('day'), 'thu')
        self.assertIn('ss_hp', claim.names)
        self.assertEqual(claim.data(name='Frank', paid='1'), [('rid', 'r-1'), ('name', 'Frank'), ('note', 'Bring & share'),
                                                             ('listed', '1'), ('day', 'thu'), ('ss_hp', ''), ('paid', '1')])
        self.assertEqual(lc.forms(root, action='/forget')[0].value('to'), '/s/a?x=1&y=2')
        self.assertEqual([f.action for f in lc.forms(root, action_pattern=r'/s/[a-z]+/slots/[0-9]+/claim')], ['/s/snacks/slots/12/claim'])

    def test_me_and_roster(self):
        me = lc.read_me(lc.parse_html(page(f'''<ul class="rows"><li id="s41"><h3 class="when"><span class="what">
<span class="day">Saturday, November 7</span><span class="tag ok">Confirmed</span></span></h3>
<p class="person-line"><span class="name">Snacks</span><span class="meta">Snack sign-up</span></p>
<p class="meta">Moved up from the waitlist on Sat, Nov 7</p>
<div class="actions"><a class="button secondary" href="/me/{TOKEN}/calendar/41.ics">Add to my calendar</a></div></li></ul>''').decode()))
        self.assertEqual(me[0]['id'], '41')
        self.assertEqual(me[0]['status'], 'Confirmed')
        self.assertEqual(me[0]['meta'], ['Moved up from the waitlist on Sat, Nov 7'])
        self.assertEqual(me[0]['ics'], [f'/me/{TOKEN}/calendar/41.ics'])
        roster = lc.read_roster(lc.parse_html(page('''<ul class="rows"><li><p class="person-line">
<a class="name" href="/organizer/people/7">Frank</a><span class="tag ok">Paid, $40.00</span></p></li></ul>''').decode()))
        self.assertEqual(roster, [{'id': '7', 'name': 'Frank', 'tags': ['Paid, $40.00']}])

    def test_contains_any_sees_escaped_and_encoded_forms(self):
        answer = lc.Response('GET', '/', 200, [], page('<a href="sms:?&#38;body=frank%40example.com">x</a>'))
        self.assertEqual(lc.contains_any(answer, ['frank@example.com', 'mike@example.com']), ['frank@example.com'])
        self.assertTrue(lc.looks_like_contact('frank@example.com'))
        self.assertTrue(lc.looks_like_contact('(555) 123-4567'))
        self.assertFalse(lc.looks_like_contact('Mike'))


class ClientTests(unittest.TestCase):
    def test_budget_stops_before_the_request_that_would_exceed_it(self):
        made, _ = client(lambda *a: (200, [], b'{}'), budget=2)
        made.send(None, 'GET', '/health')
        made.send(None, 'GET', '/health')
        with self.assertRaises(lc.Stop):
            made.send(None, 'GET', '/health')
        self.assertEqual(made.used, 2)
        self.assertEqual(len(made.transport.calls), 2)

    def test_reserve_is_kept_for_cleanup_only(self):
        made, _ = client(lambda *a: (200, [], b'{}'), budget=3)
        made.reserve = 2
        made.send(None, 'GET', '/health')
        with self.assertRaises(lc.Stop):
            made.send(None, 'GET', '/health')
        made.send(None, 'GET', '/health', cleanup=True)
        made.send(None, 'GET', '/health', cleanup=True)
        with self.assertRaises(lc.Stop):
            made.send(None, 'GET', '/health', cleanup=True)

    def test_deadline_and_pace(self):
        clock = Clock()
        made, _ = client(lambda *a: (200, [], b''), budget=10, clock=clock)
        made.send(None, 'GET', '/a')
        made.send(None, 'GET', '/b')
        self.assertEqual(clock.sleeps, [lc.PACE_SECONDS], 'requests go 400 ms apart')
        clock.now += lc.DEADLINE_SECONDS
        with self.assertRaises(lc.Stop) as stopped:
            made.send(None, 'GET', '/c')
        self.assertIn('deadline', str(stopped.exception))

    def test_get_retries_three_times_five_seconds_apart(self):
        answers = iter([(503, [], b''), (502, [], b''), OSError('reset'), (200, [], b'ok')])
        made, clock = client(lambda *a: next(answers), budget=10)
        response = made.send(None, 'GET', '/s/x')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.attempts, 4)
        self.assertEqual(clock.sleeps.count(lc.RETRY_WAIT_SECONDS), 3)
        self.assertEqual(made.used, 4, 'every attempt counts against the budget')

    def test_get_gives_up_after_three_retries(self):
        made, _ = client(lambda *a: (504, [], b''), budget=10)
        self.assertEqual(made.send(None, 'GET', '/').status, 504)
        self.assertEqual(made.used, 4)

    def test_other_posts_are_never_sent_twice(self):
        made, _ = client(lambda *a: (503, [], b''), budget=10)
        self.assertEqual(made.send(None, 'POST', '/me/profile', form=[('name', 'x')]).status, 503)
        self.assertEqual(made.used, 1)
        broken, _ = client(lambda *a: OSError('reset'), budget=10)
        lost = broken.send(None, 'POST', '/organizer/setup', form=[])
        self.assertEqual((lost.status, lost.error, broken.used), (0, 'OSError', 1))

    def test_a_claim_sent_again_with_its_request_id_may_retry(self):
        answers = iter([(503, [], b''), (303, [('Location', '/me?new=1')], b'')])
        made, _ = client(lambda *a: next(answers), budget=10)
        self.assertEqual(made.send(None, 'POST', '/s/x/slots/1/claim', form=[('rid', 'r')], retry=True).status, 303)

    def test_posts_carry_this_copys_origin_and_the_browser_marker(self):
        made, _ = client(lambda *a: (303, [('Location', '/')], b''))
        jar = lc.Jar('a')
        jar.set('__Host-ss_me', 'abc')
        made.send(jar, 'POST', '/forget', form=[('to', '/')])
        made.send(jar, 'POST', '/forget', form=[], origin='https://evil.example.test')
        made.send(jar, 'POST', '/forget', form=[], origin=None)
        made.send(jar, 'GET', '/')
        sent = [call[2] for call in made.transport.calls]
        self.assertEqual(sent[0]['Origin'], 'https://copy.example.test')
        self.assertEqual(sent[0]['Content-Type'], 'application/x-www-form-urlencoded')
        self.assertEqual(sent[0]['Cookie'], '__Host-ss_me=abc')
        self.assertTrue(sent[0]['User-Agent'].endswith('tofu-gallery-live-check'))
        self.assertEqual(sent[1]['Origin'], 'https://evil.example.test')
        self.assertNotIn('Origin', sent[2])
        self.assertNotIn('Origin', sent[3])

    def test_only_paths_on_this_copy(self):
        made, _ = client(lambda *a: (200, [], b''))
        for path in ('https://other.example.test/', '//other.example.test/x', 'relative'):
            with self.assertRaises(lc.Stop):
                made.send(None, 'GET', path)
        self.assertEqual(made.transport.calls, [])

    def test_a_platform_checkpoint_stops_the_run_at_once(self):
        for answer in [(403, [('Content-Type', 'text/html')], b'<html><title>Vercel Security Checkpoint</title></html>'),
                       (429, [], b'Too Many Requests'),
                       (200, [('x-vercel-mitigated', 'challenge')], b'')]:
            made, _ = client(lambda *a, answer=answer: answer)
            with self.assertRaises(lc.Stop) as stopped:
                made.send(None, 'GET', '/')
            self.assertTrue(stopped.exception.blocked)
            self.assertIn('wait 10 minutes', str(stopped.exception))
            self.assertEqual(made.used, 1, 'and is never retried')

    def test_the_apps_own_refusals_do_not_stop_it(self):
        made, _ = client(lambda *a: html_answer(403, f'<p role="alert">{lc.WORDS["originRefused"]}</p>'))
        refused = made.send(None, 'POST', '/forget', form=[])
        self.assertEqual(refused.status, 403)
        self.assertEqual(refused.alert(), lc.WORDS['originRefused'])
        json_refusal, _ = client(lambda *a: (401, [('Content-Type', 'application/json')], b'{"error":"Sign in as the organizer first."}'))
        self.assertEqual(json_refusal.send(None, 'POST', '/organizer/import', body=b'{}').status, 401)

    def test_an_access_code_page_or_another_host_stops_it(self):
        for location in ('/_tofu/access?next=%2F', 'https://elsewhere.example.test/'):
            made, _ = client(lambda *a, location=location: (303, [('Location', location)], b''))
            with self.assertRaises(lc.Stop) as stopped:
                made.send(None, 'GET', '/me/x')
            self.assertTrue(stopped.exception.blocked)
        same, _ = client(lambda *a: (303, [('Location', 'https://copy.example.test/me?new=4')], b''))
        answer = same.send(None, 'GET', '/x')
        self.assertEqual((answer.status, answer.location), (303, '/me?new=4'), 'an absolute Location on this copy reads as its path')
        self.assertEqual(same.locations, ['https://copy.example.test/me?new=4'])

    def test_the_race_sends_all_at_once_and_never_retries(self):
        started = threading.Barrier(4, timeout=5)

        def handler(method, path, headers, body):
            started.wait()
            return (503, [], b'') if path.endswith('/4') else (303, [('Location', '/me?new=1'), ('Set-Cookie', 'ss_me=x; Path=/')], b'')

        made, _ = client(handler, budget=10)
        jars = [lc.Jar(str(i)) for i in range(4)]
        answers = made.race([(jar, f'/claim/{i + 1}', [('rid', str(i))]) for i, jar in enumerate(jars)])
        self.assertEqual([a.status for a in answers], [303, 303, 303, 503])
        self.assertEqual(made.used, 4)
        self.assertEqual(jars[0].get('ss_me'), 'x')

    def test_the_race_respects_the_budget(self):
        made, _ = client(lambda *a: (303, [], b''), budget=3)
        with self.assertRaises(lc.Stop):
            made.race([(lc.Jar(str(i)), '/claim', []) for i in range(4)])
        self.assertEqual(made.transport.calls, [])


class ReportTests(unittest.TestCase):
    def test_a_must_run_line_that_did_not_run_is_a_fail(self):
        out = io.StringIO()
        report = lc.Report(out, lc.Redactor())
        report.ok('M01', 'fine')
        self.assertFalse(report.finish(['M01', 'M02']))
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], 'ok   M01 fine')
        self.assertTrue(lines[1].startswith('FAIL M02 did not run'))
        self.assertEqual(lines[-1], 'RESULT FAIL')

    def test_one_failed_check_fails_its_line_and_output_is_redacted(self):
        out = io.StringIO()
        report = lc.Report(out, lc.Redactor())
        report.check('M11', True, 'first')
        report.check('M11', False, f'second /me/{TOKEN}', 'detail')
        self.assertFalse(report.results['M11'])
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertTrue(report.finish(['M11']) is False)

    def test_a_clean_run_passes(self):
        out = io.StringIO()
        report = lc.Report(out, lc.Redactor())
        report.ok('R01', 'x')
        report.info('note')
        self.assertTrue(report.finish(['R01']))
        self.assertEqual(out.getvalue().splitlines()[-1], 'RESULT PASS')


class StateTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='ss-lc-test-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_saved_private_and_for_one_copy(self):
        path = os.path.join(self.dir, 'copy', 'state.json')
        state = lc.State(path, 'https://a.example.test')
        state.load()
        state.data['seat'] = {'cookie': SEAT}
        state.save()
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        other = lc.State(path, 'https://b.example.test')
        with self.assertRaises(lc.Stop):
            other.load()
        os.chmod(path, 0o644)
        with self.assertRaises(lc.Stop):
            lc.State(path, 'https://a.example.test').load()

    def test_never_inside_a_git_checkout(self):
        os.makedirs(os.path.join(self.dir, 'repo', '.git'))
        with self.assertRaises(lc.Stop):
            lc.State(os.path.join(self.dir, 'repo', 'qa', 'state.json'), 'https://a.example.test').load()

    def test_one_run_at_a_time_per_copy(self):
        state = lc.State(os.path.join(self.dir, 'state.json'), 'https://a.example.test')
        state.load()
        held = state.lock()
        try:
            with self.assertRaises(lc.Stop):
                lc.State(os.path.join(self.dir, 'state.json'), 'https://a.example.test').lock()
        finally:
            os.close(held)
        os.close(state.lock())

    def test_evidence_keeps_no_cookie_value_or_link(self):
        redact = lc.Redactor()
        evidence = lc.Evidence(os.path.join(self.dir, 'state.json.evidence'), 'fresh', redact)
        ics = ('BEGIN:VCALENDAR\r\nDESCRIPTION:Change or cancel: https://copy.example.test/me/' + TOKEN[:30] +
               '\r\n ' + TOKEN[30:] + '\r\nEND:VCALENDAR\r\n')
        evidence.save('B', lc.Response('GET', f'/me/{TOKEN}/calendar/4.ics', 200,
                                       [('Content-Type', 'text/calendar'), ('Set-Cookie', f'ss_me={TOKEN}; Path=/')], ics.encode()))
        names = os.listdir(evidence.dir)
        self.assertEqual(len(names), 1)
        self.assertNotIn(TOKEN, names[0])
        text = read(os.path.join(evidence.dir, names[0]))
        self.assertNotIn(TOKEN, text)
        self.assertNotIn(TOKEN[:30], text, 'a token folded across two calendar lines is still found')
        self.assertIn('ss_me=[value]', text)
        self.assertEqual(stat.S_IMODE(os.stat(evidence.dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(evidence.dir, names[0])).st_mode), 0o600)


class FixtureTests(unittest.TestCase):
    def test_dates_are_saturdays_at_least_two_days_ahead(self):
        for day in range(1, 15):
            today = date(2026, 11, day)
            saturdays = lc.days_ahead(today, 5, 2)
            self.assertTrue(all(s.weekday() == 5 for s in saturdays))
            self.assertGreaterEqual((saturdays[0] - today).days, 2)
            self.assertEqual((saturdays[1] - saturdays[0]).days, 7)
        self.assertEqual(lc.long_day(date(2026, 11, 7)), 'Saturday, November 7')

    def test_delivery_never_sends_group_and_keeps_its_sheet_off_the_home_page(self):
        delivery = lc.check_file('abc123', [date(2026, 11, 7)], dry_run=True, kind='delivery')
        self.assertNotIn('group', delivery)
        self.assertEqual(delivery['sheets'][0]['slug'], 'zz-check-abc123')
        self.assertIs(delivery['sheets'][0]['listed'], False)
        fresh = lc.check_file('abc123', [date(2026, 11, 7)], dry_run=False, kind='fresh')
        self.assertEqual(fresh['group']['dues']['amountCents'], 4000)
        self.assertIs(fresh['dryRun'], False)

    def test_own_names_only(self):
        pattern = lc.own_name('abc123')
        for name in ('QA Mike abc123', 'QA Mike abc123 edited', 'QA Frank abc123', 'QA Frank abc123 4'):
            self.assertTrue(pattern.match(name), name)
        for name in ('QA Frank abc1234', 'Frank', 'QA Mike abc123 5', 'xQA Mike abc123', 'QA Mike ABC123'):
            self.assertFalse(pattern.match(name), name)

    def test_strict_json_refuses_a_key_written_twice(self):
        with self.assertRaises(ValueError):
            lc.strict_json('{"format": "signup-sheet/1", "format": "x"}')
        self.assertEqual(lc.strict_json('{"a": {"b": 1}}'), {'a': {'b': 1}})

    def test_the_budgets_are_the_contracts(self):
        self.assertEqual({k: lc.BUDGETS[k] for k in ('fresh', 'delivery', 'password', 'read')},
                         {'fresh': 55, 'delivery': 60, 'password': 12, 'read': 8})
        self.assertEqual(lc.DEADLINE_SECONDS, 170)
        self.assertEqual(lc.PACE_SECONDS, 0.4)


class WordsTests(unittest.TestCase):
    """The sentences the check looks for are the app's own (src/words.ts), so a change to one fails here first."""

    def test_each_sentence_is_in_words_ts(self):
        path = os.path.join(REPO, 'src', 'words.ts')
        if not os.path.exists(path):
            self.skipTest('src/words.ts is not next to this copy of the check')
        source = read(path).replace("\\'", "'")
        for key, sentence in lc.WORDS.items():
            pieces = [piece for piece in re.split(r'\{[a-z]+\}', sentence) if piece.strip()]
            for piece in pieces:
                self.assertIn(piece, source, f'{key}: "{piece}" is not in src/words.ts')
        for column in lc.CSV_HEADER:
            self.assertIn(f"'{column}'", source)


def scripted(routes):
    """A fake copy answering fixed paths (and 404 otherwise), for whole modes without a server."""
    def handler(method, path, headers, body):
        key = f'{method} {path}'
        for pattern, answer in routes:
            if re.fullmatch(pattern, key):
                return answer(headers, body) if callable(answer) else answer
        return html_answer(404, f'<p role="alert">{lc.WORDS["unknownLink"]}</p>')
    return handler


SAFE_HEADERS = [('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"), ('X-Frame-Options', 'DENY'),
                ('Referrer-Policy', 'same-origin'), ('X-Robots-Tag', 'noindex, nofollow'), ('X-Content-Type-Options', 'nosniff')]


class ModeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='ss-lc-test-')
        self.state = os.path.join(self.dir, 'state.json')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_main(self, args, handler, env=None):
        out = io.StringIO()
        clock = Clock()
        code = lc.main(args + ['--state', self.state], transport=FakeTransport(handler), out=out, env=env or {},
                       clock=clock, sleep=clock.sleep, today=date(2026, 10, 29))
        return code, out.getvalue()

    def read_copy(self, sheet_status=200, canonical=True):
        sheet = SHEET.replace('<p class="group">', '<p class="group">')
        head = '<link rel="canonical" href="https://copy.example.test/s/snacks">' if canonical else ''
        return scripted([
            (r'GET /health', (200, [('Content-Type', 'application/json')], b'{"app":"signup-sheet","organizer":"password","openSheets":1}')),
            (r'GET /', (200, [('Content-Type', 'text/html')] + SAFE_HEADERS, APP_PAGE.format(head + SHEET).encode())),
            (r'GET /s/snacks', (sheet_status, [('Content-Type', 'text/html')] + SAFE_HEADERS, page(SHEET))),
            (r'GET /organizer', html_answer(200, f'<h1>{lc.WORDS["signInHeading"]}</h1>')),
            (r'GET /me', html_answer(200, f'<p>{lc.WORDS["noCookie"]}</p>')),
        ])

    def test_read_mode_passes_on_a_healthy_copy_within_its_budget(self):
        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], self.read_copy())
        self.assertEqual(code, 0, out)
        self.assertTrue(out.rstrip().endswith('RESULT PASS'))
        self.assertIn('info 6 of 8 requests', out)

    def test_read_mode_fails_when_a_page_shows_a_private_link(self):
        leaky = SHEET.replace('Take it', f'Take it <a href="/me/{TOKEN}">x</a>')
        copy = scripted([
            (r'GET /health', (200, [], b'{"app":"signup-sheet","organizer":"password","openSheets":1}')),
            (r'GET /', (200, SAFE_HEADERS, APP_PAGE.format('<link rel="canonical" href="https://copy.example.test/s/snacks">').encode())),
            (r'GET /s/snacks', (200, SAFE_HEADERS, page(leaky))),
            (r'GET /organizer', html_answer(200, '<h1>Organizer sign-in</h1>')),
            (r'GET /me', html_answer(200, f'<p>{lc.WORDS["noCookie"]}</p>')),
        ])
        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], copy)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL R05 ')
        self.assertNotIn(TOKEN, out)

    def test_read_mode_says_which_contacts_r05_looked_for_and_never_claims_more(self):
        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], self.read_copy())
        self.assertEqual(code, 0, out)
        self.assertRegex(out, r'(?m)^info R05 known contacts: not exercised')
        self.assertRegex(out, r'(?m)^ok   R05 the public pages carry no private link and no paid state or dues$')

        saved = lc.State(self.state, 'https://copy.example.test')
        saved.load()
        saved.data['probes'] = {'contacts': ['qa-a-probe@example.com'], 'words': ['PAIDPROBEx']}
        saved.save()
        leaky = SHEET.replace('Take it', 'Take it qa-a-probe@example.com')
        copy = scripted([
            (r'GET /health', (200, [], b'{"app":"signup-sheet","organizer":"password","openSheets":1}')),
            (r'GET /', (200, SAFE_HEADERS, APP_PAGE.format('<link rel="canonical" href="https://copy.example.test/s/snacks">').encode())),
            (r'GET /s/snacks', (200, SAFE_HEADERS, page(leaky))),
            (r'GET /organizer', html_answer(200, '<h1>Organizer sign-in</h1>')),
            (r'GET /me', html_answer(200, f'<p>{lc.WORDS["noCookie"]}</p>')),
        ])
        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], copy)
        self.assertEqual(code, 1)
        self.assertRegex(out, r"(?m)^info R05 looks for 2 contacts and words .*cannot know the organizer's real contacts")
        self.assertRegex(out, r'(?m)^FAIL R05 the public pages carry no private link, none of those contacts or words')
        self.assertNotIn('qa-a-probe@example.com', out)

    def test_read_mode_without_a_sheet_to_read_fails_rather_than_skips(self):
        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], self.read_copy(canonical=False))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL R03 .*--sheet')
        self.assertRegex(out, r'(?m)^FAIL R04 did not run')

    def test_a_checkpoint_mid_run_stops_every_later_request(self):
        handler = self.read_copy()
        calls = []

        def blocked(method, path, headers, body):
            calls.append(path)
            if path == '/s/snacks':
                return 403, [('Content-Type', 'text/html')], b'<html>Vercel Security Checkpoint</html>'
            return handler(method, path, headers, body)

        code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], blocked)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL STOP .*wait 10 minutes')
        self.assertEqual(calls, ['/health', '/', '/s/snacks'])

    def test_seat_mode_saves_the_cookie_privately_and_never_prints_it(self):
        copy = scripted([
            (r'GET /health', (200, [], b'{"app":"signup-sheet","organizer":"setup-open","openSheets":0}')),
            (r'POST /organizer/setup', (303, [('Location', '/organizer'), ('Set-Cookie', f'__Host-ss_org={SEAT}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure')], b'')),
            (r'GET /organizer', lambda headers, body: html_answer(200 if SEAT in headers.get('Cookie', '') else 303, f'<p>{lc.WORDS["seatBanner"]}Nov 5</p>')),
        ])
        code, out = self.run_main(['https://copy.example.test', '--mode', 'seat'], copy)
        self.assertEqual(code, 0, out)
        self.assertNotIn('S' * 43, out)
        self.assertEqual(json.loads(read(self.state))['seat']['cookie'], SEAT)
        self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode), 0o600)
        again_code, again = self.run_main(['https://copy.example.test', '--mode', 'seat'], copy)
        self.assertEqual(again_code, 1, 'one copy, one seat')

    def test_a_lost_setup_answer_while_the_seat_became_held_is_a_fail_to_make_a_new_copy(self):
        health = iter([b'{"app":"signup-sheet","organizer":"setup-open"}', b'{"app":"signup-sheet","organizer":"held"}'])
        copy = scripted([
            (r'GET /health', lambda headers, body: (200, [], next(health))),
            (r'POST /organizer/setup', (502, [('Content-Type', 'text/html')], b'Bad gateway')),
        ])
        code, out = self.run_main(['https://copy.example.test', '--mode', 'seat'], copy)
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL S02 .*make a new one')

    def test_import_refuses_a_file_with_a_duplicate_key_before_sending_anything(self):
        lc_state = lc.State(self.state, 'https://copy.example.test')
        lc_state.load()
        lc_state.data['seat'] = {'cookie': SEAT}
        lc_state.save()
        file = os.path.join(self.dir, 'draft.json')
        write(file, '{"format": "signup-sheet/1", "sheets": [], "sheets": []}')
        calls = []
        code, out = self.run_main(['https://copy.example.test', '--mode', 'import', '--file', file],
                                  lambda *a: calls.append(a) or (200, [], b''))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL I02 .*written twice')
        self.assertEqual(calls, [])

    def test_an_answer_the_check_cannot_read_is_a_fail_with_a_result(self):
        def unreadable(run):
            run.get(None, '/health')
            raise AttributeError(f"'list' object has no attribute 'get' near /me/{TOKEN}")

        real = lc.MODES['read']
        lc.MODES['read'] = unreadable
        try:
            code, out = self.run_main(['https://copy.example.test', '--mode', 'read'], self.read_copy())
        finally:
            lc.MODES['read'] = real
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL CHECK the check could not read an answer \(AttributeError')
        self.assertNotIn(TOKEN, out)
        self.assertTrue(out.rstrip().endswith('RESULT FAIL'))

    def test_a_password_file_others_can_read_is_refused(self):
        lc_state = lc.State(self.state, 'https://copy.example.test')
        lc_state.load()
        lc_state.data['seat'] = {'cookie': SEAT}
        lc_state.save()
        file = os.path.join(self.dir, 'qa-pw')
        write(file, 'a-local-test-value-only\n')
        os.chmod(file, 0o644)
        calls = []
        code, out = self.run_main(['https://copy.example.test', '--mode', 'password', '--qa-pw-file', file],
                                  lambda *a: calls.append(a) or (200, [], b''))
        self.assertEqual(code, 1)
        self.assertRegex(out, r'(?m)^FAIL P05 .*chmod 600')
        self.assertEqual(calls, [])
        self.assertNotIn('a-local-test-value-only', out)

    def test_addresses(self):
        for address, ok in [('https://copy.example.test', True), ('http://127.0.0.1:3101', True),
                            ('http://copy.example.test', False), ('https://copy.example.test/s/x', False),
                            ('https://user@copy.example.test', False), ('ftp://copy.example.test', False)]:
            if ok:
                lc.base_address(address)
            else:
                with self.assertRaises(ValueError):
                    lc.base_address(address)

    def test_the_bridge_pipe_is_refused_for_a_real_address(self):
        out = io.StringIO()
        code = lc.main(['https://copy.example.test', '--mode', 'read', '--state', self.state], out=out,
                       env={lc.PIPE_ENV: '3,4'})
        self.assertEqual(code, 1)
        self.assertIn('only for the local bridge', out.getvalue())


class CommandLineTests(unittest.TestCase):
    def test_it_runs_isolated_with_the_standard_library_only(self):
        result = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'live-check.py'), '--help'],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--mode', result.stdout)
        source = read(os.path.join(HERE, 'live-check.py'))
        imported = set(re.findall(r'(?m)^(?:import|from) ([a-z0-9_.]+)', source))
        allowed = {'__future__', 'argparse', 'base64', 'csv', 'fcntl', 'html.parser', 'http.client', 'io', 'json', 'os',
                   're', 'secrets', 'socket', 'ssl', 'sys', 'threading', 'time', 'urllib.parse', 'uuid', 'datetime'}
        self.assertLessEqual(imported, allowed, f'non-standard imports: {imported - allowed}')


if __name__ == '__main__':
    unittest.main(verbosity=1)
