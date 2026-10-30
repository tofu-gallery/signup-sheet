#!/usr/bin/env python3
"""The sign-up sheet's live check: plain HTTP against one copy of the app, Python 3 standard library only.

    python3 -I qa/live-check.py <address> --mode <mode> --state <file> [options]

Modes (TOFU.md, "The live check", says when each one runs):

    fresh     a QA copy nobody has set up: the whole core, from setup to a rotated link.   55 requests at most
    delivery  an organizer's copy while the agent holds the seat, on a throwaway unlisted
              sheet it deletes again, with its own people; the organizer's data stays.    60 requests at most
    password  after ORGANIZER_PASSWORD (QA_PW) is saved and the copy redeployed.          12 requests at most
    read      GET only, no cookies: safe after handover.                                    8 requests at most
    seat      takes the setup seat (one POST) and keeps its cookie in --state.              4 requests at most
    import    --file <json>: a dry run with the saved seat; --apply then imports it.        4 requests at most

It prints `ok   `, `FAIL ` and `info ` lines and ends with `RESULT PASS` or `RESULT FAIL` (exit 0 or 1), within 170
seconds. It sends a browser User-Agent ending in tofu-gallery-live-check, and this copy's Origin on every POST it means
to be accepted. Requests go one at a time, 400 ms apart; only the four-claim race runs in parallel. It never follows a
link or redirect it did not name, never crawls, and retries 502, 503 and 504 only for a GET or a claim sent again with
the same request id (three times, 5 seconds apart). Any other POST that fails is not sent again: the line fails.

It stops at once, failing, when the copy's address answers with the platform's security checkpoint (wait 10 minutes)
or sends it to an access-code page (run it before the access code is set), when its request budget would be exceeded,
and at its deadline. A line that must run and did not is a FAIL.

The state file (mode 600, never inside a git checkout) keeps the setup seat's cookie and what a later mode needs; it
is printed nowhere. Evidence goes next to it (STATE.evidence/, mode 700): each answer the check read, with private
links, cookie values, the password and (in delivery mode) the organizer's real people's names and contacts replaced.
The evidence of a delivery run stays private all the same. No output line carries a private link or a cookie.
"""

from __future__ import annotations

import argparse
import base64
import csv
import fcntl
import html.parser
import http.client
import io
import json
import os
import re
import secrets
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import date, datetime, timedelta, timezone

# --- The limits ---------------------------------------------------------------------------------------------------

BUDGETS = {'fresh': 55, 'delivery': 60, 'password': 12, 'read': 8, 'seat': 4, 'import': 4}
DEADLINE_SECONDS = 170.0
PACE_SECONDS = 0.4
RETRY_STATUSES = (502, 503, 504)
RETRY_TIMES = 3
RETRY_WAIT_SECONDS = 5.0
REQUEST_TIMEOUT_SECONDS = 30.0
MAX_BODY_BYTES = 2_000_000
IMPORT_LIMIT_BYTES = 512 * 1024
# Delivery keeps this much back for its cleanup, so a run that ran out still removes what it made.
CLEANUP_REQUESTS = 10
CLEANUP_SECONDS = 25.0
# Real open sheets whose public pages delivery reads for its privacy line.
REAL_SHEETS_READ = 2

USER_AGENT = (
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    'Version/18.0 Mobile/15E148 Safari/604.1 tofu-gallery-live-check'
)

# Only for the local bridge (test/db/live-check.test.ts): requests go through two pipes to route handlers called
# directly, never over a network. Refused for any address but this copy's loopback one.
PIPE_ENV = 'SIGNUP_SHEET_LIVE_CHECK_PIPE'
PIPE_PACE_ENV = 'SIGNUP_SHEET_LIVE_CHECK_PACE_MS'

# --- The app's own sentences (src/words.ts, the lines marked "exact") ----------------------------------------------

WORDS = {
    'originRefused': "This form has to be sent from this sheet's own page. Go back, reload the page and try again.",
    'signInFirst': 'Sign in as the organizer first.',
    'setupHeading': 'This sign-up sheet has no organizer yet',
    'setupButton': 'Set up this app as its organizer',
    'setupLost': "Someone else pressed Set up first. If that wasn't you, save ORGANIZER_PASSWORD in this app's Keys & settings in Tofu with Hide this value after saving on, then put it online again: that locks every other browser out.",
    'setupClosed': 'Setup is closed for good: this app has an organizer password. Sign in with it on the organizer page.',
    'heldElsewhere': 'This sign-up sheet already has an organizer',
    'signInHeading': 'Organizer sign-in',
    'wrongPassword': "That password isn't right.",
    'unknownLink': "This link doesn't work. It may have been replaced by a newer one. Ask the organizer for a new link.",
    'noCookie': "Open your private link to see your sign-ups. If you just did and you're back here, this browser isn't keeping cookies: open the link in Safari or Chrome.",
    'nothingImported': 'Nothing was imported.',
    'weekday': '{date} is a {actual}, but the file says {said}.',
    'wouldMake': 'Would make:',
    'imported': 'Imported:',
    'waitingNew': "This place is full, so you're on the waitlist: #{n}. If a place opens, you move up automatically.",
    'confirmedNew': "You're in: {slot}, ",
    'movedUpMe': 'Moved up from the waitlist on ',
    'movedUpOrg': '{name} moved up from the waitlist',
    'newLinkMade': 'Here is your new private link. The old one no longer works on any phone.',
    'attention': 'Needs attention',
    'seatBanner': "You're the organizer on this browser only, until ",
    'memberThrottle': 'Too many changes from this connection in a few minutes. Wait 10 minutes and try again.',
}

CSV_HEADER = [
    'Date', 'Weekday', 'Start', 'End', 'Date label', 'Place', 'Slot', 'Status', 'Name', 'Contact', 'Note', 'Paid',
    'Paid note', 'Added by', 'Signed up at', 'Date cancelled',
]

WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
               'November', 'December']

MUST_RUN = {
    'fresh': ['M01', 'M02', 'M03', 'M04', 'M05', 'M05b', 'M06', 'M07', 'M08', 'M09', 'M10b', 'M10', 'M11', 'M12', 'M13',
              'M14', 'M15', 'M16', 'M17', 'M17b', 'M18', 'M19', 'M20', 'M21', 'M22', 'M23', 'M24', 'M25', 'G01'],
    'delivery': ['D01', 'D02', 'D03', 'M08', 'M09', 'M10b', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17',
                 'M17b', 'M18', 'M19', 'M21', 'M22', 'M23', 'M24', 'M25', 'D30', 'D31', 'G01'],
    'password': ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'G01'],
    'read': ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08'],
    'seat': ['S01', 'S02', 'S03'],
    'import': ['I01', 'I02'],
}


class Stop(Exception):
    """Ends the run, failing it. `blocked`: the platform stopped the check, so not even a cleanup request is sent."""

    def __init__(self, text: str, blocked: bool = False):
        super().__init__(text)
        self.blocked = blocked


class Abort(Exception):
    """Ends the mode's flow after a FAIL line, because what comes next depends on what just failed."""

    def __init__(self, line: str, text: str):
        super().__init__(f'{line} {text}')
        self.line = line
        self.text = text


# --- Keeping private values out of output and evidence ------------------------------------------------------------

LONG_RUN = re.compile(r'(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])')
ORGANIZER_COOKIE = re.compile(r'\b(seat|pw)\.[A-Za-z0-9._-]+')
LINK_IN_PATH = re.compile(r'/me/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])')
TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')


def app_escape(text: str) -> str:
    """The app's own HTML escaping (src/lib/html.ts escapeHtml): & < > " ' as decimal references."""
    return re.sub(r'[&<>"\']', lambda m: f'&#{ord(m.group(0))};', text)


class Redactor:
    """Replaces what must never be printed or kept: links, cookie values, a password, and values it is told about."""

    def __init__(self) -> None:
        self.secrets: set[str] = set()
        self.people: set[str] = set()

    def secret(self, *values: str | None) -> None:
        for value in values:
            if value and len(value) >= 4:
                self.secrets.add(value)

    def person(self, *values: str | None) -> None:
        """A real person's name or contact (delivery mode): kept out of the evidence too."""
        for value in values:
            if value and len(value.strip()) >= 2:
                self.people.add(value.strip())

    def __call__(self, text: str) -> str:
        for value in sorted(self.secrets, key=len, reverse=True):
            for form in {value, urllib.parse.quote(value, safe=''), app_escape(value)}:
                text = text.replace(form, '[private]')
        for value in sorted(self.people, key=len, reverse=True):
            for form in {value, urllib.parse.quote(value, safe=''), app_escape(value)}:
                text = re.sub(r'(?<![A-Za-z0-9])' + re.escape(form) + r'(?![A-Za-z0-9])', '[person]', text)
        text = ORGANIZER_COOKIE.sub(lambda m: m.group(1) + '.[redacted]', text)
        return LONG_RUN.sub('[redacted]', text)


# --- Answers, cookies and browsers --------------------------------------------------------------------------------

class SetCookie:
    def __init__(self, line: str):
        parts = [part.strip() for part in line.split(';')]
        name, _, value = parts[0].partition('=')
        self.name = name.strip()
        self.value = value.strip()
        self.attrs: dict[str, str] = {}
        for part in parts[1:]:
            key, _, val = part.partition('=')
            if key:
                self.attrs[key.strip().lower()] = val.strip()

    @property
    def max_age(self) -> int | None:
        value = self.attrs.get('max-age')
        return int(value) if value is not None and re.fullmatch(r'-?[0-9]+', value) else None

    def removes(self) -> bool:
        return self.value == '' or (self.max_age is not None and self.max_age <= 0)


class Response:
    def __init__(self, method: str, path: str, status: int, headers: list[tuple[str, str]], body: bytes,
                 error: str | None = None, attempts: int = 1):
        self.method = method
        self.path = path
        self.status = status
        self.headers = [(name.lower(), value) for name, value in headers]
        self.body = body
        self.error = error
        self.attempts = attempts
        self._dom: Element | None = None

    def header(self, name: str) -> str | None:
        name = name.lower()
        for key, value in self.headers:
            if key == name:
                return value
        return None

    @property
    def location(self) -> str | None:
        return self.header('location')

    @property
    def text(self) -> str:
        return self.body.decode('utf-8', 'replace')

    def cookies(self) -> list[SetCookie]:
        return [SetCookie(value) for key, value in self.headers if key == 'set-cookie']

    def cookie(self, name: str) -> SetCookie | None:
        for cookie in self.cookies():
            if cookie.name == name:
                return cookie
        return None

    def json(self):
        try:
            return json.loads(self.text)
        except ValueError:
            return None

    def dom(self) -> Element:
        if self._dom is None:
            self._dom = parse_html(self.text)
        return self._dom

    def page_text(self) -> str:
        return self.dom().text()

    def is_app_page(self) -> bool:
        return '<html' in self.text[:400].lower() and 'href="/app.css"' in self.text

    def is_app_json(self) -> bool:
        data = self.json() if (self.header('content-type') or '').startswith('application/json') else None
        return isinstance(data, dict) and bool({'error', 'ok', 'app'} & set(data))

    def alert(self) -> str:
        """The app's sentence on a refusal page (its role=alert), for a FAIL line."""
        found = self.dom().find(pred=lambda e: e.attrs.get('role') == 'alert') if self.is_app_page() else None
        return found.text() if found is not None else ''

    def describe(self) -> str:
        if self.status == 0:
            return f'no answer ({self.error})'
        parts = [f'status {self.status}']
        if self.location:
            parts.append(f'Location {self.location}')
        sentence = self.alert()
        if sentence:
            parts.append(f'"{sentence[:160]}"')
        return ', '.join(parts)


class Jar:
    """One browser's cookies for this copy (every cookie of the app has Path=/ and no Domain)."""

    def __init__(self, label: str):
        self.label = label
        self.values: dict[str, str] = {}

    def take(self, response: Response) -> None:
        for cookie in response.cookies():
            if cookie.removes():
                self.values.pop(cookie.name, None)
            else:
                self.values[cookie.name] = cookie.value

    def header(self) -> str | None:
        return '; '.join(f'{name}={value}' for name, value in self.values.items()) or None

    def get(self, name: str) -> str | None:
        return self.values.get(name)

    def set(self, name: str, value: str) -> None:
        self.values[name] = value


# --- The page reader: a small tree from the standard library's HTML parser ----------------------------------------

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}


def normalize(text: str) -> str:
    return ' '.join(text.split())


class Element:
    def __init__(self, tag: str, attrs: list[tuple[str, str | None]], parent: Element | None):
        self.tag = tag
        self.attrs = {name: (value if value is not None else '') for name, value in attrs}
        self.children: list = []
        self.parent = parent

    def classes(self) -> list[str]:
        return self.attrs.get('class', '').split()

    def walk(self):
        for child in self.children:
            if isinstance(child, Element):
                yield child
                yield from child.walk()

    def find_all(self, tag: str | None = None, cls: str | None = None, pred=None) -> list[Element]:
        return [
            element for element in self.walk()
            if (tag is None or element.tag == tag) and (cls is None or cls in element.classes())
            and (pred is None or pred(element))
        ]

    def find(self, tag: str | None = None, cls: str | None = None, pred=None) -> Element | None:
        for element in self.walk():
            if (tag is None or element.tag == tag) and (cls is None or cls in element.classes()) and (pred is None or pred(element)):
                return element
        return None

    def raw_text(self, skip=None) -> str:
        parts = []
        for child in self.children:
            if isinstance(child, Element):
                if skip is not None and skip(child):
                    continue
                parts.append(child.raw_text(skip))
            else:
                parts.append(child)
        return ''.join(parts)

    def text(self, skip=None) -> str:
        return normalize(self.raw_text(skip))

    def ancestor(self, tag: str) -> Element | None:
        node = self.parent
        while node is not None and node.tag != tag:
            node = node.parent
        return node


class _Builder(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Element('#document', [], None)
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        element = Element(tag, attrs, self.current)
        self.current.children.append(element)
        if tag not in VOID:
            self.current = element

    def handle_startendtag(self, tag, attrs):
        self.current.children.append(Element(tag, attrs, self.current))

    def handle_endtag(self, tag):
        node = self.current
        while node is not None and node.tag != tag:
            node = node.parent
        if node is not None and node.parent is not None:
            self.current = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def parse_html(text: str) -> Element:
    builder = _Builder()
    builder.feed(text)
    builder.close()
    return builder.root


class Form:
    """A form as a browser would send it: its action, and its fields with the values the page gave them."""

    def __init__(self, element: Element):
        self.element = element
        self.action = element.attrs.get('action', '')
        self.method = element.attrs.get('method', 'get').lower()
        self.fields: list[tuple[str, str]] = []
        self.names: set[str] = set()
        for node in element.walk():
            name = node.attrs.get('name')
            if not name:
                continue
            if node.tag == 'input':
                kind = node.attrs.get('type', 'text').lower()
                self.names.add(name)
                if kind in ('submit', 'button', 'image', 'reset', 'file'):
                    continue
                if kind in ('checkbox', 'radio'):
                    if 'checked' in node.attrs:
                        self.fields.append((name, node.attrs.get('value', 'on')))
                    continue
                self.fields.append((name, node.attrs.get('value', '')))
            elif node.tag == 'textarea':
                self.names.add(name)
                self.fields.append((name, node.raw_text()))
            elif node.tag == 'select':
                self.names.add(name)
                options = node.find_all('option')
                chosen = next((o for o in options if 'selected' in o.attrs), options[0] if options else None)
                if chosen is not None:
                    self.fields.append((name, chosen.attrs.get('value', chosen.text())))

    def value(self, name: str) -> str | None:
        for key, value in self.fields:
            if key == name:
                return value
        return None

    def data(self, **changes: str) -> list[tuple[str, str]]:
        """The fields with some values changed (or added): what the check sends."""
        sent = []
        done = set()
        for key, value in self.fields:
            if key in changes:
                if key not in done:
                    sent.append((key, changes[key]))
                    done.add(key)
                continue
            sent.append((key, value))
        for key, value in changes.items():
            if key not in done:
                sent.append((key, value))
        return sent


def forms(root: Element, action: str | None = None, action_pattern: str | None = None) -> list[Form]:
    found = []
    for element in root.find_all('form'):
        form = Form(element)
        if action is not None and form.action != action:
            continue
        if action_pattern is not None and not re.fullmatch(action_pattern, form.action):
            continue
        found.append(form)
    return found


def read_sheet(root: Element) -> list[dict]:
    """A public sheet's dates, each with its slots: label, count, the claim address, and who is on it (name, note)."""
    dates = []
    for section in root.find_all('section', cls='date'):
        day = section.find('span', cls='day')
        slots = []
        for item in section.find_all('li', cls='slot'):
            label = item.find('span', cls='slot-name')
            count = item.find('span', cls='count')
            take = item.find('a', pred=lambda e: 'take' in e.classes())
            people = []
            listing = item.find('ul', cls='people')
            for person in (listing.find_all('li') if listing is not None else []):
                note = person.find('span', cls='note')
                people.append({'name': person.text(skip=lambda e: 'note' in e.classes()),
                               'note': note.text() if note is not None else ''})
            slots.append({
                'label': label.text() if label is not None else '',
                'count': count.text() if count is not None else '',
                'href': take.attrs.get('href', '') if take is not None else '',
                'people': people,
            })
        dates.append({'day': day.text() if day is not None else '', 'slots': slots,
                      'earlier': section.ancestor('details') is not None})
    return dates


def read_me(root: Element) -> list[dict]:
    """A person's own sign-ups on /me: id, slot, status words, meta lines and calendar file addresses."""
    signups = []
    for item in root.find_all('li', pred=lambda e: re.fullmatch(r's[0-9]+', e.attrs.get('id', '')) is not None):
        heading = item.find('h3')
        tag = heading.find('span', cls='tag') if heading is not None else None
        slot = item.find('span', cls='name')
        signups.append({
            'id': item.attrs['id'][1:],
            'slot': slot.text() if slot is not None else '',
            'status': tag.text() if tag is not None else '',
            'meta': [p.text() for p in item.find_all('p', cls='meta')],
            'ics': [a.attrs.get('href', '') for a in item.find_all('a')
                    if re.search(r'/calendar/[0-9]+\.ics$', a.attrs.get('href', ''))],
        })
    return signups


def read_roster(root: Element) -> list[dict]:
    """The organizer's people page: each person's id, name and tags (Paid, Not paid, Same name …)."""
    people = []
    for link in root.find_all('a', cls='name'):
        match = re.fullmatch(r'/organizer/people/([0-9]+)', link.attrs.get('href', ''))
        line = link.parent
        if match is None or line is None:
            continue
        people.append({'id': match.group(1), 'name': link.text(),
                       'tags': [tag.text() for tag in line.find_all('span', cls='tag')]})
    return people


# --- Ways to reach the copy --------------------------------------------------------------------------------------

class HttpTransport:
    """HTTP or HTTPS with certificate checks on (the system's own roots); plain HTTP only for this machine."""

    def __init__(self, scheme: str, host: str, port: int | None):
        self.scheme = scheme
        self.host = host
        self.port = port
        self.context = ssl.create_default_context() if scheme == 'https' else None

    def prepare(self, timeout: float):
        if self.scheme == 'https':
            conn = http.client.HTTPSConnection(self.host, self.port, timeout=timeout, context=self.context)
        else:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        conn.connect()
        return conn

    def exchange(self, conn, method: str, path: str, headers: dict[str, str], body: bytes | None):
        try:
            conn.request(method, path, body=body, headers=headers)
            answer = conn.getresponse()
            data = answer.read(MAX_BODY_BYTES)
            return answer.status, answer.getheaders(), data
        finally:
            conn.close()

    def send(self, method: str, path: str, headers: dict[str, str], body: bytes | None, timeout: float):
        return self.exchange(self.prepare(timeout), method, path, headers, body)


class PipeTransport:
    """The local bridge: one JSON line per request to `out`, answers by id from `inp` (no network at all)."""

    def __init__(self, out_fd: int, in_fd: int, host: str):
        self.out = os.fdopen(out_fd, 'wb', buffering=0)
        self.inp = os.fdopen(in_fd, 'rb')
        self.host = host
        self.lock = threading.Lock()
        self.next_id = 0
        self.waiting: dict[int, list] = {}
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        for line in self.inp:
            answer = json.loads(line)
            slot = self.waiting.get(answer['id'])
            if slot is not None:
                slot[1] = answer
                slot[0].set()
        for slot in list(self.waiting.values()):
            slot[0].set()

    def prepare(self, timeout: float):
        return timeout

    def exchange(self, conn, method, path, headers, body):
        return self.send(method, path, headers, body, conn)

    def send(self, method, path, headers, body, timeout):
        with self.lock:
            self.next_id += 1
            ident = self.next_id
            slot = [threading.Event(), None]
            self.waiting[ident] = slot
            # A Host the caller gives wins: one bridge can then stand in for several local addresses.
            host = next((v for k, v in headers.items() if k.lower() == 'host'), self.host)
            all_headers = [['host', host]] + [[k.lower(), v] for k, v in headers.items() if k.lower() != 'host']
            line = json.dumps({'id': ident, 'method': method, 'path': path, 'headers': all_headers,
                               'body': base64.b64encode(body or b'').decode('ascii')})
            self.out.write(line.encode('utf-8') + b'\n')
        if not slot[0].wait(timeout) or slot[1] is None:
            raise TimeoutError('the bridge did not answer')
        answer = self.waiting.pop(ident)[1]
        return answer['status'], [tuple(pair) for pair in answer['headers']], base64.b64decode(answer['body'])


# --- The client: budget, pace, deadline, retries, and what stops a run --------------------------------------------

SAME = object()


class Client:
    def __init__(self, base: str, transport, budget: int, evidence: Evidence | None, redact: Redactor, *,
                 deadline: float = DEADLINE_SECONDS, pace: float = PACE_SECONDS, clock=time.monotonic,
                 sleep=time.sleep):
        parsed = urllib.parse.urlsplit(base)
        self.scheme = parsed.scheme
        self.origin = f'{parsed.scheme}://{parsed.netloc.lower()}'
        self.transport = transport
        self.budget = budget
        self.evidence = evidence
        self.redact = redact
        self.deadline = deadline
        self.pace = pace
        self.clock = clock
        self.sleep = sleep
        self.started = clock()
        self.used = 0
        self.reserve = 0
        self.reserve_seconds = 0.0
        self.last_end: float | None = None
        self.locations: list[str] = []
        self.seen: dict[str, Response] = {}

    def cookie_name(self, base: str) -> str:
        return f'__Host-{base}' if self.scheme == 'https' else base

    def elapsed(self) -> float:
        return self.clock() - self.started

    def room(self, requests: int, cleanup: bool) -> None:
        reserve = 0 if cleanup else self.reserve
        if self.used + requests > self.budget - reserve:
            raise Stop(f'the request budget would be exceeded ({self.used} of {self.budget} used'
                       f'{f", {self.reserve} kept for cleanup" if reserve else ""})')
        seconds = 0.0 if cleanup else self.reserve_seconds
        if self.elapsed() >= self.deadline - seconds:
            raise Stop(f'the {int(self.deadline)}-second deadline passed')

    def wait_pace(self) -> None:
        if self.last_end is not None:
            gap = self.pace - (self.clock() - self.last_end)
            if gap > 0:
                self.sleep(gap)

    def headers(self, jar: Jar | None, method: str, origin, content_type: str | None) -> dict[str, str]:
        headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        }
        if method == 'POST':
            if origin is SAME:
                headers['Origin'] = self.origin
            elif origin is not None:
                headers['Origin'] = origin
        if content_type:
            headers['Content-Type'] = content_type
        cookie = jar.header() if jar is not None else None
        if cookie:
            headers['Cookie'] = cookie
        return headers

    def timeout(self) -> float:
        return max(1.0, min(REQUEST_TIMEOUT_SECONDS, self.deadline - self.elapsed()))

    def check_answer(self, response: Response) -> None:
        """What ends a run at once, whatever the line was about."""
        if response.status == 0:
            return
        foreign = not response.is_app_page() and not response.is_app_json()
        if response.header('x-vercel-mitigated') or (response.status in (403, 429) and foreign) or (
            foreign and 'Security Checkpoint' in response.text[:5000]
        ):
            raise Stop('the address answered with the platform\'s security checkpoint, not the app: stop now, wait '
                       '10 minutes, and run again (never sooner, and never in a loop)', blocked=True)
        location = response.location or ''
        if location:
            self.locations.append(location)
            target = urllib.parse.urlsplit(location)
            if target.path.startswith('/_tofu/'):
                raise Stop('the copy sent the check to its access-code page: run acceptance before an access code is '
                           'set, or turn the access code off for the check', blocked=True)
            if (target.scheme or target.netloc) and f'{target.scheme}://{target.netloc.lower()}' != self.origin:
                raise Stop('an answer redirected to another address; the check never follows one', blocked=True)
            if target.scheme or target.netloc:
                # The app answers relative Locations; should a proxy make one absolute on this origin, the lines still
                # compare paths (the original stays in `locations` for G01).
                relative = urllib.parse.urlunsplit(('', '', target.path or '/', target.query, target.fragment))
                response.headers = [(k, relative if k == 'location' else v) for k, v in response.headers]

    def send(self, jar: Jar | None, method: str, path: str, *, form=None, body: bytes | None = None,
             content_type: str | None = None, origin=SAME, retry: bool | None = None, cleanup: bool = False,
             keep_cookies: bool = True) -> Response:
        if not path.startswith('/') or path.startswith('//'):
            raise Stop('the check only ever requests paths on this copy')
        if form is not None:
            body = urllib.parse.urlencode(form).encode('utf-8')
            content_type = 'application/x-www-form-urlencoded'
        if retry is None:
            retry = method == 'GET'
        attempts = 0
        response: Response | None = None
        while True:
            self.room(1, cleanup)
            self.wait_pace()
            attempts += 1
            self.used += 1
            try:
                status, headers, data = self.transport.send(method, path, self.headers(jar, method, origin, content_type),
                                                            body, self.timeout())
                response = Response(method, path, status, list(headers), data, attempts=attempts)
            except (OSError, http.client.HTTPException, TimeoutError, ValueError) as error:
                response = Response(method, path, 0, [], b'', error=type(error).__name__, attempts=attempts)
            self.last_end = self.clock()
            if self.evidence is not None:
                self.evidence.save(jar.label if jar else 'no browser', response)
            self.check_answer(response)
            failed = response.status == 0 or response.status in RETRY_STATUSES
            if failed and retry and attempts <= RETRY_TIMES:
                self.wait_retry(cleanup)
                continue
            break
        if keep_cookies and jar is not None:
            jar.take(response)
        self.seen[f'{method} {path.split("?")[0]}'] = response
        return response

    def wait_retry(self, cleanup: bool) -> None:
        seconds = 0.0 if cleanup else self.reserve_seconds
        if self.elapsed() + RETRY_WAIT_SECONDS >= self.deadline - seconds:
            raise Stop(f'the {int(self.deadline)}-second deadline would pass while waiting to retry')
        self.sleep(RETRY_WAIT_SECONDS)

    def race(self, items: list[tuple[Jar, str, list[tuple[str, str]]]]) -> list[Response]:
        """Form POSTs sent at the same moment, one connection each, never retried."""
        self.room(len(items), False)
        self.wait_pace()
        barrier = threading.Barrier(len(items))
        results: list[Response | None] = [None] * len(items)

        def claim(index: int, jar: Jar, path: str, form) -> None:
            body = urllib.parse.urlencode(form).encode('utf-8')
            headers = self.headers(jar, 'POST', SAME, 'application/x-www-form-urlencoded')
            try:
                conn = self.transport.prepare(self.timeout())
            except (OSError, http.client.HTTPException) as error:
                barrier.abort()
                results[index] = Response('POST', path, 0, [], b'', error=type(error).__name__)
                return
            try:
                barrier.wait(timeout=30)
                status, answer_headers, data = self.transport.exchange(conn, 'POST', path, headers, body)
                results[index] = Response('POST', path, status, list(answer_headers), data)
            except (OSError, http.client.HTTPException, TimeoutError, ValueError, threading.BrokenBarrierError) as error:
                results[index] = Response('POST', path, 0, [], b'', error=type(error).__name__)

        threads = [threading.Thread(target=claim, args=(i, jar, path, form)) for i, (jar, path, form) in enumerate(items)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.used += len(items)
        self.last_end = self.clock()
        answers = []
        for (jar, path, _), response in zip(items, results):
            response = response or Response('POST', path, 0, [], b'', error='no answer')
            if self.evidence is not None:
                self.evidence.save(jar.label, response)
            self.check_answer(response)
            jar.take(response)
            answers.append(response)
        return answers


# --- What the check prints ----------------------------------------------------------------------------------------

class Report:
    def __init__(self, out, redact: Redactor):
        self.out = out
        self.redact = redact
        self.results: dict[str, bool] = {}
        self.lines: list[str] = []
        self.failed = False

    def _print(self, word: str, text: str) -> None:
        line = self.redact(f'{word:<5}{text}')
        self.lines.append(line)
        print(line, file=self.out, flush=True)

    def ok(self, line: str, text: str) -> None:
        self.results.setdefault(line, True)
        self._print('ok', f'{line} {text}')

    def fail(self, line: str, text: str) -> None:
        self.results[line] = False
        self.failed = True
        self._print('FAIL', f'{line} {text}')

    def check(self, line: str, condition: bool, text: str, detail: str = '') -> bool:
        if condition:
            self.ok(line, text)
        else:
            self.fail(line, f'{text}{f": {detail}" if detail else ""}')
        return bool(condition)

    def info(self, text: str) -> None:
        self._print('info', text)

    def finish(self, must_run: list[str]) -> bool:
        for line in must_run:
            if line not in self.results:
                self.fail(line, 'did not run, and a line that must run and did not is a FAIL')
        passed = not self.failed
        line = f'RESULT {"PASS" if passed else "FAIL"}'
        self.lines.append(line)
        print(line, file=self.out, flush=True)
        return passed


# --- Private state, its lock, and the evidence --------------------------------------------------------------------

def inside_git_checkout(path: str) -> bool:
    folder = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.exists(os.path.join(folder, '.git')):
            return True
        parent = os.path.dirname(folder)
        if parent == folder:
            return False
        folder = parent


class State:
    """The private state file: JSON, mode 600, for one copy only."""

    def __init__(self, path: str, origin: str):
        self.path = os.path.abspath(path)
        self.origin = origin
        self.data: dict = {}

    def load(self) -> None:
        if inside_git_checkout(self.path):
            raise Stop('the state file must not be inside a git checkout, where it could be committed')
        folder = os.path.dirname(self.path)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        if not os.path.exists(self.path):
            self.data = {'version': 1, 'origin': self.origin}
            return
        info = os.stat(self.path)
        if info.st_mode & 0o077:
            raise Stop('the state file can be read by others: make it private (chmod 600) or start a new one')
        with open(self.path, encoding='utf-8') as handle:
            self.data = json.load(handle)
        if self.data.get('origin') != self.origin:
            raise Stop('this state file belongs to another copy: give each copy its own --state file')

    def save(self) -> None:
        temporary = f'{self.path}.{os.getpid()}.tmp'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(self.data, handle, indent=2, sort_keys=True)
            handle.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.path)

    def lock(self):
        safe = re.sub(r'[^A-Za-z0-9.-]+', '_', self.origin)
        path = os.path.join(os.path.dirname(self.path), f'.live-check-{safe}.lock')
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(descriptor)
            raise Stop('another live check is running against this copy: let it finish first')
        return descriptor


class Evidence:
    """Each answer the check read, with private values replaced, in files only this user can read."""

    def __init__(self, root: str, mode: str, redact: Redactor):
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        os.makedirs(root, mode=0o700, exist_ok=True)
        os.chmod(root, 0o700)
        self.dir = os.path.join(root, f'{stamp}-{mode}')
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.redact = redact
        self.count = 0

    def write(self, name: str, text: str) -> None:
        descriptor = os.open(os.path.join(self.dir, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(self.redact(text))

    def save(self, browser: str, response: Response) -> None:
        self.count += 1
        shown = self.redact(response.path)
        slug = re.sub(r'[^A-Za-z0-9]+', '-', shown.split('?')[0]).strip('-')[:60] or 'root'
        lines = [f'{response.method} {shown}', f'browser: {browser}',
                 f'status: {response.status}{f" ({response.error})" if response.error else ""}']
        for name, value in response.headers:
            if name == 'set-cookie':
                cookie = SetCookie(value)
                value = '; '.join([f'{cookie.name}=[value]'] + [f'{k}={v}' if v else k for k, v in cookie.attrs.items()])
            lines.append(f'{name}: {value}')
        body = response.text
        if (response.header('content-type') or '').startswith('text/calendar'):
            body = body.replace('\r\n ', '').replace('\r\n\t', '')
            lines.append('(calendar file shown with its folded lines joined)')
        self.write(f'{self.count:02d}-{response.method}-{slug}.txt', '\n'.join(lines) + '\n\n' + body[:400_000])


# --- Dates and the check's own files ----------------------------------------------------------------------------

def utc_today() -> date:
    return datetime.now(timezone.utc).date()


def days_ahead(today: date, weekday: int, count: int) -> list[date]:
    """`count` dates on `weekday` (Monday 0), the first at least two days after today: ahead in every US zone."""
    first = today + timedelta(days=2)
    first += timedelta(days=(weekday - first.weekday()) % 7)
    return [first + timedelta(days=7 * n) for n in range(count)]


def long_day(day: date) -> str:
    return f'{WEEKDAYS_LONG[day.weekday()]}, {MONTHS_LONG[day.month - 1]} {day.day}'


def check_file(marker: str, saturdays: list[date], *, dry_run: bool, kind: str) -> dict:
    """The import the check makes its own sheet with: two Saturdays, Snacks (1 place) and Drivers (2), and QA Frank."""
    sheet = {
        'slug': f'qa-{marker}' if kind == 'fresh' else f'zz-check-{marker}',
        'title': f'QA sheet {marker}' if kind == 'fresh' else f'Check {marker}',
        'timezone': 'America/Los_Angeles',
        'place': 'QA field',
        'names': 'full',
        'status': 'open',
        'everyDate': [{'label': 'Snacks', 'capacity': 1}, {'label': 'Drivers', 'capacity': 2}],
        'dates': [{'date': day.isoformat(), 'weekday': 'Sat', 'start': '09:00', 'end': '10:30'} for day in saturdays],
    }
    if kind == 'delivery':
        sheet['listed'] = False
    document = {
        'format': 'signup-sheet/1',
        'dryRun': dry_run,
        'people': [{'key': 'frank', 'name': f'QA Frank {marker}', 'contact': f'qa-frank-{marker}@example.com',
                    'paidNote': f'PAIDPROBE{marker}'}],
        'sheets': [sheet],
    }
    if kind == 'fresh':
        # Delivery never sends `group`: the organizer's group name, organizer and dues stay as they are.
        document['group'] = {
            'name': f'QA group {marker}',
            'organizer': {'name': f'QA organizer {marker}', 'contact': f'qa-organizer-{marker}@example.com'},
            'dues': {'label': f'QA dues {marker}', 'amountCents': 4000},
        }
    return document


def weekday_file(marker: str, sunday: date) -> dict:
    return {'format': 'signup-sheet/1', 'dryRun': True,
            'sheets': [{'slug': f'qa-{marker}-wd', 'title': 'Weekday probe', 'timezone': 'America/Los_Angeles',
                        'dates': [{'date': sunday.isoformat(), 'weekday': 'Sat'}]}]}


def strict_json(text: str):
    """JSON with every duplicate key refused, as the app's own reader does."""
    def pairs(items):
        seen = {}
        for key, value in items:
            if key in seen:
                raise ValueError(f'"{key}" is written twice')
            seen[key] = value
        return seen
    return json.loads(text, object_pairs_hook=pairs)


# --- One run ----------------------------------------------------------------------------------------------------

class Run:
    def __init__(self, args, client: Client, report: Report, state: State, redact: Redactor, today: date, env):
        self.args = args
        self.client = client
        self.report = report
        self.state = state
        self.redact = redact
        self.today = today
        self.env = env
        self.marker = secrets.token_hex(3)
        self.jars: dict[str, Jar] = {}
        self.tokens: dict[str, str] = {}

    def jar(self, label: str) -> Jar:
        if label not in self.jars:
            self.jars[label] = Jar(label)
        return self.jars[label]

    def fresh_jar(self, label: str) -> Jar:
        self.jars[label] = Jar(label)
        return self.jars[label]

    def get(self, jar, path, **options) -> Response:
        return self.client.send(jar, 'GET', path, **options)

    def post(self, jar, path, form=None, **options) -> Response:
        return self.client.send(jar, 'POST', path, form=form if form is not None else [], **options)

    def post_json(self, jar, path, document, **options) -> Response:
        return self.client.send(jar, 'POST', path, body=json.dumps(document).encode('utf-8'),
                                content_type='application/json', **options)

    def seat_cookie(self) -> str | None:
        return self.state.data.get('seat', {}).get('cookie')

    def organizer_jar(self) -> Jar:
        jar = self.jar('organizer')
        cookie = self.seat_cookie()
        if cookie:
            jar.set(self.client.cookie_name('ss_org'), cookie)
        return jar

    def learn_token(self, who: str, jar: Jar) -> str | None:
        token = jar.get(self.client.cookie_name('ss_me'))
        if token:
            self.tokens[who] = token
            self.redact.secret(token)
        return token


def is_303_to(response: Response, path: str) -> bool:
    return response.status == 303 and response.location == path


def expect(run: Run, line: str, condition: bool, text: str, response: Response | None = None) -> None:
    """A FAIL that ends the flow: what follows depends on it."""
    if not condition:
        raise Abort(line, f'{text}{f": {response.describe()}" if response is not None else ""}')


def page_has(response: Response, sentence: str) -> bool:
    return sentence in response.page_text()


def contains_any(response: Response, values) -> list[str]:
    """Which of `values` the answer carries, as typed, HTML-escaped or percent-encoded, anywhere in it."""
    raw = response.text + '\n' + '\n'.join(f'{k}: {v}' for k, v in response.headers)
    shown = response.page_text() if response.is_app_page() else ''
    found = []
    for value in values:
        if not value:
            continue
        forms_of = {value, app_escape(value), urllib.parse.quote(value, safe=''), urllib.parse.quote_plus(value)}
        if any(form in raw for form in forms_of) or value in shown:
            found.append(value)
    return found


def looks_like_contact(value: str | None) -> bool:
    """An email address or a phone number: what a privacy line can look for without matching ordinary words."""
    value = (value or '').strip()
    return bool(re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', value)) or len(re.sub(r'[^0-9]', '', value)) >= 7


def cookie_attributes_ok(client: Client, cookie: SetCookie | None) -> tuple[bool, str]:
    if cookie is None:
        return False, 'no cookie was set'
    problems = []
    if cookie.attrs.get('path') != '/':
        problems.append('Path is not /')
    if 'domain' in cookie.attrs:
        problems.append('it has a Domain')
    if 'httponly' not in cookie.attrs:
        problems.append('it is not HttpOnly')
    if cookie.attrs.get('samesite', '').lower() != 'lax':
        problems.append('SameSite is not Lax')
    if client.scheme == 'https':
        if not cookie.name.startswith('__Host-'):
            problems.append('its name has no __Host- prefix')
        if 'secure' not in cookie.attrs:
            problems.append('it is not Secure')
    return not problems, ', '.join(problems)


def header_problems(response: Response, private: bool) -> list[str]:
    problems = []
    csp = response.header('content-security-policy') or ''
    if "frame-ancestors 'none'" not in csp:
        problems.append("no CSP frame-ancestors 'none'")
    if (response.header('x-frame-options') or '').upper() != 'DENY':
        problems.append('no X-Frame-Options DENY')
    if (response.header('referrer-policy') or '').lower() != 'same-origin':
        problems.append('Referrer-Policy is not same-origin')
    if 'noindex' not in (response.header('x-robots-tag') or ''):
        problems.append('no X-Robots-Tag noindex')
    if (response.header('x-content-type-options') or '').lower() != 'nosniff':
        problems.append('no nosniff')
    if response.header('x-powered-by'):
        problems.append('an X-Powered-By header')
    if private:
        cache = (response.header('cache-control') or '').lower()
        if 'no-store' not in cache or 'private' not in cache:
            problems.append('not private, no-store')
    return problems


def import_answer(response: Response) -> dict:
    data = response.json() if (response.header('content-type') or '').startswith('application/json') else None
    return data if isinstance(data, dict) else {}


def find_slot(dates: list[dict], day: date, label: str) -> dict | None:
    for entry in dates:
        if entry['day'] == long_day(day) and not entry['earlier']:
            for slot in entry['slots']:
                if slot['label'] == label:
                    return slot
    return None


def slot_id_of(slot: dict | None, slug: str) -> str | None:
    match = re.fullmatch(rf'/s/{re.escape(slug)}/slots/([0-9]+)', (slot or {}).get('href', ''))
    return match.group(1) if match else None


def claim_form(response: Response, slug: str, slot_id: str, remembered: bool) -> Form | None:
    action = f'/s/{slug}/slots/{slot_id}/claim'
    for form in forms(response.dom(), action=action):
        if form.method == 'post' and (form.value('as') == 'me') == remembered:
            return form
    return None


def signup_id_from(response: Response) -> str | None:
    match = re.fullmatch(r'/me\?new=([0-9]+)', response.location or '')
    return match.group(1) if match and response.status == 303 else None


def export_people(document: dict) -> dict[str, dict]:
    return {person.get('key'): person for person in document.get('people', []) if isinstance(person, dict)}


def export_sheet(document: dict, slug: str) -> dict | None:
    for sheet in document.get('sheets', []):
        if isinstance(sheet, dict) and sheet.get('slug') == slug:
            return sheet
    return None


def slot_signups(sheet: dict, day: date, label: str, people: dict[str, dict]) -> list[tuple[str, str]]:
    """(status, name) of a slot's sign-ups in the export's order: confirmed first, then the waitlist in its order."""
    return [(s.get('status'), people.get(s.get('person'), {}).get('name', '?')) for s in sheet.get('signups', [])
            if s.get('date') == day.isoformat() and s.get('slot') == label]


# --- The core, shared by fresh and delivery -----------------------------------------------------------------------

def core_flow(run: Run, kind: str, organizer: Jar, real: dict | None) -> dict:
    """Import a sheet of its own, then claims, a race, the waitlist, links, privacy, paid and the CSV."""
    report, client, marker = run.report, run.client, run.marker
    saturdays = days_ahead(run.today, 5, 2)
    sunday = days_ahead(run.today, 6, 1)[0]
    slug = f'qa-{marker}' if kind == 'fresh' else f'zz-check-{marker}'
    made = {'slug': slug, 'people': {}, 'saturdays': saturdays}
    names = {
        'A': f'QA Mike {marker}',
        'B': f'QA Frank {marker} 1',
        'C': f'QA Frank {marker} 2',
        'D': f'QA Frank {marker} 3',
        'E': f'QA Frank {marker} 4',
        'frank': f'QA Frank {marker}',
    }
    contacts = {who: f'qa-{who.lower()}-{marker}@example.com' for who in ('A', 'B', 'C', 'D', 'E')}
    contacts['frank'] = f'qa-frank-{marker}@example.com'
    organizer_contact = f'qa-organizer-{marker}@example.com' if kind == 'fresh' else ''
    run.state.data.setdefault('probes', {})['contacts'] = sorted(contacts.values()) + (
        [organizer_contact] if organizer_contact else [])
    run.state.data['probes']['words'] = [f'PAIDPROBE{marker}', f'QA dues {marker}'] if kind == 'fresh' else [
        f'PAIDPROBE{marker}']
    if kind == 'delivery':
        run.state.data['delivery'] = {'slug': slug, 'marker': marker, 'people': [],
                                      'startedAt': datetime.now(timezone.utc).isoformat()}
    run.state.save()

    # M08–M10: the import (a dry run, a refusal, a stranger, then for real).
    document = check_file(marker, saturdays, dry_run=True, kind=kind)
    answer = run.post_json(organizer, '/organizer/import', document)
    data = import_answer(answer)
    report.check('M08', answer.status == 200 and data.get('ok') is True and data.get('dryRun') is True
                 and str(data.get('summary', '')).startswith(WORDS['wouldMake']),
                 'the import\'s dry run answers 200 with "Would make"', answer.describe())
    probe = run.post_json(organizer, '/organizer/import', weekday_file(marker, sunday))
    sentence = f'{WORDS["weekday"].format(date=sunday.isoformat(), actual="Sunday", said="Sat")} {WORDS["nothingImported"]}'
    report.check('M09', probe.status == 400 and import_answer(probe).get('error') == sentence,
                 'a file whose date is a Sunday but says Sat answers 400 with the exact sentence (control: M08)',
                 probe.describe())
    stranger = run.post_json(run.fresh_jar('stranger'), '/organizer/import', document)
    report.check('M10b', stranger.status == 401 and import_answer(stranger) == {'error': WORDS['signInFirst']},
                 'the same dry run from a browser without the organizer cookie answers 401 (control: M08)',
                 stranger.describe())
    document['dryRun'] = False
    applied = run.post_json(organizer, '/organizer/import', document)
    data = import_answer(applied)
    expect(run, 'M10', applied.status == 200 and data.get('ok') is True and data.get('dryRun') is False
           and str(data.get('summary', '')).startswith(WORDS['imported']), 'the import applies with "Imported"', applied)
    report.ok('M10', 'the import applies with "Imported"')

    # The sheet before anyone signs up: its slots and their addresses, read from the page.
    before = run.get(run.fresh_jar('reader'), f'/s/{slug}')
    expect(run, 'M13', before.status == 200, f'/s/{slug} answers 200', before)
    dates = read_sheet(before.dom())
    snacks = find_slot(dates, saturdays[0], 'Snacks')
    drivers = find_slot(dates, saturdays[0], 'Drivers')
    snacks_id, drivers_id = slot_id_of(snacks, slug), slot_id_of(drivers, slug)
    expect(run, 'M13', snacks_id is not None and drivers_id is not None,
           f'the sheet shows Snacks and Drivers on {long_day(saturdays[0])} with a claim link each')
    control_count = snacks['count'] if snacks else ''

    # M11, M12: A claims Snacks, and sends the same form again.
    a = run.fresh_jar('A')
    page = run.get(a, f'/s/{slug}/slots/{snacks_id}')
    form = claim_form(page, slug, snacks_id, remembered=False)
    expect(run, 'M11', page.status == 200 and form is not None and form.value('rid') is not None
           and 'ss_hp' in form.names, 'the claim page has a form with a request id and the honeypot', page)
    fields = form.data(name=names['A'], contact=contacts['A'], note='Bringing oranges')
    claimed = run.post(a, form.action, fields, retry=True)
    signup_a = signup_id_from(claimed)
    token_a = run.learn_token('A', a)
    expect(run, 'M11', signup_a is not None and token_a is not None and TOKEN.match(token_a) is not None,
           'the claim answers 303 to /me?new=<id> with the private-link cookie', claimed)
    report.ok('M11', 'a claim of Snacks answers 303 to /me?new=<id> with the private-link cookie, and its Location '
                     'carries no link')
    again = run.post(a, form.action, fields, retry=True)
    report.check('M12', again.status == 303 and again.location == claimed.location
                 and (again.cookie(client.cookie_name('ss_me')) or SetCookie('x=')).value == token_a,
                 'the same form sent again answers the same Location and the same cookie', again.describe())

    # M13: the count changed, with the name and the note, and no contact.
    after = run.get(run.jar('reader'), f'/s/{slug}')
    slot = find_slot(read_sheet(after.dom()), saturdays[0], 'Snacks') if after.status == 200 else None
    leaked = contains_any(after, list(contacts.values()) + ([organizer_contact] if organizer_contact else []))
    report.check('M13', control_count == '1 place left' and slot is not None and slot['count'] == '1 of 1 taken'
                 and {'name': names['A'], 'note': 'Bringing oranges'} in slot['people'] and not leaked,
                 'the sheet shows "1 of 1 taken", A\'s name and note, and no contact (done 1: the count changes; '
                 'control: "1 place left" before)',
                 f'before "{control_count}", after {slot}, contacts shown: {len(leaked)}')

    # M14: four browsers claim the two Drivers places at once.
    racers = ['B', 'C', 'D', 'E']
    race_forms = []
    for who in racers:
        jar = run.fresh_jar(who)
        page = run.get(jar, f'/s/{slug}/slots/{drivers_id}')
        form = claim_form(page, slug, drivers_id, remembered=False)
        expect(run, 'M14', form is not None, 'each racing browser gets the claim form', page)
        race_forms.append((jar, form.action, form.data(name=names[who], contact=contacts[who])))
    answers = client.race(race_forms)
    race_ok = all(signup_id_from(answer) is not None for answer in answers)
    for who in racers:
        run.learn_token(who, run.jar(who))
    signup_b_drivers = signup_id_from(answers[0])

    # M15: B, remembered now, claims the full Snacks.
    b = run.jar('B')
    page = run.get(b, f'/s/{slug}/slots/{snacks_id}')
    form = claim_form(page, slug, snacks_id, remembered=True)
    expect(run, 'M15', form is not None and names['B'] in page.page_text(),
           'B\'s browser gets the "Signing up as" form for the full Snacks', page)
    waiting = run.post(b, form.action, form.data(note=''), retry=True)
    signup_b = signup_id_from(waiting)
    expect(run, 'M15', signup_b is not None, 'B\'s claim answers 303 to /me?new=<id>', waiting)
    panel = run.get(b, f'/me?new={signup_b}')
    report.check('M15', panel.status == 200 and page_has(panel, WORDS['waitingNew'].format(n=1)),
                 'claiming the full Snacks puts B on the waitlist as #1', panel.describe())

    # The organizer's export: the race's outcome, the waitlist, everyone's ids (and M21's control: contacts in it).
    exported = run.get(organizer, '/organizer/export.json')
    document = exported.json() if exported.status == 200 else None
    expect(run, 'M14', isinstance(document, dict), 'the organizer\'s export answers 200 JSON', exported)
    people = export_people(document)
    sheet = export_sheet(document, slug)
    expect(run, 'M14', sheet is not None, 'the export holds the check\'s sheet')
    raced = slot_signups(sheet, saturdays[0], 'Drivers', people)
    statuses = [status for status, _ in raced]
    report.check('M14', race_ok and statuses == ['confirmed', 'confirmed', 'waiting', 'waiting']
                 and sorted(name for _, name in raced) == sorted(names[who] for who in racers),
                 'four claims of the two Drivers places at once: all 303, none 5xx; the export shows exactly 2 '
                 'confirmed, then waiting #1 and #2',
                 f'answers {[answer.status for answer in answers]}, export {statuses}')
    queue = slot_signups(sheet, saturdays[0], 'Snacks', people)
    report.check('M15', queue == [('confirmed', names['A']), ('waiting', names['B'])],
                 'the export shows A confirmed on Snacks and B first on its waitlist', str(len(queue)))
    report.check('M21', any(p.get('contact') == contacts['A'] for p in people.values()),
                 'the organizer\'s export carries the contacts (the control for the cookieless export below)')
    ids = {}
    for key, person in people.items():
        for who, name in names.items():
            if person.get('name') == name:
                ids[who] = str(person.get('id'))
    made['people'] = ids
    if kind == 'delivery':
        known = {str(p.get('id')) for p in real.get('people', [])}
        run.state.data['delivery']['people'] = sorted(i for i in ids.values() if i not in known)
        run.state.save()

    # M16: A's private link in a new browser, A's own page, and a name change on the sheet.
    opener = run.fresh_jar('A elsewhere')
    opened = run.get(opener, f'/me/{token_a}')
    report.check('M16', is_303_to(opened, '/me') and opener.get(client.cookie_name('ss_me')) == token_a,
                 'A\'s private link in a new browser answers 303 /me and sets its cookie', opened.describe())
    mine = run.get(opener, '/me')
    report.check('M16', mine.status == 200 and contacts['A'] in mine.text and names['A'] in mine.text,
                 'A\'s /me shows A\'s own name and contact (done 2: the edit link works)', mine.describe())
    client.seen['me'] = mine
    profile = next(iter(forms(mine.dom(), action='/me/profile')), None)
    expect(run, 'M16', profile is not None, 'A\'s page has the form for name and contact', mine)
    names['A'] = f'{names["A"]} edited'
    changed = run.post(opener, '/me/profile', profile.data(name=names['A']))
    report.check('M16', is_303_to(changed, '/me?saved=1'), 'A\'s name change answers 303 /me?saved=1', changed.describe())
    shown = run.get(run.fresh_jar('public'), f'/s/{slug}' if kind == 'delivery' else '/')
    slot = find_slot(read_sheet(shown.dom()), saturdays[0], 'Snacks') if shown.status == 200 else None
    report.check('M16', slot is not None and any(p['name'] == names['A'] for p in slot['people']),
                 'the new name shows on the public sheet', shown.describe())
    # Pages whose every word is this run's own, and (delivery) the organizer's real public pages, whose own words
    # (a description that says "Paid parking", say) are theirs to choose: those are read for contacts and links only.
    public_pages = [(after, True, 'the sheet after the first claim'), (shown, True, 'the public sheet after the name change')]
    if kind == 'fresh':
        client.seen['home'] = shown
    else:
        home = run.get(run.jar('public'), '/')
        report.check('M21', home.status == 200 and not home.location, '/ answers 200', home.describe())
        public_pages.append((home, False, '/'))
        for real_sheet in [s for s in real.get('sheets', []) if s.get('status') == 'open'][:REAL_SHEETS_READ]:
            page = run.get(run.jar('public'), f'/s/{real_sheet.get("slug")}')
            if page.status == 200:
                public_pages.append((page, False, 'a real open sheet'))
            else:
                report.fail('M21', f'a real open sheet\'s page answers {page.describe()}')

    # M17: a link nobody has.
    unknown = run.get(run.fresh_jar('guess'), f'/me/{secrets.token_urlsafe(32)}')
    report.check('M17', unknown.status == 404 and page_has(unknown, WORDS['unknownLink']),
                 'a random 43-character link answers 404 with the unknown-link sentence (control: M16)',
                 unknown.describe())

    # M17b, M18: B cannot cancel A's sign-up; A can, and B moves up.
    theirs = run.post(b, f'/me/signups/{signup_a}/cancel')
    report.check('M17b', theirs.status == 404 and page_has(theirs, WORDS['unknownLink']),
                 'B\'s cookie cancelling A\'s sign-up answers 404 (control: A\'s own cancel next)', theirs.describe())
    own = run.post(a, f'/me/signups/{signup_a}/cancel')
    report.check('M17b', own.status == 303 and (own.location or '').startswith('/me?cancelled=1'),
                 'A cancelling A\'s own sign-up answers 303 /me?cancelled=1', own.describe())
    b_page = run.get(b, '/me')
    entries = {entry['id']: entry for entry in read_me(b_page.dom())} if b_page.status == 200 else {}
    entry = entries.get(signup_b, {})
    report.check('M18', entry.get('status') == 'Confirmed' and any(m.startswith(WORDS['movedUpMe']) for m in entry.get('meta', [])),
                 'B\'s page says "Moved up from the waitlist"', f'{b_page.describe()}, {entry.get("status")}')
    home = run.get(organizer, '/organizer')
    client.seen['organizer'] = home
    attention = home.dom().find('section', pred=lambda e: e.attrs.get('id') == 'attention') if home.status == 200 else None
    report.check('M18', attention is not None and WORDS['movedUpOrg'].format(name=names['B']) in attention.text(),
                 'the organizer home lists B under moved up', home.describe())

    # M19: B's own calendar file, from the link on B's page.
    ics = next((href for href in entry.get('ics', []) if href == f'/me/{run.tokens.get("B")}/calendar/{signup_b}.ics'), None)
    expect(run, 'M19', ics is not None, 'B\'s page links B\'s own calendar file for the Snacks place')
    calendar = run.get(run.fresh_jar('calendar app'), ics)
    body = calendar.text
    report.check('M19', calendar.status == 200 and (calendar.header('content-type') or '').startswith('text/calendar')
                 and '\r\nBEGIN:VEVENT\r\n' in body and body.count('BEGIN:VALARM') == 2
                 and re.search(r'\r\nDTSTART:[0-9]{8}T[0-9]{6}Z\r\n', body) is not None
                 and token_a not in body.replace('\r\n ', ''),
                 'B\'s calendar file answers 200 text/calendar with a VEVENT, two VALARMs, DTSTART in UTC, and no '
                 'other person\'s link', calendar.describe())

    # M20: paid (only where the copy has dues: delivery never changes them).
    dues = document.get('group', {}).get('dues') if isinstance(document.get('group'), dict) else None
    if dues:
        frank = ids.get('frank')
        person = run.get(organizer, f'/organizer/people/{frank}')
        paid_form = next(iter(forms(person.dom(), action=f'/organizer/people/{frank}/paid')), None)
        expect(run, 'M20', person.status == 200 and paid_form is not None, 'QA Frank\'s page has the paid form', person)
        marked = run.post(organizer, paid_form.action, paid_form.data(paid='1', amount='40', note=f'PAIDPROBE{marker}'))
        report.check('M20', is_303_to(marked, f'/organizer/people/{frank}?saved=1'), 'marking QA Frank paid at $40 '
                     'answers 303', marked.describe())
        unpaid = run.get(organizer, '/organizer/people?unpaid=1')
        listed = [p['name'] for p in read_roster(unpaid.dom())]
        report.check('M20', unpaid.status == 200 and names['frank'] not in listed and names['B'] in listed,
                     'the unpaid list leaves QA Frank out and lists those who have not paid', unpaid.describe())
        roster = run.get(organizer, '/organizer/people')
        tags = next((p['tags'] for p in read_roster(roster.dom()) if p['name'] == names['frank']), [])
        report.check('M20', roster.status == 200 and 'Paid, $40.00' in tags,
                     'the roster shows QA Frank "Paid, $40.00" (done 3: who paid and who did not; control for M07)',
                     f'{roster.describe()}, tags {tags}')
        made['roster'] = roster
    else:
        report.info('M20 this copy has no dues, so the paid probe (optional here) did not run')

    # M21: privacy of the public pages and of B's own page; the export to a stranger.
    everyone = list(contacts.values()) + ([organizer_contact] if organizer_contact else [])
    if real is not None:
        real_contacts = [p.get('contact', '') for p in real.get('people', [])]
        real_contacts.append(real.get('group', {}).get('organizer', {}).get('contact', ''))
        everyone += [c for c in real_contacts if looks_like_contact(c)]
        skipped = len([c for c in real_contacts if c and not looks_like_contact(c)])
        if skipped:
            report.info(f'{skipped} saved contacts look like neither an email address nor a phone number, so the '
                        'privacy line does not look for them')
    own_words = [f'PAIDPROBE{marker}'] + ([f'QA dues {marker}', '$40.00'] if kind == 'fresh' else [])
    if real is not None and isinstance(real.get('group', {}).get('dues'), dict):
        own_words.append(real['group']['dues'].get('label', ''))
    tokens = list(run.tokens.values())
    for page, ours, label in public_pages:
        found = contains_any(page, everyone) + contains_any(page, own_words if ours else [f'PAIDPROBE{marker}'])
        links = [t for t in tokens if t in page.text] + LINK_IN_PATH.findall(page.text)
        paid_word = ours and re.search(r'\bPaid\b', page.page_text()) is not None
        report.check('M21', page.status == 200 and not found and not links and not paid_word,
                     f'{label} ({page.path.split("?")[0]}) carries no contact, '
                     f'{"no paid state or dues" if ours else "no paid probe"}, and no private link',
                     f'{len(found)} private values, {len(links)} links, paid word {paid_word}')
    b_others = [t for who, t in run.tokens.items() if who != 'B']
    b_found = contains_any(b_page, [c for who, c in contacts.items() if who != 'B'])
    report.check('M21', b_page.status == 200 and not b_found and not any(t in b_page.text for t in b_others)
                 and contacts['B'] in b_page.text,
                 'B\'s own page carries B\'s own contact and no one else\'s contact or link', f'{len(b_found)} contacts')
    blocked = run.get(run.fresh_jar('stranger'), '/organizer/export.json')
    report.check('M21', is_303_to(blocked, '/organizer') and blocked.body == b'',
                 'the export to a browser without the organizer cookie is a 303 to /organizer with no data',
                 blocked.describe())

    # M22: B's own profile form from another site, then from this one.
    form = next(iter(forms(b_page.dom(), action='/me/profile')), None)
    expect(run, 'M22', form is not None, 'B\'s page has the profile form', b_page)
    foreign = run.post(b, '/me/profile', form.data(), origin='https://evil-probe.trytofu.app')
    report.check('M22', foreign.status == 403 and page_has(foreign, WORDS['originRefused']),
                 'a profile POST with B\'s cookie and a foreign Origin answers 403 with the Origin sentence',
                 foreign.describe())
    own_site = run.post(b, '/me/profile', form.data())
    report.check('M22', is_303_to(own_site, '/me?saved=1'),
                 'the same POST with this copy\'s Origin answers 303 /me?saved=1 (the control)', own_site.describe())

    # M24: the sheet's CSV.
    spreadsheet = run.get(organizer, f'/organizer/sheets/{slug}/export.csv')
    text = spreadsheet.body.decode('utf-8', 'replace')
    rows = list(csv.reader(io.StringIO(text.lstrip('\ufeff')))) if spreadsheet.status == 200 else []
    report.check('M24', spreadsheet.status == 200 and (spreadsheet.header('content-type') or '').startswith('text/csv')
                 and text.startswith('\ufeff') and bool(rows) and rows[0] == CSV_HEADER and '\r\n' in text,
                 'the sheet\'s CSV answers 200 text/csv with its byte order mark, CRLF and the header row',
                 spreadsheet.describe())

    # M25: B makes a new link; the old one stops working.
    old = run.tokens['B']
    rotated = run.post(b, '/me/new-link')
    shown_link = rotated.dom().find('input', pred=lambda e: e.attrs.get('id') == 'new-link') if rotated.status == 200 else None
    new = (shown_link.attrs.get('value', '') if shown_link is not None else '').rsplit('/me/', 1)[-1]
    if TOKEN.match(new):
        run.redact.secret(new)
        run.tokens['B'] = new
    report.check('M25', rotated.status == 200 and not rotated.location and page_has(rotated, WORDS['newLinkMade'])
                 and TOKEN.match(new) is not None and new != old and b.get(client.cookie_name('ss_me')) == new,
                 'B\'s new private link is shown once (200, no Location) and the cookie moves to it',
                 rotated.describe())
    dead = run.get(run.fresh_jar('old link'), f'/me/{old}')
    report.check('M25', dead.status == 404 and page_has(dead, WORDS['unknownLink']), 'the old link answers 404',
                 dead.describe())
    alive = run.get(run.fresh_jar('new link'), f'/me/{new}')
    report.check('M25', is_303_to(alive, '/me'), 'the new link answers 303 /me (the control)', alive.describe())
    made['signups'] = {'A': signup_a, 'B': signup_b, 'B drivers': signup_b_drivers}
    return made


def headers_line(run: Run, line: str, pages: list[tuple[str, Response | None, bool]]) -> None:
    problems = []
    for label, response, private in pages:
        if response is None:
            problems.append(f'{label}: not fetched')
            continue
        found = header_problems(response, private)
        if found:
            problems.append(f'{label}: {", ".join(found)}')
    run.report.check(line, not problems, "headers on " + ", ".join(label for label, _, _ in pages) + ": CSP "
                     "frame-ancestors 'none', X-Frame-Options DENY, Referrer-Policy same-origin, noindex, nosniff; "
                     "/me and /organizer private, no-store", '; '.join(problems))


def location_line(run: Run) -> None:
    carried = [location for location in run.client.locations if LINK_IN_PATH.search(location)]
    run.report.check('G01', not carried, 'no answer\'s Location carried a private link', f'{len(carried)} did')


# --- Modes ----------------------------------------------------------------------------------------------------------

def health(run: Run, jar: Jar | None = None) -> tuple[Response, dict]:
    answer = run.get(jar, '/health')
    data = answer.json() if answer.status == 200 else None
    return answer, data if isinstance(data, dict) else {}


def take_seat(run: Run, line: str, jar: Jar) -> Response:
    """POST /organizer/setup once. A lost answer while the seat is held is a FAIL: this copy cannot be trusted."""
    answer = run.post(jar, '/organizer/setup')
    cookie = answer.cookie(run.client.cookie_name('ss_org'))
    if answer.status == 0 or answer.status >= 500:
        after, data = health(run)
        if data.get('organizer') == 'held':
            raise Abort(line, 'the setup answer was lost while the seat became held: this run has no cookie for it. '
                              'Delete this copy and make a new one; never guess who holds the seat')
        raise Abort(line, f'the setup POST failed: {answer.describe()}')
    if is_303_to(answer, '/organizer') and cookie is not None and cookie.value.startswith('seat.'):
        run.redact.secret(cookie.value)
        run.state.data['seat'] = {'cookie': cookie.value, 'takenAt': datetime.now(timezone.utc).isoformat(),
                                  'worked': []}
        run.state.save()
    return answer


def run_fresh(run: Run) -> None:
    report = run.report
    answer, data = health(run)
    expect(run, 'M01', answer.status == 200 and data.get('app') == 'signup-sheet' and data.get('organizer') == 'setup-open',
           '/health answers 200 with organizer setup-open (fresh needs a copy nobody has set up)', answer)
    report.ok('M01', '/health answers 200 with organizer setup-open')
    root = run.get(None, '/')
    setup_forms = forms(root.dom(), action='/organizer/setup')
    report.check('M02', root.status == 200 and not root.location and page_has(root, WORDS['setupHeading'])
                 and bool(setup_forms) and WORDS['setupButton'] in setup_forms[0].element.text(),
                 '/ answers 200, no Location, with the setup heading and a Set up button posting to /organizer/setup',
                 root.describe())
    organizer_page = run.get(None, '/organizer')
    forget_ok = run.post(run.fresh_jar('forget'), '/forget', [('to', '/')])
    report.check('M03', is_303_to(forget_ok, '/'), 'POST /forget with this copy\'s Origin answers 303 (control for M04)',
                 forget_ok.describe())
    forget_bad = run.post(run.jar('forget'), '/forget', [('to', '/')], origin='https://evil-probe.trytofu.app')
    report.check('M04', forget_bad.status == 403 and page_has(forget_bad, WORDS['originRefused']),
                 'POST /forget with a foreign Origin answers 403 with the Origin sentence', forget_bad.describe())
    organizer = run.fresh_jar('organizer')
    setup_bad = run.post(organizer, '/organizer/setup', origin='https://evil-probe.trytofu.app')
    after, data = health(run)
    report.check('M05', setup_bad.status == 403 and page_has(setup_bad, WORDS['originRefused'])
                 and data.get('organizer') == 'setup-open',
                 'POST /organizer/setup with a foreign Origin answers 403 with the Origin sentence, and setup stays '
                 'open (control: M06, the same path)', setup_bad.describe())
    report.check('M05b', organizer_page.status == 200 and page_has(organizer_page, WORDS['setupHeading'])
                 and data.get('organizer') == 'setup-open',
                 'GET / and GET /organizer show the setup page and leave setup open', organizer_page.describe())
    seat = take_seat(run, 'M06', organizer)
    good, problems = cookie_attributes_ok(run.client, seat.cookie(run.client.cookie_name('ss_org')))
    expect(run, 'M06', is_303_to(seat, '/organizer') and good and run.seat_cookie() is not None,
           f'POST /organizer/setup answers 303 /organizer with the organizer cookie{f" ({problems})" if problems else ""}',
           seat)
    report.ok('M06', 'POST /organizer/setup answers 303 /organizer with the organizer cookie (HttpOnly, SameSite=Lax, '
                     'Path=/, no Domain' + ('; __Host- and Secure' if run.client.scheme == 'https' else '') + ')')
    second = run.fresh_jar('second browser')
    lost = run.post(second, '/organizer/setup')
    report.check('M07', lost.status == 403 and page_has(lost, WORDS['setupLost']),
                 'a second browser\'s setup answers 403 with "Someone else pressed Set up first"', lost.describe())
    roster = run.get(second, '/organizer/people')
    report.check('M07', is_303_to(roster, '/organizer') and roster.body == b'',
                 'and its GET /organizer/people is a 303 to /organizer with no roster (control: M20)', roster.describe())
    forged = run.fresh_jar('forged seat')
    forged.set(run.client.cookie_name('ss_org'), f'seat.{secrets.token_urlsafe(32)}')
    refused = run.get(forged, '/organizer/people')
    report.check('M07', is_303_to(refused, '/organizer') and refused.body == b'',
                 'a forged seat cookie gets the same 303 with nothing in it', refused.describe())

    made = core_flow(run, 'fresh', organizer, None)
    run.state.data['seat']['worked'] = ['fresh M06', 'fresh M14 export']
    run.state.data['fresh'] = {'slug': made['slug'], 'at': datetime.now(timezone.utc).isoformat()}
    run.state.save()
    headers_line(run, 'M23', [('/', root, False), ('the sheet', run.client.seen.get(f'GET /s/{made["slug"]}'), False),
                              ('/me', run.client.seen.get('me'), True), ('/organizer', run.client.seen.get('organizer'), True)])


def real_view(document: dict, own_slug: str, own_people: set[str]) -> dict:
    """The organizer's own data in an export, without this run's sheet and people, for comparing before and after."""
    people = [p for p in document.get('people', []) if str(p.get('id')) not in own_people]
    keys = {p.get('key') for p in people}
    sheets = []
    for sheet in document.get('sheets', []):
        if sheet.get('slug') == own_slug:
            continue
        copy = dict(sheet)
        copy['signups'] = [s for s in sheet.get('signups', []) if s.get('person') in keys]
        sheets.append(copy)
    return {'group': document.get('group'), 'people': people, 'sheets': sheets}


def own_name(marker: str):
    """The names this run gives its own people (core_flow): nothing else is ever removed."""
    return re.compile(rf'^QA (?:Mike|Frank) {re.escape(marker)}(?: edited| [1-4])?$')


def own_people_in(document: dict, marker: str) -> list[str]:
    pattern = own_name(marker)
    return [str(p.get('id')) for p in document.get('people', []) if marker and pattern.match(str(p.get('name', '')))]


def cleanup(run: Run, organizer: Jar, slug: str, people: list[str], marker: str, discover: bool) -> tuple[bool, list[str]]:
    """Deletes this run's own sheet, then its own people by id. Answers whether all of it went, and whom it removed."""
    report = run.report
    gone = True
    confirm = run.get(organizer, f'/organizer/sheets/{slug}/delete', cleanup=True)
    if confirm.status == 200:
        form = next(iter(forms(confirm.dom(), action=f'/organizer/sheets/{slug}/delete')), None)
        seen = form.value('seen') if form is not None else None
        if form is None or not seen or form.value('confirm') != 'yes':
            report.fail('D30', 'the delete confirmation has no form with confirm and seen')
            gone = False
        else:
            deleted = run.post(organizer, form.action, form.data(), cleanup=True)
            if not is_303_to(deleted, '/organizer?deleted=1'):
                report.fail('D30', f'deleting the check\'s sheet answered {deleted.describe()}')
                gone = False
    elif confirm.status != 404:
        report.fail('D30', f'the check\'s sheet\'s delete page answered {confirm.describe()}')
        gone = False
    if discover:
        # The run ended before it read its people's ids: find them by the names only it gives, in a new export.
        found = run.get(organizer, '/organizer/export.json', cleanup=True)
        people = own_people_in(found.json() or {}, marker) if found.status == 200 else []
    for person in people:
        removed = run.post(organizer, f'/organizer/people/{person}/delete', cleanup=True)
        if not (is_303_to(removed, '/organizer/people?deleted=1') or removed.status == 404):
            report.fail('D30', f'removing person {person} answered {removed.describe()}')
            gone = False
    return gone, people


def run_delivery(run: Run) -> None:
    report, client = run.report, run.client
    if not run.seat_cookie():
        raise Abort('D01', 'no seat in --state: run --mode seat first, while setup is open')
    answer, data = health(run)
    expect(run, 'D01', answer.status == 200 and data.get('organizer') == 'held',
           '/health says the seat is held (delivery runs only while the agent holds it)', answer)
    report.ok('D01', '/health says the seat is held')
    organizer = run.organizer_jar()
    home = run.get(organizer, '/organizer')
    expect(run, 'D02', home.status == 200 and page_has(home, WORDS['attention']) and page_has(home, WORDS['seatBanner']),
           'the saved seat opens the dashboard', home)
    report.ok('D02', 'the saved seat opens the dashboard')
    pending = run.state.data.get('delivery')
    if pending and not run.args.cleanup_only:
        raise Abort('D03', f'an earlier delivery run left {pending.get("slug")} behind: run --mode delivery '
                           '--cleanup-only first')
    exported = run.get(organizer, '/organizer/export.json')
    before = exported.json() if exported.status == 200 else None
    expect(run, 'D03', isinstance(before, dict) and isinstance(before.get('people'), list)
           and isinstance(before.get('sheets'), list), 'the export before the check answers 200 with people and sheets',
           exported)
    for person in before.get('people', []):
        run.redact.person(person.get('name'), person.get('contact'))
    run.redact.person(before.get('group', {}).get('organizer', {}).get('contact'))
    client.reserve = CLEANUP_REQUESTS
    client.reserve_seconds = CLEANUP_SECONDS

    if run.args.cleanup_only:
        if not pending:
            report.ok('D03', 'nothing is left from an earlier run')
            report.ok('D30', 'nothing to remove')
            report.ok('D31', 'nothing changed')
            return
        report.ok('D03', 'the export before cleanup answers 200')
        marker = pending.get('marker', '')
        finish_delivery(run, organizer, before, pending.get('slug'), own_people_in(before, marker), marker, False)
        return
    report.ok('D03', f'the export before the check: {len(before["people"])} people, {len(before["sheets"])} sheet(s)')
    if any(str(s.get('slug', '')).startswith('zz-check-') for s in before['sheets']):
        report.info('a zz-check sheet from another run is on this copy; this run leaves it alone')

    try:
        made = core_flow(run, 'delivery', organizer, before)
        headers_line(run, 'M23', [('/', client.seen.get('GET /'), False),
                                  ('the sheet', client.seen.get(f'GET /s/{made["slug"]}'), False),
                                  ('/me', client.seen.get('me'), True),
                                  ('/organizer', client.seen.get('organizer'), True)])
    except Abort as abort:
        report.fail(abort.line, abort.text)
    except Stop as stop:
        report.fail('STOP', str(stop))
        if stop.blocked:
            report.info('nothing more is sent now: after 10 minutes, run --mode delivery --cleanup-only to remove '
                        'what this run made')
            return
    except Exception as error:  # whatever stopped the core, what it made is removed
        report.fail('CHECK', f'the check could not read an answer ({type(error).__name__}: {error})')
    pending = run.state.data.get('delivery') or {}
    if pending.get('slug'):
        recorded = [str(p) for p in pending.get('people', [])]
        finish_delivery(run, organizer, before, pending['slug'], recorded, pending.get('marker', ''), not recorded)


def finish_delivery(run: Run, organizer: Jar, before: dict, slug: str, people: list[str], marker: str,
                    discover: bool) -> None:
    """Removes the run's own sheet and people, then proves from a new export that the organizer's data is as it was."""
    report = run.report
    gone, removed = cleanup(run, organizer, slug, people, marker, discover)
    report.check('D30', gone, f'the check\'s sheet and its {len(removed)} own people are removed, by their ids')
    exported = run.get(organizer, '/organizer/export.json', cleanup=True)
    after = exported.json() if exported.status == 200 else None
    if not isinstance(after, dict):
        report.fail('D31', f'the export after the check answered {exported.describe()}')
        return
    own = set(removed) | set(own_people_in(before, marker))
    leftovers = [s.get('slug') for s in after.get('sheets', []) if s.get('slug') == slug] + own_people_in(after, marker)
    same = real_view(before, slug, own) == real_view(after, slug, own)
    counts = lambda doc: (len([p for p in doc.get('people', []) if str(p.get('id')) not in own]),
                          len([p for p in doc.get('people', []) if str(p.get('id')) not in own and not p.get('paid')]))
    report.check('D31', same and not leftovers and counts(after) == counts(before),
                 'the organizer\'s data is as it was: group, people, paid state, sheets and sign-ups; the roster and '
                 'unpaid counts are back',
                 f'{"changed" if not same else "same"} data, {len(leftovers)} left over'
                 + ('' if same else ' (if someone signed up meanwhile, compare the exports by hand)'))
    if gone and not leftovers:
        run.state.data.pop('delivery', None)
        run.state.save()


def run_password(run: Run) -> None:
    report, client = run.report, run.client
    password = run.env.get('QA_PW', '')
    if run.args.qa_pw_file:
        if os.stat(run.args.qa_pw_file).st_mode & 0o077:
            raise Abort('P05', 'the --qa-pw-file can be read by others: make it private (chmod 600)')
        with open(run.args.qa_pw_file, encoding='utf-8') as handle:
            password = handle.read().strip()
    expect(run, 'P05', len(password) >= 12, 'QA_PW (12 characters or more) is needed for --mode password')
    run.redact.secret(password)
    old_seat = run.seat_cookie()
    expect(run, 'P03', bool(old_seat), 'the seat cookie from an earlier fresh or seat run is in --state')
    answer, data = health(run)
    report.check('P01', answer.status == 200 and data.get('organizer') == 'password', '/health says password',
                 answer.describe())
    closed = run.post(run.fresh_jar('setup'), '/organizer/setup')
    report.check('P02', closed.status == 403 and page_has(closed, WORDS['setupClosed']),
                 'setup is refused with "Setup is closed for good" (control: fresh M06 took it)', closed.describe())
    seat_jar = run.organizer_jar()
    stale = run.get(seat_jar, '/organizer/people')
    report.check('P03', is_303_to(stale, '/organizer') and stale.body == b'',
                 f'the old seat cookie (it worked in {", ".join(run.state.data["seat"].get("worked", [])) or "an earlier run"})'
                 ' is refused on /organizer/people (control: the password cookie below)', stale.describe())
    browser = run.fresh_jar('password browser')
    sign_in = run.get(browser, '/organizer')
    form = next(iter(forms(sign_in.dom(), action='/organizer/sign-in')), None)
    expect(run, 'P04', sign_in.status == 200 and page_has(sign_in, WORDS['signInHeading']) and form is not None
           and form.value('username') == 'organizer' and 'password' in form.names,
           '/organizer shows the sign-in form', sign_in)
    wrong = run.post(browser, form.action, form.data(password=secrets.token_urlsafe(18)))
    told = run.get(browser, wrong.location or '/organizer?e=wrong') if is_303_to(wrong, '/organizer?e=wrong') else wrong
    report.check('P04', is_303_to(wrong, '/organizer?e=wrong') and told.status == 200 and page_has(told, WORDS['wrongPassword']),
                 'a wrong password is refused with "That password isn\'t right."', wrong.describe())
    right = run.post(browser, form.action, form.data(password=password))
    cookie = right.cookie(client.cookie_name('ss_org'))
    good, problems = cookie_attributes_ok(client, cookie)
    report.check('P05', is_303_to(right, '/organizer') and good and cookie is not None and cookie.value.startswith('pw.'),
                 'QA_PW signs in: 303 /organizer with the organizer cookie', problems or right.describe())
    if cookie is not None:
        run.redact.secret(cookie.value)
    dashboard = run.get(browser, '/organizer')
    people = run.get(browser, '/organizer/people')
    exported = run.get(browser, '/organizer/export.json')
    report.check('P06', dashboard.status == 200 and page_has(dashboard, WORDS['attention']) and people.status == 200
                 and isinstance(exported.json(), dict),
                 'with the password cookie the dashboard, /organizer/people and the export answer 200',
                 f'{dashboard.describe()}; {people.describe()}; {exported.describe()}')
    headers_line(run, 'P06', [('/organizer', dashboard, True)])


def run_read(run: Run) -> None:
    report = run.report
    answer, data = health(run)
    report.check('R01', answer.status == 200 and data.get('app') == 'signup-sheet' and 'organizer' in data,
                 f'/health answers 200 (organizer {data.get("organizer")}, {data.get("openSheets")} open sheets)',
                 answer.describe())
    root = run.get(None, '/')
    report.check('R02', root.status == 200 and not root.location, '/ answers 200 and never redirects', root.describe())
    slug = run.args.sheet
    if not slug:
        canonical = root.dom().find('link', pred=lambda e: e.attrs.get('rel') == 'canonical')
        match = re.search(r'/s/([a-z0-9-]+)$', canonical.attrs.get('href', '')) if canonical is not None else None
        slug = match.group(1) if match else None
    expect(run, 'R03', slug is not None, '/ shows no one sheet in place: name the sheet with --sheet <slug>')
    sheet = run.get(None, f'/s/{slug}')
    dates = read_sheet(sheet.dom()) if sheet.status == 200 else []
    report.check('R03', sheet.status == 200 and bool(dates), f'/s/{slug} answers 200 with its dates', sheet.describe())
    headers_line(run, 'R04', [('/', root, False), ('the sheet', sheet, False)])
    # Without a cookie this mode cannot read the organizer's real contacts: it looks only for the contacts and words this
    # check made itself in an earlier fresh or delivery run on this copy, and says how many, or that it had none.
    probes = run.state.data.get('probes', {})
    known = probes.get('contacts', []) + probes.get('words', [])
    found = []
    for page in (root, sheet):
        found += contains_any(page, known)
        found += LINK_IN_PATH.findall(page.text)
        if re.search(r'\bPaid\b', page.page_text()):
            found.append('Paid')
    if known:
        report.info(f'R05 looks for {len(known)} contacts and words an earlier run of this check made on this copy; '
                    'it cannot know the organizer\'s real contacts')
        text = 'the public pages carry no private link, none of those contacts or words, and no paid state or dues'
    else:
        report.info('R05 known contacts: not exercised, the state file holds none from an earlier fresh or delivery run')
        text = 'the public pages carry no private link and no paid state or dues'
    report.check('R05', not found, text, f'{len(found)} found')
    organizer = run.get(None, '/organizer')
    report.check('R06', organizer.status == 200 and not page_has(organizer, WORDS['attention']),
                 '/organizer without a cookie shows its access page and no organizer data', organizer.describe())
    me = run.get(None, '/me')
    report.check('R07', me.status == 200 and page_has(me, WORDS['noCookie']),
                 '/me without a cookie answers 200 with how to get back in', me.describe())
    unknown = run.get(None, f'/me/{secrets.token_urlsafe(32)}')
    report.check('R08', unknown.status == 404 and page_has(unknown, WORDS['unknownLink']),
                 'an unknown link answers 404 with the unknown-link sentence', unknown.describe())


def run_seat(run: Run) -> None:
    report, client = run.report, run.client
    if run.seat_cookie():
        raise Abort('S01', 'this state already holds a seat: one copy, one seat, one state file')
    answer, data = health(run)
    expect(run, 'S01', answer.status == 200 and data.get('organizer') == 'setup-open',
           '/health says setup-open (take the seat within a minute of the first deploy)', answer)
    report.ok('S01', '/health says setup-open')
    organizer = run.fresh_jar('organizer')
    seat = take_seat(run, 'S02', organizer)
    good, problems = cookie_attributes_ok(client, seat.cookie(client.cookie_name('ss_org')))
    expect(run, 'S02', is_303_to(seat, '/organizer') and good and run.seat_cookie() is not None,
           f'the setup POST answers 303 with the organizer cookie{f" ({problems})" if problems else ""}', seat)
    report.ok('S02', 'the setup POST answers 303 with the organizer cookie, saved to --state (not printed)')
    home = run.get(organizer, '/organizer')
    report.check('S03', home.status == 200 and page_has(home, WORDS['seatBanner']),
                 'the dashboard answers this browser, with the seat banner', home.describe())
    run.state.data['seat']['worked'] = ['seat S03']
    run.state.save()


def run_import(run: Run) -> None:
    report = run.report
    if not run.args.file:
        raise Abort('I02', '--mode import needs --file <json>')
    with open(run.args.file, 'rb') as handle:
        raw = handle.read(IMPORT_LIMIT_BYTES + 1)
    expect(run, 'I02', len(raw) <= IMPORT_LIMIT_BYTES, 'the file is 512 KB or less')
    try:
        document = strict_json(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as error:
        raise Abort('I02', f'the file is not strict JSON: {error}')
    expect(run, 'I02', isinstance(document, dict), 'the file is one JSON object')
    expect(run, 'I01', bool(run.seat_cookie()), 'no seat in --state: run --mode seat first')
    organizer = run.organizer_jar()
    home = run.get(organizer, '/organizer')
    expect(run, 'I01', home.status == 200 and page_has(home, WORDS['attention']), 'the saved seat opens the dashboard', home)
    report.ok('I01', 'the saved seat opens the dashboard')
    document['dryRun'] = True
    checked = run.post_json(organizer, '/organizer/import', document)
    data = import_answer(checked)
    if not (checked.status == 200 and data.get('ok') is True):
        error = data.get('error') or checked.describe()
        where = f' (at {data["path"]})' if data.get('path') else ''
        raise Abort('I02', f'the dry run refused the file: {error}{where}')
    report.ok('I02', 'the dry run accepts the file')
    report.info(f'summary: {data.get("summary")}')
    if run.args.apply:
        document['dryRun'] = False
        applied = run.post_json(organizer, '/organizer/import', document)
        data = import_answer(applied)
        report.check('I03', applied.status == 200 and data.get('ok') is True and data.get('dryRun') is False,
                     'the file is imported', data.get('error') or applied.describe())
        if applied.status == 0 or applied.status >= 500:
            report.info('the import\'s answer was lost: it may have been applied. Read the organizer page or the '
                        'export before sending it again')
        report.info(f'summary: {data.get("summary")}')


MODES = {'fresh': run_fresh, 'delivery': run_delivery, 'password': run_password, 'read': run_read, 'seat': run_seat,
         'import': run_import}


# --- Entry point ------------------------------------------------------------------------------------------------------

LOOPBACK = {'127.0.0.1', 'localhost', '::1'}


def base_address(text: str) -> tuple[str, str, int | None]:
    parsed = urllib.parse.urlsplit(text.strip())
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in ('https', 'http') or not host or parsed.username or parsed.password:
        raise ValueError('the address must look like https://<copy host>')
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('the address must be the copy\'s origin only, with no path')
    if parsed.scheme == 'http' and host not in LOOPBACK:
        raise ValueError('plain http only for this machine (127.0.0.1 or localhost); a copy on Tofu is https')
    return parsed.scheme, host, parsed.port


def parse_arguments(argv):
    parser = argparse.ArgumentParser(prog='live-check.py', description=__doc__.split('\n\n')[0])
    parser.add_argument('address', help='the copy, like https://sign-up-sheet-ab12cd.trytofu.app')
    parser.add_argument('--mode', required=True, choices=sorted(MODES))
    parser.add_argument('--state', required=True, help='the private state file for this copy (mode 600)')
    parser.add_argument('--file', help='--mode import: the signup-sheet/1 file')
    parser.add_argument('--apply', action='store_true', help='--mode import: import it after the dry run')
    parser.add_argument('--sheet', help='--mode read: the sheet to read when / shows several')
    parser.add_argument('--qa-pw-file', help='--mode password: a file holding QA_PW (instead of the variable)')
    parser.add_argument('--cleanup-only', action='store_true',
                        help='--mode delivery: only remove what an earlier delivery run left behind')
    return parser.parse_args(argv)


def main(argv=None, *, transport=None, out=None, env=None, clock=time.monotonic, sleep=time.sleep,
         today: date | None = None) -> int:
    out = out or sys.stdout
    env = os.environ if env is None else env
    args = parse_arguments(argv)
    redact = Redactor()
    report = Report(out, redact)
    try:
        scheme, host, port = base_address(args.address)
    except ValueError as error:
        report.fail('ARGS', str(error))
        report.finish([])
        return 1
    shown_host = f'[{host}]' if ':' in host else host
    default_port = 443 if scheme == 'https' else 80
    netloc = shown_host if port in (None, default_port) else f'{shown_host}:{port}'
    origin = f'{scheme}://{netloc}'
    pace = PACE_SECONDS
    if transport is None:
        pipe = env.get(PIPE_ENV, '')
        if pipe:
            if scheme != 'http' or host not in LOOPBACK:
                report.fail('ARGS', f'{PIPE_ENV} is only for the local bridge on a loopback address')
                report.finish([])
                return 1
            out_fd, in_fd = (int(part) for part in pipe.split(','))
            transport = PipeTransport(out_fd, in_fd, netloc)
            if env.get(PIPE_PACE_ENV):
                pace = int(env[PIPE_PACE_ENV]) / 1000
        else:
            transport = HttpTransport(scheme, host, port)
    state = State(args.state, origin)
    lock = None
    passed = False
    try:
        state.load()
        lock = state.lock()
        evidence = Evidence(f'{state.path}.evidence', args.mode, redact)
        client = Client(origin, transport, BUDGETS[args.mode], evidence, redact, pace=pace, clock=clock, sleep=sleep)
        run = Run(args, client, report, state, redact, today or utc_today(), env)
        cookie = run.seat_cookie()
        if cookie:
            redact.secret(cookie)
        must = list(MUST_RUN[args.mode])
        if args.mode == 'import' and args.apply:
            must.append('I03')
        if args.mode == 'delivery' and args.cleanup_only:
            must = ['D01', 'D02', 'D03', 'D30', 'D31']
        try:
            MODES[args.mode](run)
        except Abort as abort:
            report.fail(abort.line, abort.text)
        except Stop as stop:
            report.fail('STOP', str(stop))
        except Exception as error:  # an answer the check could not read is a FAIL, never a traceback without a RESULT
            report.fail('CHECK', f'the check could not read an answer ({type(error).__name__}: {error})')
        if args.mode in ('fresh', 'delivery', 'password'):
            location_line(run)
        report.info(f'{client.used} of {client.budget} requests, {client.elapsed():.1f} of {int(client.deadline)} seconds')
        passed = report.finish(must)
        evidence.write('result.txt', '\n'.join(report.lines) + '\n')
        state.data.setdefault('runs', []).append({'mode': args.mode, 'result': 'PASS' if passed else 'FAIL',
                                                  'at': datetime.now(timezone.utc).isoformat()})
        state.save()
    except Stop as stop:
        report.fail('STOP', str(stop))
        report.finish([])
        passed = False
    finally:
        if lock is not None:
            os.close(lock)
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
