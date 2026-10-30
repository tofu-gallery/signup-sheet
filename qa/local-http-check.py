#!/usr/bin/env python3
"""HTTP checks against this app's own running servers on this machine. It never starts a server.

    python3 -I qa/local-http-check.py --url http://127.0.0.1:3101 [--url http://127.0.0.1:3102 ...] \\
        --state <file> [--suite all|seat-race,origin,headers,links,organizer-gets,ownership,replay,race] \\
        [--rounds 5 --threads 10] [--log-file <server log> ...]

The servers are `next start` processes of one build on one database, each started by hand with
scripts/preview-server.mjs (see TOFU.md, Local servers). Only loopback http addresses are accepted.
The live check's own flows (`qa/live-check.py <url> --mode fresh`) run against the same servers on a fresh database;
these suites add what a copy on Tofu must not be put through: every POST route probed for the Origin rule, every
organizer page probed with forged cookies, the header rules on exact paths, the race of T01 across several processes.

Suites (each with its own request budget; `all` runs them in this order on a database where setup is still open):

    seat-race       T15  five setup POSTs at once, spread over the servers: one wins, four are refused
    origin          T21  every POST route: foreign Origin, Origin null, none, same-site without Origin → 403 and
                         the Origin sentence; the same path with this copy's Origin is not that refusal
    headers         T32  next.config.ts's headers on /, /s/x, /me, /me/x, /organizer and the dotted routes; the
                         public files; no X-Powered-By
    links           T23  unknown and malformed links answer the same 404
    organizer-gets  T36  every organizer GET with no cookie, a forged seat, another key's password cookie → 303
                         /organizer with nothing in it; the organizer's own request is the control
    ownership       T35  A's cookie on B's note, cancel, move, confirmation pages and calendar file → 404, B
                         unchanged; A's own requests on the same routes are the controls
    replay          T09  one claim form sent four times at once, and again later: one sign-up, one answer; the
                         same request id with other input → 409
    race            T01  --threads claims of a one-place slot at once, alternating over the servers, --rounds
                         times, and six claims of a two-place slot (T02): one (two) confirmed, the rest waiting in
                         order, each claimer's page showing its own place in the queue, no 5xx
    logs            T39  the --log-file captures hold no private link, cookie, database address or password

Each simulated phone sends its own X-Real-IP from 192.0.2.0/24 (a documentation range), so the per-connection member
throttle counts each phone apart, as it would for real phones; no limit is changed. Pace 20 ms (--pace-ms).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# Loaded by path (`python3 -I` puts no script folder on sys.path), with no bytecode left behind in qa/.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('live_check', os.path.join(HERE, 'live-check.py'))
lc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lc)

SUITES = ['seat-race', 'origin', 'headers', 'links', 'organizer-gets', 'ownership', 'replay', 'race', 'logs']
MUST = {'seat-race': ['T15'], 'origin': ['T21'], 'headers': ['T32'], 'links': ['T23'], 'organizer-gets': ['T36'],
        'ownership': ['T35'], 'replay': ['T09'], 'race': ['T01', 'T02'], 'logs': ['T39']}
FOREIGN = 'https://evil-probe.trytofu.app'
# The organizer GETs whose answer to the organizer is a redirect, not a page (test/support/probes.ts says the same).
ORGANIZER_REDIRECTS = {'organizer/sheets', 'organizer/sheets/[slug]/dates'}


class HostPipe:
    """The live check's local bridge (test/db/live-check.test.ts) standing in for one of several addresses."""

    def __init__(self, pipe, host: str):
        self.pipe = pipe
        self.host = host

    def prepare(self, timeout: float):
        return timeout

    def exchange(self, conn, method, path, headers, body):
        return self.send(method, path, headers, body, conn)

    def send(self, method, path, headers, body, timeout):
        return self.pipe.send(method, path, {**headers, 'Host': self.host}, body, timeout)


_PIPE = None


def transport_for(url: str):
    """HTTP to the server at `url`; through the bridge's pipes when the bridge started this script."""
    global _PIPE
    parsed = urllib.parse.urlsplit(url)
    pipe = os.environ.get(lc.PIPE_ENV, '')
    if not pipe:
        return lc.HttpTransport('http', parsed.hostname, parsed.port)
    if _PIPE is None:
        out_fd, in_fd = (int(part) for part in pipe.split(','))
        _PIPE = lc.PipeTransport(out_fd, in_fd, parsed.netloc)
    return HostPipe(_PIPE, parsed.netloc)


class LocalClient(lc.Client):
    """The live check's client with a shared request budget over several servers, and one address per phone."""

    def __init__(self, url: str, budget: dict, pace: float, evidence, redact):
        super().__init__(url, transport_for(url), 10**9, evidence, redact, deadline=900.0, pace=pace)
        self.box = budget

    def room(self, requests: int, cleanup: bool) -> None:
        if self.box['used'] + requests > self.box['limit']:
            raise lc.Stop(f'the suite\'s request budget ({self.box["limit"]}) would be exceeded')
        if self.elapsed() >= self.deadline:
            raise lc.Stop('the 15-minute limit of a local run passed')
        self.box['used'] += requests

    def wait_retry(self, cleanup: bool) -> None:
        # A local server that is starting or reconnecting to a reset database answers again within a second.
        self.sleep(0.5)

    def headers(self, jar, method, origin, content_type):
        headers = super().headers(jar, method, origin, content_type)
        address = getattr(jar, 'address', None)
        if address:
            headers['X-Real-IP'] = address
        site = getattr(jar, 'fetch_site', None)
        if site:
            headers['Sec-Fetch-Site'] = site
        return headers


class Phone(lc.Jar):
    """A browser with its own connection address."""

    count = 0

    def __init__(self, label: str):
        super().__init__(label)
        Phone.count += 1
        self.address = f'192.0.2.{Phone.count % 250 + 1}'


class Local:
    def __init__(self, args, out):
        self.args = args
        self.redact = lc.Redactor()
        self.report = lc.Report(out, self.redact)
        self.urls = args.url
        first = urllib.parse.urlsplit(self.urls[0])
        self.state = lc.State(args.state, f'http://{first.netloc}')
        self.marker = secrets.token_hex(3)
        self.pace = args.pace_ms / 1000
        self.evidence = None
        self.fixture: dict = {}

    def clients(self, budget: int) -> list[LocalClient]:
        box = {'used': 0, 'limit': budget}
        return [LocalClient(url, box, self.pace, self.evidence, self.redact) for url in self.urls]

    def organizer(self) -> Phone:
        phone = Phone('organizer')
        cookie = self.state.data.get('seat', {}).get('cookie')
        if not cookie:
            raise lc.Abort('SEAT', 'no seat in --state: run the seat-race suite first, on a database where setup is open')
        phone.set('ss_org', cookie)
        return phone


def route_inventory() -> list[tuple[str, set[str]]]:
    """Every route under src/app with the methods it exports, read from the source next to this script."""
    root = os.path.join(REPO, 'src', 'app')
    if not os.path.isdir(root):
        raise lc.Abort('ROUTES', 'these suites read the routes from src/app: run this script from the repository')
    found = []
    for folder, _, files in os.walk(root):
        if 'route.ts' not in files:
            continue
        with open(os.path.join(folder, 'route.ts'), encoding='utf-8') as handle:
            methods = set(re.findall(r'export (?:const|async function) (GET|POST)\b', handle.read()))
        relative = os.path.relpath(folder, root).replace(os.sep, '/')
        found.append(('' if relative == '.' else relative, methods))
    return sorted(found)


def address_of(route: str, values: dict[str, str]) -> str:
    return '/' + re.sub(r'\[(\w+)\]', lambda m: values[m.group(1)], route)


def placeholder(route: str) -> dict[str, str]:
    return {name: ('no-such-sheet' if name == 'slug' else '999999999') for name in re.findall(r'\[(\w+)\]', route)}


def health_state(local: Local, client: LocalClient) -> str:
    answer = client.send(None, 'GET', '/health')
    data = answer.json() if answer.status == 200 else None
    return (data or {}).get('organizer', '?')


# --- Suites ------------------------------------------------------------------------------------------------------

def suite_seat_race(local: Local) -> None:
    report = local.report
    clients = local.clients(8)
    if local.state.data.get('seat'):
        raise lc.Abort('T15', 'this state already holds a seat: reset the database (scripts/preview-db.mjs reset) and '
                              'start a new state file')
    state = health_state(local, clients[0])
    if state != 'setup-open':
        raise lc.Abort('T15', f'the seat race needs a database where setup is open, not {state}')
    phones = [Phone(f'setup {n}') for n in range(5)]
    answers = race_across([(clients[n % len(clients)], phone, '/organizer/setup', []) for n, phone in enumerate(phones)])
    winners = [(phone, a) for phone, a in zip(phones, answers) if lc.is_303_to(a, '/organizer') and a.cookie('ss_org')]
    lost = [a for a in answers if a.status == 403 and lc.page_has(a, lc.WORDS['setupLost'])]
    report.check('T15', len(winners) == 1 and len(lost) == 4,
                 f'five setup POSTs at once over {len(clients)} server(s): one 303 with the cookie, four 403 with the '
                 'sentence', f'{[a.status for a in answers]}')
    if len(winners) == 1:
        cookie = winners[0][1].cookie('ss_org').value
        local.redact.secret(cookie)
        local.state.data['seat'] = {'cookie': cookie, 'takenAt': datetime.now(timezone.utc).isoformat(), 'worked': ['T15']}
        local.state.save()
        home = clients[-1].send(local.organizer(), 'GET', '/organizer')
        report.check('T15', home.status == 200 and lc.page_has(home, lc.WORDS['seatBanner']),
                     'the winner\'s cookie opens the dashboard on another server', home.describe())


def race_across(items) -> list:
    """POSTs sent at the same moment, each to its own server, one connection each, never retried."""
    for client, _, _, _ in items:
        client.room(1, False)
    barrier = threading.Barrier(len(items))
    results = [None] * len(items)

    def send(index, client, jar, path, form):
        body = urllib.parse.urlencode(form).encode('utf-8')
        headers = client.headers(jar, 'POST', lc.SAME, 'application/x-www-form-urlencoded')
        try:
            conn = client.transport.prepare(30.0)
            barrier.wait(timeout=30)
            status, answer_headers, data = client.transport.exchange(conn, 'POST', path, headers, body)
            results[index] = lc.Response('POST', path, status, list(answer_headers), data)
        except Exception as error:  # every failure is an answer the suite reports
            barrier.abort()
            results[index] = lc.Response('POST', path, 0, [], b'', error=type(error).__name__)

    threads = [threading.Thread(target=send, args=(i, *item)) for i, item in enumerate(items)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    answers = []
    for (client, jar, path, _), response in zip(items, results):
        response = response or lc.Response('POST', path, 0, [], b'', error='no answer')
        client.used += 1
        client.last_end = client.clock()
        if client.evidence is not None:
            client.evidence.save(jar.label, response)
        client.check_answer(response)
        jar.take(response)
        answers.append(response)
    return answers


def suite_origin(local: Local) -> None:
    report = local.report
    posts = [route for route, methods in route_inventory() if 'POST' in methods]
    client = local.clients(len(posts) * 5 + 2)[0]
    state = health_state(local, client)
    if state == 'setup-open':
        raise lc.Abort('T21', 'run the seat-race suite first: with setup open, the control POST to /organizer/setup '
                              'would take the seat')
    bad = []
    controls = []
    for route in posts:
        path = address_of(route, placeholder(route))
        for label, origin, fetch_site in [('a foreign Origin', FOREIGN, None), ('Origin: null', 'null', None),
                                          ('no Origin', None, None), ('same-site without Origin', None, 'same-site')]:
            phone = Phone(f'origin {route}')
            if fetch_site:
                phone.fetch_site = fetch_site
            answer = client.send(phone, 'POST', path, form=[], origin=origin, keep_cookies=False)
            if not (answer.status == 403 and lc.page_has(answer, lc.WORDS['originRefused'])):
                bad.append(f'{path} with {label}: {answer.describe()}')
        control = client.send(Phone(f'control {route}'), 'POST', path, form=[], keep_cookies=False)
        if control.status == 0 or lc.page_has(control, lc.WORDS['originRefused']):
            controls.append(f'{path}: {control.describe()}')
    report.check('T21', not bad, f'all {len(posts)} POST routes refuse a foreign Origin, Origin null, no Origin and '
                                 'same-site without Origin with 403 and the Origin sentence', '; '.join(bad[:5]))
    report.check('T21', not controls, 'the same paths with this copy\'s Origin are not refused for their Origin '
                                      '(the controls)', '; '.join(controls[:5]))


def suite_headers(local: Local) -> None:
    report = local.report
    client = local.clients(20)[0]
    paths = [('/', False), ('/s/no-such-sheet', False), ('/s/no-such-sheet/slots/999999999', False), ('/me', True),
             (f'/me/{secrets.token_urlsafe(32)}', True), (f'/me/{secrets.token_urlsafe(32)}/calendar.ics', True),
             ('/organizer', True), ('/organizer/people', True), ('/organizer/export.json', True),
             ('/organizer/reminder.ics', True), ('/health', False)]
    problems = []
    for path, private in paths:
        answer = client.send(None, 'GET', path)
        found = lc.header_problems(answer, private)
        if "'unsafe-eval'" in (answer.header('content-security-policy') or ''):
            found.append("'unsafe-eval' in the CSP (a dev server?)")
        if found:
            problems.append(f'{path.split("/me/")[0] or path}: {", ".join(found)}')
    report.check('T32', not problems, f'next.config.ts headers on {len(paths)} paths, including /me and /organizer '
                                      'themselves (private, no-store there) and the dotted routes', '; '.join(problems))
    robots = client.send(None, 'GET', '/robots.txt')
    report.check('T32', robots.status == 200 and 'Disallow: /' in robots.text and 'User-agent: *' in robots.text,
                 '/robots.txt disallows everything', robots.describe())
    for path, kind in [('/app.css', 'text/css'), ('/app.js', 'javascript')]:
        answer = client.send(None, 'GET', path)
        report.check('T32', answer.status == 200 and kind in (answer.header('content-type') or ''),
                     f'{path} is served from this copy ({kind})', answer.describe())


def suite_links(local: Local) -> None:
    report = local.report
    client = local.clients(6)[0]
    answers = [client.send(None, 'GET', path) for path in (f'/me/{secrets.token_urlsafe(32)}', '/me/short',
                                                            f'/me/{secrets.token_urlsafe(33)}',
                                                            f'/me/{secrets.token_urlsafe(31)}~')]
    first = answers[0]
    report.check('T23', all(a.status == 404 and a.body == first.body for a in answers)
                 and lc.page_has(first, lc.WORDS['unknownLink']),
                 'an unknown link and malformed ones answer the same 404 page', ', '.join(str(a.status) for a in answers))


def make_fixture(local: Local, client: LocalClient) -> dict:
    """An open sheet of this run's own, with A and B signed up for its first Snacks, made through the import."""
    if local.fixture:
        return local.fixture
    organizer = local.organizer()
    saturdays = lc.days_ahead(lc.utc_today(), 5, 2)
    document = lc.check_file(local.marker, saturdays, dry_run=False, kind='fresh')
    document['sheets'][0]['slug'] = f'local-{local.marker}'
    document['sheets'][0]['everyDate'] = [{'label': 'Snacks', 'capacity': 2}, {'label': 'Drivers', 'capacity': 2}]
    del document['group']
    answer = client.send(organizer, 'POST', '/organizer/import', body=json.dumps(document).encode(), content_type='application/json')
    data = lc.import_answer(answer)
    if not (answer.status == 200 and data.get('ok')):
        raise lc.Abort('FIXTURE', f'the fixture\'s import answered {answer.describe()} {data.get("error", "")}')
    slug = f'local-{local.marker}'
    sheet = client.send(Phone('reader'), 'GET', f'/s/{slug}')
    dates = lc.read_sheet(sheet.dom())
    snacks = lc.slot_id_of(lc.find_slot(dates, saturdays[0], 'Snacks'), slug)
    drivers = lc.slot_id_of(lc.find_slot(dates, saturdays[0], 'Drivers'), slug)
    people = {}
    for who in ('A', 'B'):
        phone = Phone(who)
        page = client.send(phone, 'GET', f'/s/{slug}/slots/{snacks}')
        form = lc.claim_form(page, slug, snacks, remembered=False)
        if form is None:
            raise lc.Abort('FIXTURE', f'no claim form for {who}: {page.describe()}')
        claimed = client.send(phone, 'POST', form.action, form=form.data(name=f'Local {who} {local.marker}',
                                                                          contact=f'local-{who.lower()}-{local.marker}@example.com',
                                                                          note=f'Note of {who}'), retry=True)
        signup = lc.signup_id_from(claimed)
        token = phone.get('ss_me')
        if not signup or not token:
            raise lc.Abort('FIXTURE', f'{who}\'s claim answered {claimed.describe()}')
        local.redact.secret(token)
        people[who] = {'phone': phone, 'signup': signup, 'token': token}
    admin = client.send(organizer, 'GET', f'/organizer/sheets/{slug}')
    date_ids = re.findall(r'/organizer/dates/([0-9]+)/', admin.text)
    exported = client.send(organizer, 'GET', '/organizer/export.json').json() or {}
    ids = {p.get('name'): str(p.get('id')) for p in exported.get('people', [])}
    local.fixture = {'slug': slug, 'snacks': snacks, 'drivers': drivers, 'date': date_ids[0] if date_ids else None,
                     'people': people, 'person': ids.get(f'Local B {local.marker}'), 'organizer': organizer}
    return local.fixture


def suite_organizer_gets(local: Local) -> None:
    report = local.report
    gets = [route for route, methods in route_inventory() if 'GET' in methods and route.startswith('organizer/')]
    client = local.clients(len(gets) * 4 + 20)[0]
    fixture = make_fixture(local, client)
    values = {'slug': fixture['slug']}
    strangers = [('no cookie', None), ('a forged seat', f'seat.{secrets.token_urlsafe(32)}'),
                 ('a password cookie signed with another key', f'pw.{int(time.time())}.{secrets.token_urlsafe(32)}')]
    bad, controls = [], []
    for route in gets:
        ids = dict(values)
        if '[id]' in route:
            ids['id'] = (fixture['date'] if route.startswith('organizer/dates/') else fixture['snacks']
                         if route.startswith('organizer/slots/') else fixture['people']['B']['signup']
                         if route.startswith('organizer/signups/') else fixture['person'])
        path = address_of(route, ids)
        for label, cookie in strangers:
            phone = Phone('stranger')
            if cookie:
                phone.set('ss_org', cookie)
            answer = client.send(phone, 'GET', path)
            if not (lc.is_303_to(answer, '/organizer') and answer.body == b''):
                bad.append(f'{route} with {label}: {answer.describe()}')
        control = client.send(fixture['organizer'], 'GET', path)
        expected = 303 if route in ORGANIZER_REDIRECTS else 200
        if control.status != expected:
            controls.append(f'{route}: {control.describe()}')
    report.check('T36', not bad, f'all {len(gets)} organizer GET routes send a browser with no cookie, a forged seat or '
                                 'another key\'s password cookie to /organizer, with nothing in the answer',
                 '; '.join(bad[:5]))
    report.check('T36', not controls, 'the organizer\'s own GETs of the same paths answer their pages (the controls)',
                 '; '.join(controls[:5]))


def suite_ownership(local: Local) -> None:
    report = local.report
    client = local.clients(40)[0]
    fixture = make_fixture(local, client)
    a, b = fixture['people']['A'], fixture['people']['B']
    theirs = b['signup']
    probes = [
        ('POST', f'/me/signups/{theirs}/note', [('note', 'Changed by A')]),
        ('POST', f'/me/signups/{theirs}/move', [('to', fixture['drivers'])]),
        ('POST', f'/me/signups/{theirs}/cancel', []),
        ('GET', f'/me/signups/{theirs}/cancel', None),
        ('GET', f'/me/signups/{theirs}/move', None),
    ]
    wrong = []
    for method, path, form in probes:
        answer = client.send(a['phone'], method, path, form=form)
        if not (answer.status == 404 and lc.page_has(answer, lc.WORDS['unknownLink'])):
            wrong.append(f'{method} {path}: {answer.describe()}')
    ics = client.send(Phone('calendar app'), 'GET', f'/me/{a["token"]}/calendar/{theirs}.ics')
    if ics.status != 404:
        wrong.append(f'A\'s calendar address with B\'s sign-up: {ics.describe()}')
    report.check('T35', not wrong, 'A\'s cookie on B\'s note, move, cancel and their confirmation pages, and A\'s '
                                   'calendar address with B\'s sign-up, all answer 404', '; '.join(wrong))
    b_page = client.send(b['phone'], 'GET', '/me')
    entry = next((e for e in lc.read_me(b_page.dom()) if e['id'] == theirs), None)
    report.check('T35', entry is not None and entry['slot'] == 'Snacks' and 'Note of B' in b_page.page_text(),
                 'B\'s sign-up is still B\'s, on Snacks, with B\'s note', b_page.describe())
    mine = a['signup']
    own_ics = client.send(Phone('calendar app'), 'GET', f'/me/{a["token"]}/calendar/{mine}.ics')
    note = client.send(a['phone'], 'POST', f'/me/signups/{mine}/note', form=[('note', 'Changed by A')])
    move_page = client.send(a['phone'], 'GET', f'/me/signups/{mine}/move')
    moved = client.send(a['phone'], 'POST', f'/me/signups/{mine}/move', form=[('to', fixture['drivers'])])
    cancel_page = client.send(a['phone'], 'GET', f'/me/signups/{mine}/cancel')
    cancelled = client.send(a['phone'], 'POST', f'/me/signups/{mine}/cancel', form=[])
    report.check('T35', own_ics.status == 200 and lc.is_303_to(note, '/me?saved=1') and move_page.status == 200
                 and lc.is_303_to(moved, '/me?moved=1') and cancel_page.status == 200 and cancelled.status == 303,
                 'A\'s own calendar file, note, move and cancel through the same routes work (the controls)',
                 ', '.join(x.describe() for x in (own_ics, note, move_page, moved, cancel_page, cancelled)))


def suite_replay(local: Local) -> None:
    report = local.report
    clients = local.clients(16)
    fixture = make_fixture(local, clients[0])
    slug, slot = fixture['slug'], fixture['drivers']
    phone = Phone('replay')
    page = clients[0].send(phone, 'GET', f'/s/{slug}/slots/{slot}')
    form = lc.claim_form(page, slug, slot, remembered=False)
    if form is None:
        raise lc.Abort('T09', f'no claim form: {page.describe()}')
    fields = form.data(name=f'Local replay {local.marker}', contact='')
    copies = [Phone('replay') for _ in range(4)]
    answers = race_across([(clients[n % len(clients)], jar, form.action, fields) for n, jar in enumerate(copies)])
    locations = {a.location for a in answers}
    cookies = {(a.cookie('ss_me') or lc.SetCookie('x=')).value for a in answers}
    report.check('T09', all(a.status == 303 for a in answers) and len(locations) == 1 and len(cookies) == 1
                 and lc.signup_id_from(answers[0]) is not None,
                 'one claim form sent four times at once answers the same Location and cookie every time',
                 f'{[a.status for a in answers]}, {len(locations)} locations, {len(cookies)} cookies')
    local.redact.secret(*cookies)
    later = clients[-1].send(copies[0], 'POST', form.action, form=fields, retry=True)
    report.check('T09', later.status == 303 and later.location in locations,
                 'sent again later with the cookie it set: the same answer', later.describe())
    changed = clients[0].send(Phone('replay changed'), 'POST', form.action,
                              form=form.data(name=f'Local someone else {local.marker}', contact=''))
    report.check('T09', changed.status == 409 and lc.page_has(changed, 'This form was already used. Reload the page and try again.'),
                 'the same request id with other input answers 409', changed.describe())
    exported = clients[0].send(fixture['organizer'], 'GET', '/organizer/export.json').json() or {}
    sheet = lc.export_sheet(exported, slug) or {}
    named = [s for s in sheet.get('signups', []) if s.get('person') in {p.get('key') for p in exported.get('people', [])
                                                                          if 'replay' in str(p.get('name'))}]
    report.check('T09', len(named) == 1, 'the export holds one sign-up for it', f'{len(named)}')


def suite_race(local: Local) -> None:
    report = local.report
    rounds, threads = local.args.rounds, local.args.threads
    clients = local.clients(rounds * (threads * 3 + 2) + 6 * 3 + 12)
    organizer = local.organizer()
    slug = f'race-{local.marker}'
    saturdays = lc.days_ahead(lc.utc_today(), 5, rounds + 1)
    document = {'format': 'signup-sheet/1', 'sheets': [{
        'slug': slug, 'title': f'Race {local.marker}', 'timezone': 'America/Los_Angeles', 'status': 'open',
        'listed': False,
        'dates': [{'date': d.isoformat(), 'start': '09:00', 'slots': [{'label': 'Place', 'capacity': 1 if n < rounds else 2}]}
                  for n, d in enumerate(saturdays)]}]}
    answer = clients[0].send(organizer, 'POST', '/organizer/import', body=json.dumps(document).encode(), content_type='application/json')
    if not (answer.status == 200 and lc.import_answer(answer).get('ok')):
        raise lc.Abort('T01', f'the race sheet\'s import answered {answer.describe()}')
    sheet = clients[0].send(Phone('reader'), 'GET', f'/s/{slug}')
    dates = lc.read_sheet(sheet.dom())
    for n, day in enumerate(saturdays):
        line = 'T01' if n < rounds else 'T02'
        count = threads if n < rounds else 6
        capacity = 1 if n < rounds else 2
        slot = lc.slot_id_of(lc.find_slot(dates, day, 'Place'), slug)
        if slot is None:
            raise lc.Abort(line, f'no claim link for {lc.long_day(day)}')
        phones, items = [], []
        for t in range(count):
            client = clients[t % len(clients)]
            phone = Phone(f'round {n + 1} phone {t + 1}')
            page = client.send(phone, 'GET', f'/s/{slug}/slots/{slot}')
            form = lc.claim_form(page, slug, slot, remembered=False)
            if form is None:
                raise lc.Abort(line, f'no claim form: {page.describe()}')
            phones.append(phone)
            items.append((client, phone, form.action, form.data(name=f'Racer {local.marker} {n + 1}-{t + 1}', contact='')))
        answers = race_across(items)
        signups = [lc.signup_id_from(a) for a in answers]
        errors = [a.describe() for a in answers if a.status >= 500 or a.status == 0]
        positions = {}
        for t, (phone, signup) in enumerate(zip(phones, signups)):
            if signup is None:
                continue
            local.redact.secret(phone.get('ss_me'))
            panel = clients[t % len(clients)].send(phone, 'GET', f'/me?new={signup}')
            text = panel.page_text()
            match = re.search(r'on the waitlist: #([0-9]+)\.', text)
            positions[f'Racer {local.marker} {n + 1}-{t + 1}'] = int(match.group(1)) if match else (0 if "You're in:" in text else None)
        exported = clients[0].send(organizer, 'GET', '/organizer/export.json').json() or {}
        people = lc.export_people(exported)
        queue = lc.slot_signups(lc.export_sheet(exported, slug) or {}, day, 'Place', people)
        confirmed = [name for status, name in queue if status == 'confirmed']
        waiting = [name for status, name in queue if status == 'waiting']
        in_order = all(positions.get(name) == index + 1 for index, name in enumerate(waiting)) and all(
            positions.get(name) == 0 for name in confirmed)
        public = clients[-1].send(Phone('reader'), 'GET', f'/s/{slug}')
        shown = lc.find_slot(lc.read_sheet(public.dom()), day, 'Place') or {}
        expected_count = f'Full \u00b7 {count - capacity} waiting'
        report.check(line, not errors and all(signups) and len(confirmed) == capacity and len(waiting) == count - capacity
                     and in_order and shown.get('count') == expected_count,
                     f'round {n + 1}: {count} claims at once over {len(clients)} server(s) for {capacity} place(s): '
                     f'{capacity} confirmed, {count - capacity} waiting #1–#{count - capacity} in queue order, each '
                     f'claimer\'s page showing its own number, "{expected_count}", no 5xx',
                     f'{len(confirmed)} confirmed, {len(waiting)} waiting, in order {in_order}, count '
                     f'"{shown.get("count")}", errors {errors[:2]}')


def suite_logs(local: Local) -> None:
    report = local.report
    files = local.args.log_file or []
    if not files:
        raise lc.Abort('T39', 'give the captured server logs with --log-file (one or more)')
    seat = local.state.data.get('seat', {}).get('cookie', '')
    patterns = [('a private link', re.compile(r'/me/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])')),
                ('an organizer cookie', re.compile(r'\b(?:seat|pw)\.[A-Za-z0-9._-]{20,}')),
                ('a database address', re.compile(r'postgres(?:ql)?://', re.I)),
                ('a password setting', re.compile(r'ORGANIZER_PASSWORD\s*=', re.I)),
                ('a 43-character token', re.compile(r'(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])'))]
    probes = [value for value in local.state.data.get('probes', {}).get('contacts', []) if value]
    found = []
    lines = 0
    for path in files:
        with open(path, encoding='utf-8', errors='replace') as handle:
            for number, line in enumerate(handle, 1):
                lines += 1
                for label, pattern in patterns:
                    if pattern.search(line):
                        found.append(f'{os.path.basename(path)}:{number} {label}')
                if seat and seat[5:] in line:
                    found.append(f'{os.path.basename(path)}:{number} the seat cookie')
                if any(probe in line for probe in probes):
                    found.append(f'{os.path.basename(path)}:{number} a seeded contact')
    report.check('T39', lines > 0 and not found, f'{lines} log lines from {len(files)} file(s) hold no private link, '
                                                'cookie, database address, password or seeded contact',
                 '; '.join(found[:10]) if found else ('no lines' if lines == 0 else ''))


RUNNERS = {'seat-race': suite_seat_race, 'origin': suite_origin, 'headers': suite_headers, 'links': suite_links,
           'organizer-gets': suite_organizer_gets, 'ownership': suite_ownership, 'replay': suite_replay,
           'race': suite_race, 'logs': suite_logs}


def main(argv=None, out=None) -> int:
    parser = argparse.ArgumentParser(prog='local-http-check.py', description=__doc__.split('\n\n')[0])
    parser.add_argument('--url', action='append', required=True, help='a running server of this copy (repeat for several)')
    parser.add_argument('--state', required=True, help='a private state file for this database (mode 600)')
    parser.add_argument('--suite', default='all', help='all, or a comma-separated list of: ' + ', '.join(SUITES))
    parser.add_argument('--rounds', type=int, default=5)
    parser.add_argument('--threads', type=int, default=10)
    parser.add_argument('--pace-ms', type=int, default=20)
    parser.add_argument('--log-file', action='append')
    args = parser.parse_args(argv)
    out = out or sys.stdout
    local = Local(args, out)
    for url in args.url:
        try:
            scheme, host, _ = lc.base_address(url)
        except ValueError as error:
            local.report.fail('ARGS', str(error))
            local.report.finish([])
            return 1
        if scheme != 'http' or host not in lc.LOOPBACK:
            local.report.fail('ARGS', 'these suites are for servers on this machine only (http://127.0.0.1:<port>)')
            local.report.finish([])
            return 1
    chosen = [s for s in SUITES if s != 'logs'] if args.suite == 'all' else [s.strip() for s in args.suite.split(',')]
    unknown = [s for s in chosen if s not in RUNNERS]
    if unknown or not (1 <= args.threads <= 20) or not (1 <= args.rounds <= 10):
        local.report.fail('ARGS', f'unknown suite(s) {unknown}, or --threads not 1–20, or --rounds not 1–10')
        local.report.finish([])
        return 1
    lock = None
    try:
        local.state.load()
        lock = local.state.lock()
        local.evidence = lc.Evidence(f'{local.state.path}.evidence', 'local', local.redact)
        if local.state.data.get('seat'):
            local.redact.secret(local.state.data['seat'].get('cookie'))
        for url in args.url:
            probe = local.clients(1)[0] if url == args.url[0] else LocalClient(url, {'used': 0, 'limit': 1}, local.pace, None, local.redact)
            answer = probe.send(None, 'GET', '/health', retry=False)
            if answer.status != 200 or (answer.json() or {}).get('app') != 'signup-sheet':
                raise lc.Stop(f'no server of this app answers /health at {url} ({answer.describe()}): start it with '
                              'scripts/preview-server.mjs; this script never does')
        must = []
        for suite in chosen:
            must += MUST[suite]
            try:
                RUNNERS[suite](local)
            except lc.Abort as abort:
                local.report.fail(abort.line, abort.text)
            except lc.Stop as stop:
                local.report.fail('STOP', str(stop))
                if stop.blocked:
                    break
        passed = local.report.finish(must)
        local.evidence.write('result.txt', '\n'.join(local.report.lines) + '\n')
        local.state.save()
    except lc.Stop as stop:
        local.report.fail('STOP', str(stop))
        local.report.finish([])
        passed = False
    finally:
        if lock is not None:
            os.close(lock)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
