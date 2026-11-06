'use strict';
// ---- 0024: calendar subscriptions — the zero-dependency half ----
// Private iCal feeds (Apple Calendar, Google Calendar, anything CalDAV-ish)
// pulled by the board: parse the events, keep them in a bounded window,
// display them on the kiosk's calendar band. Read-only by construction: the
// board PULLS a feed URL — no tokens, no write access, nothing to revoke
// but the family's own link. Trust analysis: docs/integrations.md.
const crypto = require('node:crypto');

const LIMITS = { maxBytes: 512 << 10, maxEvents: 500, windowDaysPast: 1, windowDaysFuture: 60 };

// ---------- time helpers ----------
// ICS wall-clock forms: 20260105 (all day), 20260105T090000 (floating),
// 20260105T090000Z (UTC), 20260105T090000 with TZID=… (zoned — the wall
// clock is in that zone; Node's full ICU converts it).
function zonedToInstant(y, mo, d, hh, mm, tz) {
  // Round-trip through Intl: format a guess in the zone, compare to the
  // wanted wall clock, correct. Converges for every real-world offset.
  let t = Date.UTC(y, mo - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
    const shown = (Number(parts.month) * 525600) + (Number(parts.day) * 1440) + (Number(parts.hour) * 60) + Number(parts.minute);
    const want = (mo * 525600) + (d * 1440) + (hh * 60) + mm;
    const diff = (want - shown) * 60000;
    if (!diff) break;
    t += diff;
  }
  return t;
}

// Everything the board stores is the server's local wall clock — the same
// string format the rest of the schema uses.
function instantToTs(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const icsDateToTs = (v, tz) => {
  let s = v.trim();
  const allDay = /^20\d{6}$/.test(s);
  let y, mo, d, hh = 0, mm = 0;
  if (allDay) { y = +s.slice(0, 4); mo = +s.slice(4, 6); d = +s.slice(6, 8); }
  else {
    s = s.slice(0, 15);
    y = +s.slice(0, 4); mo = +s.slice(4, 6); d = +s.slice(6, 8); hh = +s.slice(9, 11); mm = +s.slice(11, 13);
    if ([y, mo, d, hh, mm].some(Number.isNaN) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (v.endsWith('Z')) return instantToTs(Date.UTC(y, mo - 1, d, hh, mm));
    if (tz) return instantToTs(zonedToInstant(y, mo, d, hh, mm, tz));
    return instantToTs(new Date(y, mo - 1, d, hh, mm).getTime());   // floating: server-local
  }
  if ([y, mo, d].some(Number.isNaN) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return instantToTs(new Date(y, mo - 1, d, 12).getTime());
};

// ---------- the parser ----------
// A hostile feed must not hang the board: bounded unfold, bounded events,
// and only the properties the board renders.
function parseIcs(text) {
  if (typeof text !== 'string' || text.length > LIMITS.maxBytes) throw new Error('feed too large');
  // Unfold per RFC 5545: a line starting with a space/tab continues the last.
  const raw = text.split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') {
      if (ev && ev.dtstart) {
        events.push({
          uid: ev.uid || crypto.createHash('sha256').update(ev.summary || ev.dtstart).digest('base64url').slice(0, 32),
          summary: ev.summary || '(event)',
          location: ev.location || '',
          start_ts: ev.dtstart, all_day: ev.all_day ? 1 : 0, end_ts: ev.dtend || null,
        });
      }
      ev = null;
      if (events.length > LIMITS.maxEvents) throw new Error('feed has too many events');
      continue;
    }
    if (!ev) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).toUpperCase();
    const val = line.slice(colon + 1).trim();
    if (key.startsWith('DTSTART')) {
      ev.dtstart = icsDateToTs(val, /TZID=([^;:]+)/.exec(key)?.[1]);
      ev.all_day = key.includes('VALUE=DATE') || /^\d{8}(:|$)/.test(val.trim());
    } else if (key.startsWith('DTEND')) ev.dtend = icsDateToTs(val, /TZID=([^;:]+)/.exec(key)?.[1]);
    else if (key === 'SUMMARY') ev.summary = val.replace(/\\,/g, ',').replace(/\\n/g, ' ').slice(0, 120);
    else if (key === 'LOCATION') ev.location = val.replace(/\\,/g, ',').slice(0, 120);
    else if (key === 'UID') ev.uid = val.slice(0, 120);
  }
  return events;
}

// ---------- the fetcher ----------
// SSRF guard: the URL is family-supplied, so the board refuses anything that
// points at its own network — every scheme must be http(s), and the host may
// not be a private/link-local address literal (the loopback is allowed: that
// is where test feeds and same-machine services live). Redirects are
// followed by hand so every hop is re-checked.
function hostAllowed(host) {
  if (/[.@]/.test(host) && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.includes('.')) {
    if (/\.local$|\.home\.arpa$/i.test(host)) return false;
    return true;   // a resolvable public name — DNS checks are best-effort (documented)
  }
  if (/^localhost$/i.test(host) || host === '::1' || host.startsWith('127.')) return true;
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^0\.|^127\.|^\[::1\]|^\[fe80|^\[fd|^100\.(6[4-9]|[7-9]\d)|^100\.1[01]|^100\.12[0-7]\./.test(host)) return false;
  return true;
}
async function fetchFeed(url, { maxRedirects = 3 } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('that is not a URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) feeds');
  for (let hop = 0; ; hop++) {
    if (!hostAllowed(u.hostname)) throw new Error('that host is not reachable from the board by policy');
    const r = await fetch(u, { redirect: 'manual', headers: { accept: 'text/calendar, text/plain; q=0.5, */*; q=0.1' }, signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      if (hop >= maxRedirects) throw new Error('too many redirects');
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`redirect without a destination (${r.status})`);
      u = new URL(loc, u);
      continue;
    }
    if (!r.ok) throw new Error(`the calendar returned ${r.status}`);
    const body = await r.text();
    if (body.length > LIMITS.maxBytes) throw new Error('feed too large');
    return body;
  }
}

const withinWindow = (startTs, now) => {
  const t = new Date(startTs.replace(' ', 'T'));
  const lo = new Date(now); lo.setDate(lo.getDate() - LIMITS.windowDaysPast);
  const hi = new Date(now); hi.setDate(hi.getDate() + LIMITS.windowDaysFuture);
  return t >= lo && t <= hi;
};

module.exports = { parseIcs, fetchFeed, hostAllowed, withinWindow, icsDateToTs, instantToTs, LIMITS };
