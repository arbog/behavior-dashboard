'use strict';
// Calendar subscription tests (0024): the ICS parser against real-world
// shapes (Google and Apple exports), the fetch guard, and the whole
// save → sync → kiosk flow with a local feed server.
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'cal-suite-setup-token-555';
process.env.LOGIN_RATE_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { parseIcs, icsDateToTs, hostAllowed } = require('./ics.js');

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Calendar 70.0//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:abc123@google.com
DTSTAMP:20261105T000000Z
DTSTART;TZID=America/Los_Angeles:20261110T090000
DTEND;TZID=America/Los_Angeles:20261110T100000
SUMMARY:Therapy appointment
LOCATION:Building 7
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261111
DTEND;VALUE=DATE:20261113
SUMMARY:Grandma visits
END:VEVENT
BEGIN:VEVENT
DTSTART:20261115T123000Z
DTEND:20261115T133000Z
SUMMARY:Speech session
END:VEVENT
END:VCALENDAR`;

test('the parser reads the real shapes a calendar exports', () => {
  const events = parseIcs(SAMPLE);
  assert.equal(events.length, 3);
  // zoned: 9:00 AM in Los Angeles, converted to the server's local clock
  assert.ok(/Therapy appointment/.test(events[0].summary));
  assert.ok(events[0].start_ts, 'zoned DTSTART became a timestamp');
  assert.equal(events[1].all_day, 1, 'VALUE=DATE is all-day');
  assert.equal(events[1].start_ts.slice(11, 13), '12', 'all-day events are pinned to noon local so the date groups once');
  assert.equal(events[2].location, '');
  // the Google folding quirk: long lines arrive wrapped
  const folded = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:a very long summary that\r\n  was folded by the exporter\r\nDTSTART:20261115T123000Z\r\nEND:VEVENT\r\nEND:VCALENDAR');
  assert.equal(folded[0].summary, 'a very long summary that was folded by the exporter');
});
test('the parser is bounded and refuses garbage', () => {
  // a malformed date drops that event but never refuses a family's whole calendar
  assert.deepEqual(parseIcs('BEGIN:VEVENT\r\nDTSTART:notadate\r\nEND:VEVENT'), []);
  assert.throws(() => parseIcs('x'.repeat(600000)), /too large/);
  const many = Array.from({ length: 600 }, (_, i) => `BEGIN:VEVENT\r\nDTSTART:20261115T123000Z\r\nUID:${i}\r\nEND:VEVENT`).join('\r\n');
  assert.throws(() => parseIcs(`BEGIN:VCALENDAR\r\n${many}\r\nEND:VCALENDAR`), /too many events/);
});
test('DTSTART conversion: UTC, floating, and zoned all land in the local clock', () => {
  const utc = icsDateToTs('20261115T123000Z');
  const floating = icsDateToTs('20261115T123000');
  const zoned = icsDateToTs('20261110T090000', 'America/Los_Angeles');
  assert.match(utc, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(floating, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(zoned, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.notEqual(utc, zoned, 'a zoned time and a UTC time are different instants unless the zone is UTC');
});
test('the SSRF guard: private networks are refused, loopback and public names are fine', () => {
  assert.equal(hostAllowed('127.0.0.1'), true, 'loopback allowed (test feeds)');
  assert.equal(hostAllowed('169.254.169.254'), false, 'cloud metadata refused');
  assert.equal(hostAllowed('10.1.2.3'), false);
  assert.equal(hostAllowed('192.168.1.1'), false);
  assert.equal(hostAllowed('172.20.1.9'), false);
  assert.equal(hostAllowed('100.64.0.1'), false, 'tailscale range refused');
  assert.equal(hostAllowed('calendar.google.com'), true);
  assert.equal(hostAllowed('myboard.example.org'), true);
});

// ---- the full save → sync → kiosk flow with a local feed server ----
process.env.DB_PATH = ':memory:';
const { server, db, store } = require('./server.js');
let base, cookie, feedServer, feedBody, feedStatus = 200;
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  feedServer = http.createServer((rq, rs) => { rs.writeHead(feedStatus, { 'content-type': 'text/calendar' }); rs.end(feedBody || SAMPLE); });
  await new Promise(r => feedServer.listen(0, '127.0.0.1', r));
  const s = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  cookie = s.headers.get('set-cookie').split(';')[0];
});
test.after(() => { server.close(); feedServer.close(); });
const api = async (method, p, body, hdr = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie, ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('saving a feed fetches, parses, and stores the events', async () => {
  const r = await api('PUT', '/api/admin/calendar-feed', { url: feedServer && `http://127.0.0.1:${feedServer.address().port}/cal.ics` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.count >= 3, `got ${r.body.count} events`);
  const st = await api('GET', '/api/admin/calendar-feed');
  assert.equal(st.body.configured, true);
  assert.ok(st.body.url_prefix.endsWith('…'), 'the full URL never comes back — it is a secret-ish credential');
  assert.ok(st.body.count >= 3);
});
test('the kiosk sees the events on its week', async () => {
  const t = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': (await api('POST', '/api/admin/kiosk-devices', { label: 'K' })).body.token } }).then(r => r.json());
  assert.ok(Array.isArray(t.events), 'the kiosk payload carries the feed events');
  assert.ok(t.events.every(e => e.summary), 'each has a summary');
  assert.ok(t.events.length >= 2, 'the feed window includes something soon');
});
test('a broken feed keeps the last good events and says what happened', async () => {
  feedStatus = 500;
  const r = await api('PUT', '/api/admin/calendar-feed', { url: `http://127.0.0.1:${feedServer.address().port}/cal.ics` });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /500/);
  const st = await api('GET', '/api/admin/calendar-feed');
  assert.ok(st.body.error, 'the error is visible to the family');
  assert.ok(st.body.count >= 3, 'the last good events stay on the kiosk');
  feedStatus = 200;
});
test('clearing the feed removes the events', async () => {
  const r = await api('PUT', '/api/admin/calendar-feed', { url: '' });
  assert.equal(r.body.cleared, true);
  const st = await api('GET', '/api/admin/calendar-feed');
  assert.equal(st.body.configured, false);
  assert.equal(st.body.count, 0);
  const t = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': (await api('POST', '/api/admin/kiosk-devices', { label: 'K2' })).body.token } }).then(r => r.json());
  assert.deepEqual(t.events, []);
});
