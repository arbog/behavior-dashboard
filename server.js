'use strict';
// behavior-dashboard: one family's behavior board in one app.
//
// Surfaces (one host):
//   /                    kiosk — the day the child taps. Data is gated by a
//                              kiosk token (GET/POST /api/today*, x-kiosk-token
//                              header or ?token=); the page shell itself is
//                              public, every byte of board data is not.
//   /admin, /api/admin/* parent console. Gated by an admin password
//                              (scrypt hash) with cookie sessions, login
//                              rate-limit + lockout, and per-IP API limits.
//   /healthz             liveness + DB probe (+ whether the store is
//                              encrypted). The only fully open endpoint;
//                              it leaks nothing.
//
// Zero npm dependencies: node:http + node:sqlite + node:crypto (Node >= 22.13).
// All board copy that was ever hardcoded (battery bands, reward lines, the
// protocol text, the check-in interval, the child's name) lives in the
// `settings` table and is editable in /admin — the seeds below are neutral
// starting points, not anyone's actual program.

const http = require('node:http');
const fs = require('node:fs');
const { b64u, b64uToBuf, sha256: wSha256, cborDecode, coseKey, parseAuthData, newChallenge, takeChallenge, checkClientData } = require('./webauthn.js');
const { PROVIDERS: OAUTH_PROVIDERS, cfgFor: oauthCfgFor } = require('./oauth.js');
const { parseIcs, fetchFeed: fetchIcsFeed, withinWindow: icsWithinWindow } = require('./ics.js');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'board.db');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
// SECURE_COOKIES=1: the app is served over TLS (PaaS, Cloudflare Tunnel,
// reverse proxy). Sets the Secure flag on session cookies and sends HSTS.
// Leave it unset for plain-HTTP LAN deploys, where a Secure cookie would
// break the console.
const SECURE = process.env.SECURE_COOKIES === '1';
// Shown in /healthz and stamped on exports so a family always knows which
// build produced (or can read back) their data. The Docker image copies
// package.json for exactly this.
const VERSION = (() => { try { return require('./package.json').version || 'unknown'; } catch { return 'unknown'; } })();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// The data directory is a child's behavioral record. A permissive umask on a
// bare-Node start would leave it world-readable. Tighten it at boot, best-effort:
// a filesystem that refuses the chmod (or a platform where it is meaningless)
// must warn, not fail to boot.
function secureDataFiles() {
  if (DB_PATH === ':memory:') return;
  const tryChmod = (p, mode) => {
    try { if (fs.existsSync(p)) fs.chmodSync(p, mode); }
    catch (e) { console.warn(`could not set ${mode.toString(8)} on ${p}: ${e.message}`); }
  };
  tryChmod(path.dirname(DB_PATH), 0o700);
  for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) tryChmod(p, 0o600);
}
secureDataFiles();

// ---- 0018: the store. Plaintext mode behaves exactly as before; with
// BD_PASSPHRASE set (and/or BD_ENCRYPTION=on) the data directory holds one
// encrypted blob, the working copy lives on tmpfs when possible, and a 30 s
// cadence + clean shutdown re-encrypt. See docs/research/encryption.md.
const { openStore } = require('./store.js');
const store = openStore({ dbPath: DB_PATH, log: console.log });
const db = store.db;
if (store.encrypted) {
  // Re-encrypt the working copy when it has changed since the last blob.
  // Honest bound: a kill -9 loses at most this much, and the boot
  // reconciliation recovers it if the working copy survived.
  const REENCRYPT_MS = 30000;
  setInterval(() => { try { store.persist(); } catch (e) { console.error('re-encrypt failed:', e.message); } }, REENCRYPT_MS).unref();
  const shutdown = sig => {
    console.log(`${sig}: persisting the encrypted database, then exiting`);
    try { store.close(); } catch (e) { console.error('shutdown persist failed:', e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
// Re-run after opening: SQLite may have created -wal/-shm on this call.
secureDataFiles();
db.exec(`
CREATE TABLE IF NOT EXISTS modes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '', color TEXT DEFAULT '#4f8cff',
  reward_all INTEGER DEFAULT 30, reward_one_x INTEGER DEFAULT 15, reward_two_x INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS mode_items (
  id INTEGER PRIMARY KEY, mode_id INTEGER NOT NULL REFERENCES modes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, start TEXT DEFAULT '', title TEXT NOT NULL, icon TEXT DEFAULT '',
  minutes INTEGER, note TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS weekday_modes (dow INTEGER PRIMARY KEY, mode_id INTEGER REFERENCES modes(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS choices (id INTEGER PRIMARY KEY, label TEXT NOT NULL, icon TEXT DEFAULT '', position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, mode_id INTEGER, mode_name TEXT, reward_all INTEGER DEFAULT 30, reward_one_x INTEGER DEFAULT 15, reward_two_x INTEGER DEFAULT 0,
  working_for TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS day_items (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE, position INTEGER NOT NULL,
  start TEXT DEFAULT '', title TEXT NOT NULL, icon TEXT DEFAULT '', minutes INTEGER, note TEXT DEFAULT '',
  finished INTEGER, rules TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS abc_options (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('A','B','C')), label TEXT NOT NULL, position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS abc_events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, antecedents TEXT, behaviors TEXT, consequences TEXT,
  note TEXT DEFAULT '', by TEXT DEFAULT '', severity INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT DEFAULT '', icon TEXT DEFAULT '', position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tools (id INTEGER PRIMARY KEY, label TEXT NOT NULL, icon TEXT DEFAULT '', position INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS battery_state (id INTEGER PRIMARY KEY CHECK(id=1), lines INTEGER NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS battery_events (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, delta INTEGER NOT NULL, lines INTEGER NOT NULL, reason TEXT DEFAULT '', by TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS check_ins (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, hunger INTEGER NOT NULL DEFAULT 0, boredom INTEGER NOT NULL DEFAULT 0,
  house INTEGER NOT NULL DEFAULT 0, battery INTEGER, note TEXT DEFAULT '', by TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tool_uses (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, tool_id INTEGER REFERENCES tools(id) ON DELETE SET NULL, date TEXT, by TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS day_plans (
  date TEXT PRIMARY KEY, mode_id INTEGER REFERENCES modes(id) ON DELETE SET NULL,
  kind TEXT DEFAULT 'plan', label TEXT DEFAULT '', note TEXT DEFAULT '', by TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  last_seen TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL,
  ip TEXT DEFAULT '', detail TEXT DEFAULT '', ok INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT DEFAULT '', revoked_at TEXT);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT DEFAULT '', revoked_at TEXT);
-- Passkeys (0015): a second way to mint the same session cookie. The password
-- stays the recovery path; the kiosk code is untouched. public_key is the
-- credential's JWK JSON; sign_count feeds the cloned-authenticator check.
CREATE TABLE IF NOT EXISTS passkeys (
  id INTEGER PRIMARY KEY, credential_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT 'passkey',
  public_key TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, aaid TEXT DEFAULT '',
  user_handle TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL, last_used_at TEXT DEFAULT '',
  revoked_at TEXT);
-- Consent artifacts (0017): the operator's acknowledgment that this machine
-- stores the child's behavioral data. Deliberately NOT deleted by the wipe —
-- a deletion record is the one thing a deletion request must leave behind.
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY, who TEXT NOT NULL, what TEXT NOT NULL, ip TEXT DEFAULT '', ts TEXT NOT NULL);
-- Requests (wave 6, research P2): what the child asked for, when. A tap on
-- the communication board is a voice, not a behavior — the log reads
-- "Sam said BREAK at 14:02", never an entry in the ABC form.
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, label TEXT NOT NULL, by TEXT DEFAULT 'kiosk');
-- OAuth identities (0023): a third way to obtain the same admin session —
-- the provider (Apple/Google) vouches for the PARENT's identity; no child
-- data ever leaves the board for it. Linked only by a signed-in parent;
-- sign-in works only for an already-linked identity.
-- Calendar subscription (0024): the parsed events from the family's
-- private iCal feed (Apple or Google — see docs/integrations.md). The
-- board pulls; nothing is ever pushed to the calendar.
CREATE TABLE IF NOT EXISTS calendar_events (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL, summary TEXT NOT NULL, location TEXT DEFAULT '',
  start_ts TEXT NOT NULL, end_ts TEXT, all_day INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS oauth_identities (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, sub TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, last_used_at TEXT DEFAULT '', revoked_at TEXT, UNIQUE(provider, sub));
`);

// Bounded audit trail: what happened to the board's keys and who touched it.
// Auth outcomes, admin writes, token rotation. Capped at the last 500 rows;
// an audit failure must never take the app down.
function logEvent(kind, ip, detail = '', ok = true) {
  try {
    db.prepare('INSERT INTO security_events(ts,kind,ip,detail,ok) VALUES(?,?,?,?,?)').run(tsNow(), kind, ip, clampStr(detail, 120), ok ? 1 : 0);
    db.prepare('DELETE FROM security_events WHERE id < (SELECT MAX(id) - 500 FROM security_events)').run();
  } catch (e) { console.error('security event log failed:', e.message); }
}

// Migrations for installs that predate a column.
function addColumn(table, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === ddl.split(/[\s(]/)[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('abc_events', 'severity INTEGER DEFAULT 0');
addColumn('day_items', 'rule_id INTEGER');
addColumn('days', "plan_label TEXT DEFAULT ''");
addColumn('days', "plan_note TEXT DEFAULT ''");
addColumn('days', "plan_kind TEXT DEFAULT ''");
// Self-report (research P3): the child's own 1–5 worry scale, tapped on the
// kiosk. Kept beside the parent-logged levels, attributed by='kiosk'.
addColumn('check_ins', 'self_report INTEGER');
// Consent artifacts gain their type and the consent contact (0020): the
// self-host acknowledgment vs the managed tier's COPPA VPC record.
addColumn('consents', 'kind TEXT DEFAULT \'self_host_ack\'');
addColumn('consents', 'contact TEXT DEFAULT \'\'');
addColumn('sessions', "last_seen TEXT DEFAULT ''");

// ---------- defaults (neutral starting points; all editable in /admin) ----------
const BATTERY_LINES = 5;
const BAND_MIN = [100, 80, 60, 0];   // battery -> band thresholds, worst band last
const DEFAULTS = {
  bands: [
    { name: 'Ready to go', color: '#34c38f', note: 'I am feeling good and in control.' },
    { name: 'Doing okay', color: '#fbbf24', note: 'I can keep going. I know my tools.' },
    { name: 'Feeling frustrated', color: '#f97316', note: 'I should use a tool now.' },
    { name: 'Big feelings', color: '#f87171', note: 'I need space, and a grown-up to help me calm down.' },
  ],
  rewards: [
    'When I finish my whole schedule, I get the big reward!',
    'If I am not listening or am being unsafe, I get an X on my schedule.',
    'When I get Xs, I get less reward time.',
    'The more checks I have, the more reward time I get!',
  ],
  protocol: {
    proactive: [
      'Check in every 1–2 hours while awake',
      'Review the battery together',
      'Spend 5–10 minutes in a preferred activity',
      'Catch good behavior — specific positive praise',
      'Before leaving: review the battery, expectations, and consequences',
    ],
    behavior: [
      'Name the rule that is not being followed',
      'Pause any reinforcement that may be going on (screen time, etc.)',
      'Remove one line from the battery',
      'Offer a check-in',
      'Once back to baseline, re-engage and review the battery',
      'Reinforcement resumes after a check-in AND using a tool',
    ],
    hold: 'If they are not ready, or the behavior continues, do not power-struggle. Remain available for support.',
    script_rule: '{name}, right now you are not following “{rule}”. When you are ready, we can talk about your battery.',
    script: 'When you are ready, we can talk about your battery.',
  },
  checkin_minutes: 120,
  waking: [7, 20],   // only nag about check-ins between 07:00 and 20:00
  rules: [
    ['I am gentle with things', 'It is not safe to throw or hit.', '🧸'],
    ['I use kind words', 'It is too loud to yell at other people.', '🗣️'],
    ['I use my tools for big feelings', 'They help me stay safe, calm, and in control.', '🔋'],
  ],
  tools: [['Break', '🧎'], ['Fidgets', '🌀'], ['Deep breaths', '🌬'], ['Ask for a hug', '🫂'],
    ['Use my words to ask', '💬'], ['Quiet space', '🛏️']],
  abc: {
    A: ['Asked to do something', 'Told no', 'Attention not directly being provided',
      'Transition away from something fun/preferred', 'Wants something that is not available'],
    B: ['Hitting', 'Kicking', 'Throwing', 'Yelling/Screaming', 'Riding the escalator without holding on'],
    C: ['Redirection to alternative choice/coping skills', 'No feedback provided (attention removed)',
      'Demand continues to be placed', 'Access given to a preferred item', 'Positive attention (calm, specific praise)'],
  },
};

// The blowup-risk model: levels are 0..3 per factor; weights tip the score.
// Factor names/labels/levels are settings too (factors_v1) so a program with
// different drivers can retune without a code change.
const DEFAULT_FACTORS = [
  { key: 'hunger', weight: 40, label: 'Hunger', icon: '🍽️', levels: ['Full', 'A little hungry', 'Hungry', 'Very hungry / has not eaten'] },
  { key: 'boredom', weight: 35, label: 'Boredom', icon: '🥱', levels: ['Engaged', 'Okay', 'Bored', 'Nothing to do'] },
  { key: 'house', weight: 25, label: 'House mess', icon: '🧹', levels: ['Calm', 'Tidy-ish', 'Messy', 'Chaos'] },
];
const LEVEL_POINTS = [0, 0.33, 0.66, 1];
const DEFAULT_BANDS_RISK = [
  { max: 25, name: 'Low', color: '#34c38f', action: 'All clear. Keep an eye on the clock for meals.' },
  { max: 50, name: 'Elevated', color: '#fbbf24', action: 'Offer a snack or start an activity.' },
  { max: 75, name: 'High', color: '#f97316', action: 'Intervene now: food + engagement + tidy the space.' },
  { max: 101, name: 'Critical', color: '#f87171', action: 'Reduce demands, quiet space, food immediately.' },
];

// Two templates a normal week doesn't have. Both keep the shape: an ordered
// list that can be crossed off — the free one drops the clock.
const FREE_DAY_ITEMS = [
  ['', 'Wake up & get dressed', '👕', null, ''],
  ['', 'Breakfast', '🥣', null, ''],
  ['', 'Help in the house', '🧺', 15, 'Laundry, set the table, feed the animals — anything counts'],
  ['', 'Outside time', '🌤️', 30, ''],
  ['', 'Free play', '🧱', null, 'Their choice of activity, on their own'],
  ['', 'Brush teeth', '🪥', null, ''],
  ['', 'Chill with the family', '🫶', 15, 'Board game, puzzle, walk — together'],
];
const TRIP_DAY_ITEMS = [
  ['', 'Pack my bag', '🎒', 10, ''],
  ['08:00', 'Breakfast', '🥣', 20, ''],
  ['09:00', 'Car seat & seatbelt', '🚗', 5, 'We leave once this is done'],
  ['', 'Car ride', '🎧', 30, ''],
  ['', 'Arrive & set up', '📍', 15, ''],
  ['', 'Outing time', '🌊', 60, 'Stay where a grown-up can see me'],
  ['12:00', 'Lunch', '🥪', 20, ''],
  ['', 'Quiet ride home', '😴', 30, 'Sleep is fine'],
  ['', 'Unpack & shower', '🚿', 15, ''],
];

// ---------- seed (editable in /admin; never overwrites parent edits) ----------
function seed() {
  if (!db.prepare('SELECT COUNT(*) c FROM modes').get().c) {
    const addMode = db.prepare('INSERT INTO modes(name,emoji,color,reward_all,reward_one_x,reward_two_x,sort) VALUES(?,?,?,?,?,?,?)');
    const addItem = db.prepare('INSERT INTO mode_items(mode_id,position,start,title,icon,minutes,note) VALUES(?,?,?,?,?,?,?)');
    const mk = (name, emoji, color, sort, items) => {
      const id = Number(addMode.run(name, emoji, color, 30, 15, 0, sort).lastInsertRowid);
      items.forEach((it, i) => addItem.run(id, i, it[0], it[1], it[2], it[3] ?? null, it[4] || ''));
      return id;
    };
    const school = mk('School Day', '🎒', '#4f8cff', 0, [
      ['07:00', 'Wake up & get dressed', '👕', 10], ['07:15', 'Breakfast', '🥣', 20],
      ['07:30', 'Get ready', '🧴', 10, 'Edit this to match your morning'], ['07:45', 'Shoes & backpack', '🎒', 5],
      ['08:00', 'Go to school', '🚌', null]]);
    const weekend = mk('Weekend', '🌞', '#34c38f', 1, [
      ['08:00', 'Wake up & get dressed', '👕', 10], ['08:15', 'Breakfast', '🥣', 20],
      ['08:30', 'Brush teeth', '🪥', 5]]);
    const free = mk('Free Day', '🛋', '#34c38f', 2, FREE_DAY_ITEMS.map(a => [a[0], a[1], a[2], a[3], a[4]]));
    const trip = mk('Trip Day', '🚗', '#f97316', 3, TRIP_DAY_ITEMS.map(a => [a[0], a[1], a[2], a[3], a[4]]));
    const wd = db.prepare('INSERT INTO weekday_modes(dow,mode_id) VALUES(?,?)');
    [[0, weekend], [1, school], [2, school], [3, school], [4, school], [5, weekend], [6, weekend]].forEach(r => wd.run(...r));
  }
  if (!getSetting('choices_v1')) {
    if (!db.prepare('SELECT COUNT(*) c FROM choices').get().c) {
      const ch = db.prepare('INSERT INTO choices(label,icon,position) VALUES(?,?,?)');
      [['iPad', '📱'], ['TV', '📺'], ['Playground', '🛝'], ['Legos', '🧱'], ['Special snack', '🍪']]
        .forEach((c, i) => ch.run(c[0], c[1], i));
    }
    setSetting('choices_v1', 1);
  }
  if (!db.prepare('SELECT COUNT(*) c FROM rules').get().c) {
    const add = db.prepare('INSERT INTO rules(title,body,icon,position) VALUES(?,?,?,?)');
    DEFAULTS.rules.forEach((r, i) => add.run(...r, i));
  }
  if (!db.prepare('SELECT COUNT(*) c FROM tools').get().c) {
    const add = db.prepare('INSERT INTO tools(label,icon,position) VALUES(?,?,?)');
    DEFAULTS.tools.forEach((t, i) => add.run(t[0], t[1], i));
  }
  batteryLines();
  if (!db.prepare('SELECT COUNT(*) c FROM abc_options').get().c) {
    const add = db.prepare('INSERT INTO abc_options(kind,label,position) VALUES(?,?,?)');
    for (const [k, arr] of Object.entries(DEFAULTS.abc)) arr.forEach((l, i) => add.run(k, l, i));
  }
  // One kiosk token per install: what the TV/iPad presents, what /admin rotates.
  if (!getSetting('kiosk_token')) setSetting('kiosk_token', crypto.randomBytes(24).toString('hex'));
}
// after helpers — seeding reads settings and stamps the battery

// ---------- settings ----------
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
const setSetting = (k, v) => v == null
  ? db.prepare('DELETE FROM settings WHERE key=?').run(k)
  : db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const getJSON = (k, fallback) => { try { const v = getSetting(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

const bands = () => getJSON('bands_v1', DEFAULTS.bands);
const rewards = () => getJSON('rewards_v1', DEFAULTS.rewards);
const protocol = () => ({ ...DEFAULTS.protocol, ...getJSON('protocol_v1', {}) });
const checkinMinutes = () => Number(getSetting('checkin_minutes')) > 0 ? Number(getSetting('checkin_minutes')) : DEFAULTS.checkin_minutes;
const factors = () => getJSON('factors_v1', DEFAULT_FACTORS);
const riskBands = () => getJSON('risk_bands_v1', DEFAULT_BANDS_RISK);
const childName = () => getSetting('child_name') || '';

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- day resolution ----------
// What's in effect for a date, in order of "someone meant this":
//   dated plan  >  today's manual override  >  weekday template.
const planFor = date => db.prepare('SELECT * FROM day_plans WHERE date=?').get(date) || null;
function resolveMode(date, dow) {
  const p = planFor(date);
  if (p?.mode_id) {
    const m = db.prepare('SELECT * FROM modes WHERE id=?').get(Number(p.mode_id));
    if (m) return { mode: m, source: 'plan', plan: p };
  }
  const ov = getSetting('override_mode_id');
  if (ov && getSetting('override_date') === date) {
    const m = db.prepare('SELECT * FROM modes WHERE id=?').get(Number(ov));
    if (m) return { mode: m, source: 'override', plan: p };
  }
  const wd = db.prepare('SELECT mode_id FROM weekday_modes WHERE dow=?').get(dow);
  const m = (wd?.mode_id && db.prepare('SELECT * FROM modes WHERE id=?').get(wd.mode_id)) || db.prepare('SELECT * FROM modes ORDER BY sort,id LIMIT 1').get();
  return { mode: m, source: 'weekday', plan: p };
}

// Snapshot the mode (and the plan's label) into the day so later template edits
// never rewrite history.
function buildDay(date, mode, keepWorkingFor = '', plan = null) {
  tx(() => {
    db.prepare('DELETE FROM days WHERE date=?').run(date);
    db.prepare('INSERT INTO days(date,mode_id,mode_name,reward_all,reward_one_x,reward_two_x,working_for,plan_label,plan_note,plan_kind) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(date, mode.id, mode.name, mode.reward_all, mode.reward_one_x, mode.reward_two_x, keepWorkingFor,
        plan?.label || '', plan?.note || '', plan?.kind || '');
    const ins = db.prepare('INSERT INTO day_items(date,position,start,title,icon,minutes,note,finished,rules,rule_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const it of db.prepare('SELECT * FROM mode_items WHERE mode_id=? ORDER BY position,id').all(mode.id))
      ins.run(date, it.position, it.start, it.title, it.icon, it.minutes, it.note, null, null, null);
  });
}
// The plan's name is a label on the day, not a new day. A day that has already
// been scored must still pick it up — no rebuild, no marks lost.
function syncPlanLabel(date, plan) {
  db.prepare('UPDATE days SET plan_label=?, plan_note=?, plan_kind=? WHERE date=?')
    .run(plan?.label || '', plan?.note || '', plan?.kind || '', date);
}
const dayIsMarked = date => !!db.prepare('SELECT 1 FROM day_items WHERE date=? AND (finished IS NOT NULL OR rules IS NOT NULL) LIMIT 1').get(date);
function ensureDay() {
  const { date, dow } = localParts();
  const want = resolveMode(date, dow);
  const have = db.prepare('SELECT 1 FROM days WHERE date=?').get(date);
  if (!have) { if (want.mode) buildDay(date, want.mode, '', want.plan); }
  else if (want.mode) {
    const cur = db.prepare('SELECT mode_id, plan_label, plan_note, plan_kind FROM days WHERE date=?').get(date);
    const changed = cur.mode_id !== want.mode.id || (cur.plan_label || '') !== (want.plan?.label || '')
      || (cur.plan_note || '') !== (want.plan?.note || '') || (cur.plan_kind || '') !== (want.plan?.kind || '');
    if (changed) {
      if (dayIsMarked(date)) syncPlanLabel(date, want.plan);
      else {
        const wf = db.prepare('SELECT working_for FROM days WHERE date=?').get(date)?.working_for || '';
        buildDay(date, want.mode, wf, want.plan);
      }
    }
  }
  return date;
}

// Token economy: each activity is a check or an X.
function itemStatus(it) {
  if (it.finished === 0 || it.rules === 'x') return 'x';
  if (it.finished === 1 && it.rules) return 'check';
  return 'pending';
}
function reward(day, items) {
  const st = items.map(itemStatus);
  const xs = st.filter(s => s === 'x').length;
  const pending = st.filter(s => s === 'pending').length;
  const minutes = xs === 0 ? day.reward_all : xs === 1 ? day.reward_one_x : day.reward_two_x;
  // `projected` answers "the more checks I have, the more time I get": what is
  // still on the table if the rest finishes clean. An X already on the board
  // caps the day — promising the all-checks payout to a day with an X is a lie.
  const projected = minutes;
  return { xs, pending, checks: st.filter(s => s === 'check').length, minutes, projected, final: pending === 0, tier: xs === 0 ? 'all' : xs === 1 ? 'one' : 'two' };
}

// ---------- timestamps ----------
const pad = n => String(n).padStart(2, '0');
function localParts(d = new Date()) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, dow: d.getDay(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
// Two views of the same state:
//   • the BATTERY is what the child sees — lines a grown-up removes and restores.
//   • the RISK SCORE (0-100) is what parents see — check-in factors over time.
// Second resolution: the pause/resume gate compares a tool use against the moment
// the pause started, and minute resolution makes "same minute" ambiguous.
const tsNow = () => { const p = localParts(); return `${p.date} ${p.time}:${pad(new Date().getSeconds())}`; };
const parseTs = s => new Date(String(s).replace(' ', 'T'));
const fmtTs = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const minsSince = ts => (ts ? Math.round((Date.now() - parseTs(ts)) / 60000) : null);

// ---------- battery / check-ins / pause ----------
function batteryLines() {
  const r = db.prepare('SELECT lines FROM battery_state WHERE id=1').get();
  if (!r) { db.prepare('INSERT INTO battery_state(id,lines,updated_at) VALUES(1,?,?)').run(BATTERY_LINES, tsNow()); return BATTERY_LINES; }
  return r.lines;
}
const batteryView = lines => {
  const pct = Math.round((100 * lines) / BATTERY_LINES);
  return { lines, max: BATTERY_LINES, pct, band: bands().find(b => pct >= b.min) || bands()[bands().length - 1], bands: bands() };
};
function batteryWrite(next, delta, reason, by) {   // no tx — safe to call inside one
  const lines = Math.max(0, Math.min(BATTERY_LINES, Math.round(Number(next) || 0)));
  db.prepare('INSERT INTO battery_state(id,lines,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET lines=excluded.lines, updated_at=excluded.updated_at').run(lines, tsNow());
  db.prepare('INSERT INTO battery_events(ts,delta,lines,reason,by) VALUES(?,?,?,?,?)').run(tsNow(), Math.round(delta || 0), lines, clampStr(reason, 120), clampStr(by, 40));
  return batteryView(lines);
}
const batterySet = (next, delta, reason, by) => tx(() => batteryWrite(next, delta, reason, by));

// 0-100 risk from a factor snapshot (0..3 per factor).
function riskFromLevels(l = {}) {
  const lv = k => Math.max(0, Math.min(3, Math.round(Number(l[k]) || 0)));
  const breakdown = factors().map(f => ({ ...f, level: lv(f.key), points: Math.round(f.weight * LEVEL_POINTS[lv(f.key)]) }));
  const total = breakdown.reduce((s, f) => s + f.points, 0);
  return { total, breakdown, band: riskBands().find(b => total < b.max) || riskBands()[riskBands().length - 1] };
}
const lastCheckIn = () => db.prepare('SELECT * FROM check_ins ORDER BY id DESC').get() || null;

// The proactive rule: check in every N minutes while the child is up.
function checkInStatus() {
  const { date } = localParts();
  const last = lastCheckIn();
  const mins = last ? minsSince(last.ts) : null;
  const [from, to] = DEFAULTS.waking;
  const d = new Date(), hour = d.getHours();
  const awake = hour >= from && hour < to;
  const elapsedMin = Math.max(0, Math.min(hour, to) * 60 + d.getMinutes() - from * 60);
  return {
    last, mins_since: mins, awake,
    due: awake && (mins == null || mins >= checkinMinutes()),
    overdue_mins: mins != null ? Math.max(0, mins - checkinMinutes()) : null,
    every_minutes: checkinMinutes(),
    today: db.prepare('SELECT COUNT(*) c FROM check_ins WHERE ts>=?').get(`${date} 00:00:00`).c,
    expected_today: Math.max(1, Math.floor(elapsedMin / checkinMinutes())),
  };
}

// "Pause any reinforcement that may be going on" — one flag the kiosk respects.
// The rule for lifting it: a check-in AND a tool.
function pauseState() {
  const ts = getSetting('pause_ts');
  if (!ts) return { active: false, resume_ready: false };
  const until = getSetting('pause_until');
  if (until && parseTs(until) <= new Date()) { clearPause(); return { active: false, resume_ready: false }; }
  // Inclusive: a tap within the same second as the pause counts. Denying a
  // resume here would strand them paused with no way out but a parent's nudge.
  const tool_used = !!db.prepare('SELECT 1 FROM tool_uses WHERE ts>=? LIMIT 1').get(ts);
  const checked_in = !!db.prepare('SELECT 1 FROM check_ins WHERE ts>=? LIMIT 1').get(ts);
  return { active: true, since: ts, mins: minsSince(ts), reason: getSetting('pause_reason') || '', until: until || null,
    tool_used, checked_in, resume_ready: tool_used && checked_in };
}
function setPause(reason, minutes) {
  setSetting('pause_ts', tsNow()); setSetting('pause_reason', clampStr(reason, 120));
  setSetting('pause_until', minutes ? fmtTs(new Date(Date.now() + Number(minutes) * 60000)) : null);
  return pauseState();
}
function clearPause() { for (const k of ['pause_ts', 'pause_reason', 'pause_until']) setSetting(k, null); }

const todayRows = sql => db.prepare(`${sql} AND ts>=?`).all(`${localParts().date} 00:00:00`);

// The week ahead: today first, then what's coming, each day labelled.
function calendar(from = localParts().date, days = 7) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(`${from}T12:00:00`); d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const { mode, plan } = resolveMode(date, d.getDay());
    if (!mode) continue;
    out.push({
      date, dow: d.getDay(), day_name: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
      is_today: i === 0, kind: plan?.kind || (plan ? 'plan' : ''),
      label: plan?.label?.trim() || '', note: plan?.note || '',
      mode_id: mode.id, mode_name: mode.name, emoji: mode.emoji, color: mode.color, source: plan ? 'plan' : 'weekday',
    });
  }
  return out;
}

// ---- 0013: the board-capability model ----
// Every family gets the least board that serves their child — and the most
// only if they ask for it. A picture of the day (schedule + plans + choices)
// is the floor every profile keeps; these seven flags are the rest. The
// clinical profile names (research P1–P7, docs/research/child-profiles.md)
// live in code only — the UI speaks in what the board DOES for the child.
const CAPS = ['tools', 'rewards', 'battery', 'rules', 'abc', 'checkins', 'pause'];
const PROFILE_PRESETS = {
  standard:      { name: 'The full board',           blurb: 'The day, the battery, the rules, the plan when feelings get big — for a child working on regulation.', on: ['tools', 'rewards', 'battery', 'rules', 'abc', 'checkins', 'pause'] },
  communication: { name: 'A way to say things',      blurb: 'Big taps that say yes, no, break, and more — no scoring anywhere, just a voice.',               on: ['tools'] },
  anxiety:       { name: 'A calm, predictable day',  blurb: 'The day they can see coming, and a calm-down plan instead of a discipline battery.',             on: ['tools', 'checkins'] },
  transitions:   { name: 'Tasks made possible',      blurb: 'First-then clarity and a light reward — for the child who struggles to start and finish.',      on: ['tools', 'rewards'] },
  sensory:       { name: 'A calmer screen',          blurb: 'Breaks built into the day and a sensory kit — no X marks, no scoring.',                        on: ['tools'] },
  routines:      { name: 'A kind checklist',         blurb: 'Routines, hygiene, sleep — a gentle checklist day with a small reward.',                        on: ['rewards'] },
  gentle:        { name: 'The day, not the mistakes', blurb: 'The day, what they are working for, all-done joy — nothing behavior-protocol at all.',          on: ['rewards'] },
};
// Choices are the floor's voice (every profile enables them); schedule, plans
// and the calendar are unconditional too.
const profileFlags = id => {
  const f = Object.fromEntries(['choices', 'requests', ...CAPS].map(c => [c, false]));   // choices: the floor's voice
  f.choices = true;
  f.requests = (PROFILE_PRESETS[id] || PROFILE_PRESETS.standard) === PROFILE_PRESETS.communication;   // P2: taps are requests
  (PROFILE_PRESETS[id] || PROFILE_PRESETS.standard).on.forEach(c => { f[c] = true; });
  return f;
};
// The live profile: the chosen preset, refined by any explicit per-flag
// overrides a family has made. Survives a preset switch by design: switching
// a preset resets the flags, an explicit map replaces them.
function profile() {
  const id = PROFILE_PRESETS[getSetting('profile_id')] ? getSetting('profile_id') : 'standard';
  let flags = profileFlags(id);
  try { flags = { ...flags, ...(JSON.parse(getSetting('profile_overrides') || '{}')) }; } catch {}
  return { id, ...flags };
}
const cap = c => profile()[c];
// A capability-specific endpoint on a board whose profile dropped that part is
// not a bug to debug — it is 404, the same shape as an unknown route.
const need = (c, res) => cap(c) ? null : json(res, 404, { error: 'that part of the board is switched off in this profile' });

// The parsed feed's events for today ± 7 days, grouped by local date —
// what the kiosk calendar band can mark.
function calendarEvents(date) {
  const lo = new Date(date + 'T12:00:00'); const out = [];
  for (let i = -1; i <= 7; i++) {
    const d = new Date(lo); d.setDate(d.getDate() + i);
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    for (const e of db.prepare('SELECT uid,summary,location,start_ts,all_day FROM calendar_events WHERE start_ts LIKE ? ORDER BY start_ts').all(day + ' %'))
      out.push({ date: day, summary: e.summary, location: e.location, all_day: e.all_day, start: e.start_ts });
  }
  return out;
}

function todayPayload() {
  const date = ensureDay();
  const { time } = localParts();
  const day = db.prepare('SELECT * FROM days WHERE date=?').get(date);
  const items = day ? db.prepare('SELECT * FROM day_items WHERE date=? ORDER BY position,id').all(date) : [];
  const mode = day ? db.prepare('SELECT id,name,emoji,color FROM modes WHERE id=?').get(day.mode_id) : null;
  const choices = db.prepare('SELECT label,icon FROM choices ORDER BY position,id').all();
  const rules = db.prepare('SELECT id,title,body,icon FROM rules ORDER BY position,id').all();
  const tools = db.prepare('SELECT id,label,icon FROM tools ORDER BY position,id').all();
  const used = new Set(todayRows('SELECT tool_id FROM tool_uses WHERE 1').map(r => r.tool_id));
  const b = cap('battery'), flags = profile();
  return {
    date, time, day, mode: mode || { name: day?.mode_name || '', emoji: '', color: '#4f8cff' },
    items: items.map(i => ({ ...i, status: itemStatus(i) })), reward: day ? reward(day, items) : null, choices,
    caps: flags, ...(!b ? {} : { battery: batteryView(batteryLines()) }), events: calendarEvents(date),
    rules: cap('rules') ? rules : [], tools: cap('tools') ? tools.map(t => ({ ...t, used: used.has(t.id) })) : [],
    ...(!b || !cap('pause') ? {} : { pause: pauseState() }), rewards: cap('rewards') ? rewards() : [], child_name: childName(),
    plan: day ? { label: day.plan_label || '', note: day.plan_note || '', kind: day.plan_kind || '' } : null,
    calendar: calendar(date, 7),
  };
}

// ---------- crypto / auth ----------
const hashPassword = pw => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `s2:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const verifyPassword = (pw, stored) => {
  if (typeof stored !== 'string' || !stored.startsWith('s2:')) return false;
  const [, salt, hex] = stored.split(':');
  const got = crypto.scryptSync(pw, salt, 64);
  return got.length === hex.length / 2 && crypto.timingSafeEqual(got, Buffer.from(hex, 'hex'));
};
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(p => p.trim().split(/=(.*)/)).filter(([k]) => k).map(([k, v]) => [k, decodeURIComponent(v)]));
const SESSION_DAYS = 30;
const COOKIE_SECURE = SECURE ? '; Secure' : '';

function newSession() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,expires_at,created_at) VALUES(?,?,?)')
    .run(sha256(token), fmtTs(new Date(Date.now() + SESSION_DAYS * 864e5)), tsNow());
  return `bd_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}` + COOKIE_SECURE;
}
const LOGOUT_COOKIE = 'bd_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + COOKIE_SECURE;

// A small, static blocklist: what people actually try first. Not a substitute
// for length and uniqueness — but "password123" should never get in.
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password1234', 'admin', 'admin1', 'admin123',
  'admin1234', 'admin12345', 'letmein', 'letmein123', 'qwerty', 'qwerty123', '111111',
  '12345678', '123456789', '1234567890', '12345678901', '12345678a', '1q2w3e4r', '1qaz2wsx',
  'iloveyou', 'dragon', 'monkey', 'master', 'shadow', 'sunshine', 'princess', 'football',
  'baseball', 'welcome', 'welcome1', 'login', 'pass123', 'abc123', 'changeme', 'secret',
  'secret123', 'trustno1', 'freedom', 'whatever', 'q1w2e3r4', 'zaq12wsx', 'ninja', 'mustang',
  'harley', 'ranger', 'hunter', 'killer', 'george', 'starwars', 'computer', 'internet',
  'michael', 'jordan', 'harmony', 'superman', 'batman', 'spiderman', 'pokemon', 'matrix',
  'behaviour', 'behavior', 'kiosk', 'kiosk123', 'board', 'board123', 'dashboard', 'baby',
  'baby123', 'child', 'autism', 'aba', 'therapy', 'school', 'family', 'love', 'angel',
  'hello', 'hello123', 'charlie', 'maggie', 'ginger', 'summer', 'winter', 'spring', 'autumn',
]);
const weakPassword = pw => { const p = String(pw || '').trim().toLowerCase(); return p.length < 8 || WEAK_PASSWORDS.has(p); };
const SESSION_SEEN = new Map();   // token_hash -> ts of last throttled last_seen write
function sessionUser(req) {
  const t = parseCookies(req).bd_session;
  if (!t) return null;
  const hash = sha256(t);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash);
  if (!row) return null;
  if (parseTs(row.expires_at) <= new Date()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash); return null; }
  // Throttled liveness: "signed-in devices" is only useful if last_seen is
  // fresh, but a write per request would churn the WAL for every poll.
  const now = Date.now();
  if (now - (SESSION_SEEN.get(hash) || 0) > 60000) {
    SESSION_SEEN.set(hash, now);
    try { db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(tsNow(), hash); } catch {}
  }
  return 'admin';
}
function adminAuthed(req) { return !!sessionUser(req); }

// API keys: admin-scoped automation credentials (Authorization: Bearer bdb_…
// or x-api-key:). They never touch the kiosk surface. Resolved only when no
// session cookie is valid — a logged-in browser is unaffected by them.
const API_KEYS_MAX = 5;
const apiKeySeen = new Map();   // id -> ts of last throttled last_used write
function resolveApiKey(req) {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    || String(req.headers['x-api-key'] || '').trim();
  if (!raw.startsWith('bdb_')) return null;
  const got = Buffer.from(sha256(raw), 'hex');
  for (const k of db.prepare('SELECT id, name, key_hash FROM api_keys WHERE revoked_at IS NULL').all()) {
    const stored = Buffer.from(k.key_hash, 'hex');
    if (stored.length === got.length && crypto.timingSafeEqual(stored, got)) {
      const now = Date.now();
      if (now - (apiKeySeen.get(k.id) || 0) > 60000) {
        apiKeySeen.set(k.id, now);
        try { db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(tsNow(), k.id); } catch {}
      }
      return { id: k.id, name: k.name };
    }
  }
  return null;
}
function kioskAuthed(req, url) {
  // The header is always accepted. The query string is only accepted for the
  // kiosk's initial GET /api/today — the deep-link affordance, and the one
  // place the code may appear in a URL (and therefore in proxy logs). Every
  // write must carry the header, so taps never log the credential.
  const presented = String(req.headers['x-kiosk-token'] ||
    (req.method === 'GET' && url.pathname === '/api/today' ? url.searchParams.get('token') : null) || '').trim();
  if (!presented) return false;
  const got = Buffer.from(sha256(presented), 'hex');
  // Compare against every live device's stored hash. Timing-safe per row; a
  // household has single-digit devices, so the row count is not a timing leak.
  for (const d of db.prepare('SELECT id, token_hash FROM kiosk_devices WHERE revoked_at IS NULL').all()) {
    const stored = Buffer.from(d.token_hash, 'hex');
    if (stored.length === got.length && crypto.timingSafeEqual(stored, got)) {
      noteKioskUse(d.id);
      return true;
    }
  }
  return false;
}

// Per-device "last used": the console shows the TV/iPad talking to the board,
// and per-device is how a parent spots an unknown one. Throttled to one write
// per 60s per device — the kiosk polls every 8 seconds.
const kioskSeen = new Map();   // device id -> ts of last throttled write
function noteKioskUse(deviceId, ip = '') {
  const now = Date.now();
  if (now - (kioskSeen.get(deviceId) || 0) < 60000) return;
  kioskSeen.set(deviceId, now);
  try { db.prepare('UPDATE kiosk_devices SET last_used_at=? WHERE id=?').run(tsNow(), deviceId); } catch {}
}
const KIOSK_DEVICES_MAX = 8;
function newKioskDevice(label) {
  const token = crypto.randomBytes(24).toString('hex');
  const id = Number(db.prepare('INSERT INTO kiosk_devices(label,token_hash,created_at,last_used_at) VALUES(?,?,?,?)')
    .run(clampStr(label, 40) || 'Kiosk', sha256(token), tsNow(), '').lastInsertRowid);
  return { id, token };
}

// In-memory sliding-window rate limits (per install; the app is single-user).
const limits = new Map();
const LIMIT_KEYS_MAX = 4096;   // bound the map: keys are attacker-influenced IPs
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (limits.get(key) || []).filter(t => now - t < windowMs);
  // An exposed board sees distinct source addresses forever; without a sweep
  // the Map grows without bound (one small array per IP, never evicted).
  if (limits.size > LIMIT_KEYS_MAX) sweepLimits(now);
  if (arr.length >= limit) { limits.set(key, arr); return false; }
  arr.push(now); limits.set(key, arr);
  return true;
}
function sweepLimits(now = Date.now()) {
  // 60 s is the widest window any caller uses; an entry whose newest hit is
  // older than that contributes nothing and can go.
  for (const [k, arr] of limits) if (!arr.length || now - arr[arr.length - 1] > 60000) limits.delete(k);
  for (const [k, l] of lockouts) if (l.until > 0 && l.until <= now) lockouts.delete(k);
}
const LOGIN_RATE_LIMIT = Math.max(1, Number(process.env.LOGIN_RATE_LIMIT) || 10);
const lockouts = new Map();   // key -> { n, until }
function loginAllowed(ip) {
  const l = lockouts.get(ip);
  if (l && l.until > Date.now()) return { ok: false, until: l.until };
  // until=0 means "never locked", not "lockout expired": deleting here would
  // wipe the failure counter on every check and the lockout could never arm.
  if (l && l.until > 0 && l.until <= Date.now()) lockouts.delete(ip);
  return { ok: true };
}
function loginFailed(ip) {
  const l = lockouts.get(ip) || { n: 0, until: 0 };
  l.n += 1;
  if (l.n >= 5) { l.until = Date.now() + 15 * 60000; l.n = 0; }
  lockouts.set(ip, l);
}
// Trust X-Forwarded-For only when the direct peer is private/loopback — i.e.
// when the app is behind a proxy it can actually see (LAN reverse proxy, PaaS
// sidecar, Tailscale). A directly-exposed board must ignore a client-supplied
// header, or the per-IP limits become trivially evadable by rotating it.
function isPrivateAddr(a) {
  if (!a) return false;
  const s = String(a).toLowerCase().replace(/^::ffff:/, '');
  if (s === '::1' || s === '127.0.0.1' || s.startsWith('127.')) return true;
  if (s.startsWith('10.') || s.startsWith('192.168.')) return true;
  if (s.startsWith('100.')) {                      // 100.64.0.0/10 (Tailscale)
    const o2 = Number(s.split('.')[1]);
    if (o2 >= 64 && o2 <= 127) return true;
  }
  if (s.startsWith('172.')) {                      // 172.16.0.0/12
    const o2 = Number(s.split('.')[1]);
    if (o2 >= 16 && o2 <= 31) return true;
  }
  if (s.startsWith('fc') || s.startsWith('fd')) return true;   // fc00::/7
  return false;
}
function clientIp(req) {
  const peer = req.socket?.remoteAddress || '';
  if (isPrivateAddr(peer)) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return peer || 'unknown';
}

// ---------- kiosk API (token-gated) ----------
// Optional outbound notification (research item 9): when the child taps a
// request, a parent's phone can hear about it. Fire-and-forget with a hard
// timeout; a dead webhook must never block a child's tap.
async function notifyRequest(label) {
  const url = process.env.BD_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'request', label, child: childName(), ts: tsNow() }), signal: AbortSignal.timeout(5000) }); }
  catch {}
}
function kiosk(req, res, url, body) {
  if (!kioskAuthed(req, url)) return json(res, 401, { error: 'kiosk token required' });
  noteKioskUse(clientIp(req));
  let m;
  if (req.method === 'GET' && url.pathname === '/api/today') return json(res, 200, todayPayload());
  // The child taps an activity: finished (toggle back allowed until a parent scores the rules).
  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/today\/items\/(\d+)\/finish$/))) {
    const date = ensureDay();
    const it = db.prepare('SELECT * FROM day_items WHERE id=? AND date=?').get(Number(m[1]), date);
    if (!it) return json(res, 404, { error: 'not found' });
    db.prepare("UPDATE day_items SET finished=?, updated_at=datetime('now','localtime') WHERE id=?").run(body.done === false ? null : 1, it.id);
    return json(res, 200, todayPayload());
  }
  if (req.method === 'POST' && url.pathname === '/api/today/choice') {
    db.prepare('UPDATE days SET working_for=? WHERE date=?').run(clampStr(body.label, 80), ensureDay());
    return json(res, 200, todayPayload());
  }
  // A tap that SAYS something (research P2): on the communication board the
  // choice buttons are requests. Logged as what the child asked for — never
  // a behavior — and, when BD_WEBHOOK_URL is set, pushed to the parent.
  if (req.method === 'POST' && url.pathname === '/api/today/request') {
    const greq = need('requests', res); if (greq) return greq;
    if (!rateLimit('kiosk-req:' + clientIp(req), 60, 60000)) return json(res, 429, { error: 'too many requests' });
    const label = clampStr(body.label, 80);
    const known = db.prepare('SELECT label FROM choices ORDER BY position,id').all().some(c => c.label === label);
    if (!known) return json(res, 400, { error: 'not a button on this board' });
    db.prepare("INSERT INTO requests(ts,label,by) VALUES(?,?,'kiosk')").run(tsNow(), label);
    notifyRequest(label);   // fire-and-forget: a dead webhook never delays a child's tap
    return json(res, 200, { ok: true, ts: tsNow() });
  }
  // The child's own check-in (research P3): a 1–5 worry scale tapped on the
  // kiosk. It is a check-in like any other — attributed by='kiosk' — and it
  // counts toward a pause resume exactly as a parent's does.
  if (req.method === 'POST' && url.pathname === '/api/today/checkin') {
    const gchk = need('checkins', res); if (gchk) return gchk;
    const level = toInt(body.level);
    if (level == null || level < 1 || level > 5) return json(res, 400, { error: 'level must be 1 through 5' });
    if (!rateLimit('kiosk-chk:' + clientIp(req), 30, 60000)) return json(res, 429, { error: 'too many requests' });
    db.prepare("INSERT INTO check_ins(ts,hunger,boredom,house,self_report,by) VALUES(?,0,0,0,?,'kiosk')").run(tsNow(), level);
    return json(res, 200, { ok: true });
  }
  // Tapping a tool is a tool use: it counts toward the rule that reinforcement
  // resumes only after a check-in AND a tool — the one thing to reach for.
  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/today\/tools\/(\d+)\/use$/))) {
    const gtooK = need('tools', res); if (gtooK) return gtooK;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(Number(m[1]));
    if (!tool) return json(res, 404, { error: 'not found' });
    db.prepare('INSERT INTO tool_uses(ts,tool_id,date,by) VALUES(?,?,?,?)').run(tsNow(), tool.id, localParts().date, clampStr(body.by, 40) || childName() || 'kiosk');
    const p = todayPayload();
    return json(res, 200, { ...p, just_used: { label: tool.label, icon: tool.icon }, calm: p.pause?.active
      ? 'Nice. A grown-up can turn the fun back on once you have checked in.' : '' });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- admin API ----------
const modeWithItems = m => ({ ...m, items: db.prepare('SELECT id,position,start,title,icon,minutes,note FROM mode_items WHERE mode_id=? ORDER BY position,id').all(m.id) });
const fillT = (t, vals) => String(t || '').replace('{name}', vals.name).replace('{rule}', vals.rule);

// The regulation state in one shape: battery, pause, check-in clock, risk,
// lists, and the editable protocol copy.
function regulation() {
  const p = protocol();
  return {
    battery: batteryView(batteryLines()), pause: pauseState(), check_in: checkInStatus(),
    risk: riskFromLevels(lastCheckIn() || {}), has_check_in: !!lastCheckIn(),
    rules: db.prepare('SELECT id,title,body,icon FROM rules ORDER BY position,id').all(),
    tools: db.prepare('SELECT id,label,icon FROM tools ORDER BY position,id').all(),
    battery_events: db.prepare('SELECT ts,delta,lines,reason,by FROM battery_events WHERE ts>=? ORDER BY ts DESC').all(`${localParts().date} 00:00:00`),
    protocol: p, script: p.script,
    factors: factors(), bands: riskBands(),
    resume_note: pauseState().active && pauseState().resume_ready ? 'They have checked in and used a tool — reinforcement can resume.' : null,
  };
}

// The patterns layer: what actually precedes a blowup, when the day is worst,
// and which rule breaks most.
function riskStats(days) {
  const since = `${localParts(new Date(Date.now() - days * 864e5)).date} 00:00:00`;
  const ins = db.prepare('SELECT * FROM check_ins WHERE ts>=? ORDER BY ts').all(since);
  const score = r => riskFromLevels(r).total;
  const avg = rows => rows.length ? +(rows.reduce((s, r) => s + score(r), 0) / rows.length).toFixed(1) : null;
  const byHour = Array(24).fill(0).map(() => ({ sum: 0, n: 0 }));
  for (const r of ins) { const h = Number(r.ts.slice(11, 13)); if (!Number.isNaN(h)) { byHour[h].sum += score(r); byHour[h].n++; } }
  // Severity 0 is the ABC form's "note only" — a note is not a blowup, so it
  // stays in the log but out of the blowup analytics.
  const blowups = "AND (severity IS NULL OR severity >= 1)";
  const behaviors = db.prepare(`SELECT * FROM abc_events WHERE ts>=? ${blowups} AND behaviors IS NOT NULL AND behaviors NOT IN ('[]','') ORDER BY ts`).all(since)
    .map(r => ({ ...r, antecedents: JSON.parse(r.antecedents || '[]'), behaviors: JSON.parse(r.behaviors || '[]'), consequences: JSON.parse(r.consequences || '[]') }));
  // Leading indicators: factor levels in the 2h before each behavior vs baseline.
  const pre = db.prepare(`SELECT c.* FROM check_ins c JOIN abc_events e ON c.ts BETWEEN datetime(e.ts,'-2 hours') AND e.ts WHERE e.behaviors NOT IN ('[]','') ${blowups} AND e.ts>=?`).all(since);
  const prof = rows => ({ samples: rows.length, hunger: avgCol(rows, 'hunger'), boredom: avgCol(rows, 'boredom'), house: avgCol(rows, 'house') });
  const preProfile = pre.length ? prof(pre) : null;
  const baseline = prof(ins);
  const combos = {};
  for (const e of behaviors) for (const a of e.antecedents) for (const b of e.behaviors) {
    const k = `${a} → ${b}`; combos[k] = (combos[k] || 0) + 1;
  }
  const tally = pick => behaviors.flatMap(pick).reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
  const sortTally = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const hourOf = ts => Number(String(ts).slice(11, 13));
  const behByHour = Array(24).fill(0);
  behaviors.forEach(e => { const h = hourOf(e.ts); if (!Number.isNaN(h)) behByHour[h]++; });
  const lastBehavior = behaviors.length ? behaviors[behaviors.length - 1].ts : null;
  return {
    days,
    timeline: ins.map(r => ({ ts: r.ts, by: r.by, battery: r.battery, total: score(r), hunger: r.hunger, boredom: r.boredom, house: r.house })),
    by_hour: byHour.map((b, h) => ({ hour: h, avg: b.n ? +(b.sum / b.n).toFixed(1) : null })),
    behavior_by_hour: behByHour,
    peak_hour: behaviors.length ? behByHour.indexOf(Math.max(...behByHour)) : null,
    behaviors: { count: behaviors.length, last: lastBehavior, days_since: lastBehavior ? Math.floor((Date.now() - parseTs(lastBehavior)) / 864e5) : null },
    pre_behavior: preProfile, baseline,
    deltas: preProfile ? {
      hunger: +(preProfile.hunger - (baseline.hunger || 0)).toFixed(2),
      boredom: +(preProfile.boredom - (baseline.boredom || 0)).toFixed(2),
      house: +(preProfile.house - (baseline.house || 0)).toFixed(2),
    } : null,
    top_antecedents: sortTally(tally(e => e.antecedents)).slice(0, 8),
    top_behaviors: sortTally(tally(e => e.behaviors)).slice(0, 8),
    top_consequences: sortTally(tally(e => e.consequences)).slice(0, 8),
    top_combos: Object.entries(combos).sort((a, b) => b[1] - a[1]).slice(0, 6),
    rule_breaks: db.prepare("SELECT r.id, r.title, r.icon, COUNT(*) n FROM day_items d JOIN rules r ON r.id=d.rule_id WHERE d.rules='x' AND d.date>=? GROUP BY r.id ORDER BY n DESC").all(since.slice(0, 10)),
    tool_uses: db.prepare('SELECT t.label, t.icon, COUNT(*) n FROM tool_uses u JOIN tools t ON t.id=u.tool_id WHERE u.ts>=? GROUP BY t.id ORDER BY n DESC').all(since),
    checkins: { count: ins.length, avg_risk: avg(ins) },
  };
}
const avgCol = (rows, k) => (rows.length ? +(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length).toFixed(2) : null);

function adminConfig() {
  const date = ensureDay();
  const { dow } = localParts();
  const eff = resolveMode(date, dow);
  const opts = { A: [], B: [], C: [] };
  for (const o of db.prepare('SELECT kind,label FROM abc_options ORDER BY position,id').all()) opts[o.kind].push(o.label);
  const flags = profile();
  return {
    profile: { ...flags, presets: Object.entries(PROFILE_PRESETS).map(([id, p]) => ({ id, name: p.name, blurb: p.blurb })) },
    modes: db.prepare('SELECT * FROM modes ORDER BY sort,id').all().map(modeWithItems),
    weekdays: Object.fromEntries(db.prepare('SELECT dow,mode_id FROM weekday_modes').all().map(r => [r.dow, r.mode_id])),
    override: getSetting('override_date') === date ? Number(getSetting('override_mode_id')) || null : null,
    effective: eff.mode ? { mode_id: eff.mode.id, source: eff.source } : null,
    choices: db.prepare('SELECT label,icon FROM choices ORDER BY position,id').all(),
    abc_options: flags.abc ? opts : { A: [], B: [], C: [] },
    regulation: flags.battery || flags.checkins || flags.pause ? regulation() : null,
    rewards: flags.rewards ? rewards() : [],
    calendar: calendar(date, 14),
    plans: db.prepare('SELECT * FROM day_plans ORDER BY date').all(),
    identity: { child_name: childName() },
    security: { has_admin: !!getSetting('admin_hash') },
  };
}
function saveMode(id, b) {
  const f = [clampStr(b.name, 60) || 'Untitled', clampStr(b.emoji, 8), clampStr(b.color, 16) || '#4f8cff',
    toInt(b.reward_all) ?? 0, toInt(b.reward_one_x) ?? 0, toInt(b.reward_two_x) ?? 0];
  return tx(() => {
    if (id == null) id = Number(db.prepare('INSERT INTO modes(name,emoji,color,reward_all,reward_one_x,reward_two_x,sort) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM modes))').run(...f).lastInsertRowid);
    else db.prepare('UPDATE modes SET name=?,emoji=?,color=?,reward_all=?,reward_one_x=?,reward_two_x=? WHERE id=?').run(...f, id);
    db.prepare('DELETE FROM mode_items WHERE mode_id=?').run(id);
    const ins = db.prepare('INSERT INTO mode_items(mode_id,position,start,title,icon,minutes,note) VALUES(?,?,?,?,?,?,?)');
    (Array.isArray(b.items) ? b.items : []).filter(i => clampStr(i.title).trim()).forEach((i, n) =>
      ins.run(id, n, clampStr(i.start, 5), clampStr(i.title, 80), clampStr(i.icon, 8), toInt(i.minutes), clampStr(i.note, 300)));
    return id;
  });
}
// The admin's editable lists (tools, rules) are updated in place. History points
// at their ids — tool_uses.tool_id, day_items.rule_id — so a delete-and-reinsert
// moves every id and mis-attributes the past. Rows are matched by id when the
// client sends one, else by the label/title they already had; only the rows a
// parent actually dropped are deleted.
function syncList(table, cols, items) {
  const prev = db.prepare(`SELECT id, ${cols.join(', ')} FROM ${table} ORDER BY position, id`).all();
  const byId = new Map(prev.map(r => [r.id, r]));
  const byName = new Map();
  for (const r of prev) if (!byName.has(r[cols[0]])) byName.set(r[cols[0]], r);
  const upd = db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(', ')}, position=? WHERE id=?`);
  const ins = db.prepare(`INSERT INTO ${table}(${cols.join(', ')}, position) VALUES(${cols.map(() => '?').join(', ')}, ?)`);
  const keep = new Set();
  items.forEach((it, i) => {
    const vals = cols.map(c => it[c]);
    let row = it.id != null ? byId.get(it.id) : null;
    if (!row || keep.has(row.id)) {
      const same = byName.get(vals[0]);
      row = same && !keep.has(same.id) ? same : null;
    }
    if (row) { upd.run(...vals, i, row.id); keep.add(row.id); }
    else keep.add(Number(ins.run(...vals, i).lastInsertRowid));
  });
  for (const r of prev) if (!keep.has(r.id)) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(r.id);
}
function abcRows(days) {
  const since = new Date(Date.now() - days * 864e5);
  const s = `${localParts(since).date} 00:00:00`;
  return db.prepare('SELECT * FROM abc_events WHERE ts>=? ORDER BY ts DESC').all(s)
    .map(r => ({ ...r, antecedents: JSON.parse(r.antecedents || '[]'), behaviors: JSON.parse(r.behaviors || '[]'), consequences: JSON.parse(r.consequences || '[]') }));
}
function abcSummary(rows) {
  const tally = k => Object.entries(rows.flatMap(r => r[k]).reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})).sort((a, b) => b[1] - a[1]);
  const byHour = Array(24).fill(0);
  rows.forEach(r => { byHour[Number(r.ts.slice(11, 13))]++; });
  return { total: rows.length, antecedents: tally('antecedents'), behaviors: tally('behaviors'), consequences: tally('consequences'), byHour };
}

const clampStr = (s, n = 200) => String(s ?? '').slice(0, n);
const toInt = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

async function admin(req, res, url, body, user) {
  const p = url.pathname, M = req.method;
  const ip = clientIp(req);
  let m;

  // ---------- auth / setup ----------
  // ---- guardian consent (0020): the managed tier's COPPA VPC step. The
  // platform provisions the board with hashed knowledge-based questions
  // (BD_CONSENT_KBA: [{q, h}]); the parent completes the notice + email +
  // answers + age-band assertion at setup. The email themselves is sent by
  // the platform — the board verifies the challenge and records the
  // artifact. Self-host boards without BD_REQUIRE_CONSENT keep the simple
  // 0017 acknowledgment. Research: docs/research/laws.md §312.5(b)(viii).
  const consentRequired = () => process.env.BD_REQUIRE_CONSENT === '1';
  const consentQuestions = () => {
    try {
      const qs = JSON.parse(process.env.BD_CONSENT_KBA || '[]');
      if (Array.isArray(qs) && qs.length && qs.every(q => q.q && /^[0-9a-f]{64}$/.test(q.h || ''))) return qs;
    } catch {}
    return null;
  };
  const normAnswer = a => String(a || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (M === 'GET' && p === '/api/admin/me') {
    if (adminAuthed(req)) return json(res, 200, { user: 'admin', setup: false, child_name: childName() });
    const configured = !!getSetting('admin_hash');
    // 0020: the managed tier's consent step, surfaced for the setup screen —
    // the question texts are public (they are on the setup form anyway).
    const vpc = !configured && consentRequired();
    return json(res, configured ? 401 : 200, {
      setup: !configured,
      // Presence only — the value never leaves the server log / operator env.
      setup_token: !configured && !!getSetting('setup_token_hash'),
      consent_required: vpc,
      consent_questions: vpc ? (consentQuestions() || []).map(q => q.q) : [],
      consent_notice: vpc ? (process.env.BD_CONSENT_NOTICE || 'This board stores your child\'s behavioral data — schedule, marks, events, notes — on the host\'s machine. You can export everything or delete it at any time. Nothing is shared with anyone.') : null,
    });
  }
  if (M === 'POST' && p === '/api/admin/login') {
    if (!rateLimit('login:' + ip, LOGIN_RATE_LIMIT, 60000)) { logEvent('login_fail', ip, 'rate limited'); return json(res, 429, { error: 'too many attempts' }); }
    const lo = loginAllowed(ip);
    if (!lo.ok) { logEvent('login_fail', ip, 'locked'); return json(res, 423, { error: `locked; try again in ${Math.ceil((lo.until - Date.now()) / 60000)} min` }); }
    if (!getSetting('admin_hash')) {
      // Equalize timing with the (expensive) scrypt path below: "not configured
      // yet" must not be probeable faster than "wrong password".
      crypto.scryptSync('timing-equalizer', 'timing-equalizer', 64);
      logEvent('login_fail', ip, 'not configured');
      return json(res, 401, { error: 'wrong password' });
    }
    if (verifyPassword(clampStr(body.password, 200), getSetting('admin_hash'))) {
      lockouts.delete(ip);
      logEvent('login_ok', ip);
      return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
    }
    loginFailed(ip);
    logEvent('login_fail', ip, 'wrong password');
    return json(res, 401, { error: 'wrong password' });
  }
  // ---- guardian consent (0020): helpers live at the top of admin() so the
  // /me probe and setup both see them. See the block before /setup.
  if (M === 'POST' && p === '/api/admin/setup') {
    if (getSetting('admin_hash')) return json(res, 409, { error: 'already configured' });
    if (!rateLimit('setup:' + ip, 10, 60000)) return json(res, 429, { error: 'too many attempts' });
    // The bootstrap token makes setup unforgeable. Compare SHA-256s in constant
    // time; the scrypt call on failure keeps the response time flat so a
    // missing-vs-wrong token is not distinguishable.
    const wantHash = getSetting('setup_token_hash');
    const got = crypto.createHash('sha256').update(String(body.token || '')).digest();
    if (!wantHash || !crypto.timingSafeEqual(got, Buffer.from(wantHash, 'hex'))) {
      crypto.scryptSync('timing-equalizer', 'timing-equalizer', 64);
      logEvent('setup_fail', ip, 'bad setup token', false);
      return json(res, 403, { error: 'setup token required or wrong' });
    }
    const pw = String(body.password || '');
    if (weakPassword(pw)) return json(res, 400, { error: 'password is too common or too short — use 8+ characters that are not a dictionary word' });
    // The VPC step (0020) when this board is managed:
    let consentKind = 'self_host_ack', consentContact = '', consentWhat =
      'I run this board for my family on my own machine. I choose to store my child\'s behavioral data here. I can export it or delete everything at any time.';
    if (consentRequired()) {
      const qs = consentQuestions();
      if (!qs) return json(res, 500, { error: 'this board requires guardian consent but its challenge is misconfigured — contact your host' });
      const c = body.consent || {};
      const email = clampStr(String(c.email || '').trim(), 200);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 403, { error: 'a parent email address is required for consent' });
      const band = c.age_band;
      if (band !== 'under13' && band !== '13plus') return json(res, 403, { error: 'assert the child\'s age band (under13 or 13plus)' });
      const answers = Array.isArray(c.answers) ? c.answers : [];
      if (answers.length !== qs.length) return json(res, 403, { error: 'every knowledge-based question must be answered' });
      for (let i = 0; i < qs.length; i++) {
        const got = crypto.createHash('sha256').update(normAnswer(answers[i])).digest();
        const want = Buffer.from(qs[i].h, 'hex');
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
          logEvent('setup_fail', ip, `kba question ${i} wrong`, false);
          return json(res, 403, { error: `an answer did not match: ${qs[i].q}` });
        }
      }
      consentKind = 'vpc_kba';
      consentContact = email;
      consentWhat = `Verifiable parental consent per 16 CFR 312.5(b)(viii): notice given; consent contact ${email}; knowledge-based challenge passed (${qs.length} questions); the operator asserted the child is ${band === 'under13' ? 'under 13' : '13 or older'}.`;
    }
    setSetting('admin_hash', hashPassword(pw));
    setSetting('setup_token_hash', null);   // single use
    if (body.child_name != null) setSetting('child_name', clampStr(body.child_name, 40));
    // The consent artifact — the one record a deletion request must leave behind.
    db.prepare('INSERT INTO consents(who,what,ip,ts,kind,contact) VALUES(?,?,?,?,?,?)').run('guardian', consentWhat, ip, tsNow(), consentKind, consentContact);
    logEvent('setup', ip);
    return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
  }

  // ---- passkeys (0015): the OPEN half is the login. A passkey mints the
  // same session cookie the password mints; it is not a different authority.
  // RP ID: one setting/env (BD_RP_ID, default the request host without port)
  // — a later domain change is a config change plus re-enrollment.
  const rpId = () => String(process.env.BD_RP_ID || String(req.headers.host || '').split(':')[0]).toLowerCase();
  const requestOrigin = () => {
    if (process.env.BD_EXPECTED_ORIGIN) return process.env.BD_EXPECTED_ORIGIN;
    const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = xf || (req.socket.encrypted ? 'https' : 'http');
    return proto + '://' + (req.headers.host || 'localhost');
  };
  const webauthnFail = (detail, code = 400) => { logEvent('webauthn_fail', ip, detail, false); return json(res, code, { error: detail }); };

  if (M === 'GET' && p === '/api/admin/webauthn/begin-authentication') {
    if (!rateLimit('wauth-begin:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });
    if (!db.prepare('SELECT COUNT(*) c FROM passkeys WHERE revoked_at IS NULL').get().c) return json(res, 404, { error: 'no passkeys on this board yet — sign in with your password' });
    return json(res, 200, { challenge: newChallenge('auth'), rpId: rpId(), timeout: 60000, userVerification: 'preferred' });
  }
  if (M === 'POST' && p === '/api/admin/webauthn/finish-authentication') {
    if (!rateLimit('wauth-finish:' + ip, 10, 60000)) { logEvent('webauthn_fail', ip, 'rate limited', false); return json(res, 429, { error: 'too many attempts' }); }
    const ch = takeChallenge(body.challenge, 'auth');
    if (!ch) return webauthnFail('challenge expired or unknown', 400);
    const cd = checkClientData(body.response?.clientDataJSON, { type: 'webauthn.get', challenge: body.challenge, origin: requestOrigin() });
    if (cd.error) return webauthnFail(cd.error);
    let cred;
    try { cred = parseAuthData(b64uToBuf(body.response.authenticatorData)); } catch (e) { return webauthnFail('authenticator data: ' + e.message); }
    if (!cred.up) return webauthnFail('user presence not asserted');
    if (cred.rpIdHash.compare(wSha256(rpId())) !== 0) return webauthnFail('rp id mismatch');
    const row = db.prepare('SELECT * FROM passkeys WHERE credential_id=? AND revoked_at IS NULL').get(String(body.id));
    if (!row) return webauthnFail('unknown credential', 401);
    let pub, hash;
    try {
      const jwk = JSON.parse(row.public_key);
      pub = crypto.createPublicKey({ format: 'jwk', key: jwk });
      hash = jwk.alg === 'EdDSA' ? null : 'sha256';
    } catch (e) { return webauthnFail('stored key unreadable — re-enroll'); }
    const signed = Buffer.concat([b64uToBuf(body.response.authenticatorData), wSha256(b64uToBuf(body.response.clientDataJSON))]);
    let ok = false;
    try { ok = hash ? crypto.verify(hash, signed, pub, b64uToBuf(body.response.signature)) : crypto.verify(null, signed, pub, b64uToBuf(body.response.signature)); } catch {}
    if (!ok) return webauthnFail('signature did not verify', 401);
    // Clone detection: a counter that does not advance means the credential
    // was duplicated. Zero-counters (authenticators with no counter) are only
    // allowed when BOTH sides are zero — a credential that reported a count
    // and suddenly reports zero is a different, cloned device.
    const newCount = cred.signCount;
    if (!(newCount === 0 && row.sign_count === 0) && newCount <= row.sign_count) {
      logEvent('webauthn_counter_rollback', ip, 'credential ' + String(body.id).slice(0, 12), false);
      return webauthnFail('this credential looks cloned — sign in with your password and remove it from the console', 401);
    }
    db.prepare('UPDATE passkeys SET sign_count=?, last_used_at=? WHERE id=?').run(newCount || row.sign_count, tsNow(), row.id);
    logEvent('webauthn_signin', ip, row.name);
    return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
  }
  // ---- OAuth sign-in (0023): Apple/Google as a third credential for the
  // same admin session. Trust rules: linking happens only from a signed-in
  // console; an unlinked identity can never sign in; no child data leaves
  // the board for the provider (the only thing they ever see is the
  // parent's browser visiting them). See docs/integrations.md.
  const oauthConfigured = p2 => { try { oauthCfgFor(p2, 'http://x'); return true; } catch { return false; } };
  if (M === 'GET' && p === '/api/admin/oauth/providers') {
    return json(res, 200, { providers: ['google', 'apple'].filter(p2 => oauthConfigured(p2)) });
  }
  const oauthRedirect = (res, hash) => { res.writeHead(302, { location: '/admin' + hash, 'cache-control': 'no-store', ...SEC_HEADERS }); return res.end(); };
  if (M === 'GET' && p === '/api/admin/oauth/begin') {
    const provider = url.searchParams.get('provider');
    if (!OAUTH_PROVIDERS[provider]) return json(res, 404, { error: 'unknown provider' });
    if (!oauthConfigured(provider)) return json(res, 404, { error: `${provider} sign-in is not configured on this board` });
    if (!rateLimit('oauth:' + ip, Number(process.env.OAUTH_RATE_LIMIT) || 20, 60000)) return json(res, 429, { error: 'too many requests' });
    const cfg = oauthCfgFor(provider, requestOrigin());
    const state = newChallenge('oauth-' + provider);
    return json(res, 200, { url: OAUTH_PROVIDERS[provider].authorizeUrl(cfg, state), state });
  }
  // The callback accepts the finished identity in two dialects: Google's code
  // exchange (GET, querystring) and Apple's form_post (POST, body).
  if ((M === 'GET' && (m = p.match(/^\/api\/admin\/oauth\/(google)\/callback$/))) ||
      (M === 'POST' && (m = p.match(/^\/api\/admin\/oauth\/(apple)\/callback$/)))) {
    const provider = m[1];
    if (!rateLimit('oauth:' + ip, Number(process.env.OAUTH_RATE_LIMIT) || 20, 60000)) return json(res, 429, { error: 'too many requests' });
    const params = provider === 'apple' ? body : Object.fromEntries(url.searchParams);
    const cfg = oauthCfgFor(provider, requestOrigin());
    const st = takeChallenge(String(params.state || ''), 'oauth-' + provider);
    if (!st) return oauthRedirect(res, '?oauth=' + encodeURIComponent('that sign-in attempt has expired — try again'));
    let claims;
    try { claims = await OAUTH_PROVIDERS[provider].verify(params, cfg); }
    catch (e) { logEvent('oauth_fail', ip, provider + ': ' + e.message, false); return oauthRedirect(res, '?oauth=' + encodeURIComponent(e.message)); }
    const sub = `${provider}:${String(claims.sub)}`;
    const existing = db.prepare('SELECT id FROM oauth_identities WHERE provider=? AND sub=? AND revoked_at IS NULL').get(provider, String(claims.sub));
    if (adminAuthed(req)) {
      if (existing) return oauthRedirect(res, '?oauth=already+linked');
      db.prepare('INSERT INTO oauth_identities(provider,sub,email,created_at,last_used_at) VALUES(?,?,?,?,?)').run(provider, String(claims.sub), clampStr(claims.email, 200), tsNow(), '');
      logEvent('oauth_link', ip, provider);
      return oauthRedirect(res, '?oauth=linked');
    }
    if (!existing) { logEvent('oauth_fail', ip, provider + ': not linked', false); return oauthRedirect(res, '?oauth=' + encodeURIComponent('this identity is not linked to a board — sign in with your passkey and link it from Settings')); }
    db.prepare('UPDATE oauth_identities SET last_used_at=? WHERE id=?').run(tsNow(), existing.id);
    logEvent('oauth_signin', ip, provider);
    return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
  }
  // Everything below requires an admin session — including the password
  // endpoints: changing the password, reading or rotating the kiosk token, and
  // every board-copy editor is session-gated on purpose.
  // An API key is the automation path to the same gate: it authenticates as
  // 'api:<name>' (the audit's by field), and it never bypasses the limits.
  let identity = 'admin';
  if (!adminAuthed(req)) {
    const key = resolveApiKey(req);
    if (!key) return json(res, 401, { error: 'admin login required' });
    identity = `api:${key.name}`;
  }
  user = identity;   // board writes record by 'api:<name>' for key-driven calls
  if (!rateLimit('admin:' + ip, 300, 60000)) { logEvent('admin_rate_limited', ip, p); return json(res, 429, { error: 'too many requests' }); }
  // The audit trail of the board itself: every authenticated mutation, where
  // it came from. (Reads are noise; writes are the record.)
  if (M !== 'GET') logEvent('admin_write', ip, `${M} ${p}`);

  if (M === 'POST' && p === '/api/admin/logout') {
    const t = parseCookies(req).bd_session;
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(t));
    logEvent('logout', ip);
    return json(res, 200, { ok: true }, { 'set-cookie': LOGOUT_COOKIE });
  }
  if (M === 'POST' && p === '/api/admin/password') {
    if (!verifyPassword(clampStr(body.current, 200), getSetting('admin_hash'))) { logEvent('password_change', ip, 'wrong current', false); return json(res, 403, { error: 'current password is wrong' }); }
    const np = String(body.next || '');
    if (weakPassword(np)) return json(res, 400, { error: 'new password is too common or too short — use 8+ characters that are not a dictionary word' });
    setSetting('admin_hash', hashPassword(np));
    // A changed password invalidates every live session: any console that was
    // left open on a borrowed phone is signed out the moment the password moves.
    db.prepare('DELETE FROM sessions').run();
    logEvent('password_change', ip);
    return json(res, 200, { ok: true });
  }
  if (M === 'GET' && p === '/api/admin/kiosk-devices') {
    const devices = db.prepare('SELECT id,label,created_at,last_used_at,revoked_at FROM kiosk_devices ORDER BY id').all();
    return json(res, 200, { devices });
  }
  if (M === 'POST' && p === '/api/admin/kiosk-devices') {
    const label = clampStr(body.label, 40).trim();
    if (!label) return json(res, 400, { error: 'a device label is required' });
    if (db.prepare('SELECT COUNT(*) c FROM kiosk_devices WHERE revoked_at IS NULL').get().c >= KIOSK_DEVICES_MAX) {
      return json(res, 400, { error: `keep at most ${KIOSK_DEVICES_MAX} active devices — revoke one first` });
    }
    const { id, token } = newKioskDevice(label);
    logEvent('kiosk_device_add', ip, label);
    // The raw token is shown once — this response is the only copy.
    return json(res, 200, { id, label, token });
  }

  // ---- passkeys (0015): the session-gated half. Enrollment, list, revoke.
  if (M === 'GET' && p === '/api/admin/webauthn/begin-registration') {
    return json(res, 200, {
      challenge: newChallenge('register'), rpId: rpId(), timeout: 60000, attestation: 'none',
      user: { id: b64u(Buffer.from('admin')), name: childName() || 'admin' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
  }
  if (M === 'POST' && p === '/api/admin/webauthn/finish-registration') {
    const ch = takeChallenge(body.challenge, 'register');
    if (!ch) return webauthnFail('challenge expired or unknown');
    const cd = checkClientData(body.response?.clientDataJSON, { type: 'webauthn.create', challenge: body.challenge, origin: requestOrigin() });
    if (cd.error) return webauthnFail(cd.error);
    let att, cred;
    try {
      att = cborDecode(b64uToBuf(body.response.attestationObject));
      cred = parseAuthData(Buffer.from(att.authData));
    } catch (e) { return webauthnFail('attestation: ' + e.message); }
    if (!cred.up || !cred.at || !cred.uv) return webauthnFail('the authenticator did not assert user presence + verification');
    if (cred.rpIdHash.compare(wSha256(rpId())) !== 0) return webauthnFail('rp id mismatch');
    let parsed;
    try { parsed = coseKey(cred.credential.pub); } catch (e) { return webauthnFail('unsupported credential key: ' + e.message); }
    const cid = b64u(cred.credential.id);
    if (db.prepare('SELECT 1 FROM passkeys WHERE credential_id=?').get(cid)) return webauthnFail('this credential is already enrolled');
    const count = db.prepare('SELECT COUNT(*) c FROM passkeys WHERE revoked_at IS NULL').get().c;
    if (count >= 8) return json(res, 400, { error: 'keep at most 8 passkeys — remove one first' });
    const name = clampStr(body.name, 40).trim() || 'passkey';
    const info = db.prepare('INSERT INTO passkeys(credential_id,name,public_key,sign_count,aaid,created_at,last_used_at) VALUES(?,?,?,?,?,?,?)')
      .run(cid, name, JSON.stringify(parsed.jwk), cred.signCount, cred.credential.aaguid.toString('hex'), tsNow(), '');
    logEvent('webauthn_register', ip, name);
    return json(res, 200, { ok: true, id: Number(info.lastInsertRowid), name });
  }
  if (M === 'GET' && p === '/api/admin/oauth/identities') {
    return json(res, 200, { identities: db.prepare('SELECT id,provider,email,created_at,last_used_at,revoked_at FROM oauth_identities ORDER BY id').all() });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/oauth\/identities\/(\d+)$/))) {
    const row = db.prepare('SELECT id,provider FROM oauth_identities WHERE id=? AND revoked_at IS NULL').get(Number(m[1]));
    if (!row) return json(res, 404, { error: 'no such linked identity' });
    db.prepare('UPDATE oauth_identities SET revoked_at=? WHERE id=?').run(tsNow(), row.id);
    logEvent('oauth_unlink', ip, row.provider);
    return json(res, 200, { ok: true });
  }
  if (M === 'GET' && p === '/api/admin/webauthn/credentials') {
    const keys = db.prepare('SELECT id,name,aaid,created_at,last_used_at,revoked_at FROM passkeys ORDER BY id').all();
    return json(res, 200, { keys, rp_id: rpId() });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/webauthn\/credentials\/(\d+)$/))) {
    const key = db.prepare('SELECT id,name FROM passkeys WHERE id=? AND revoked_at IS NULL').get(Number(m[1]));
    if (!key) return json(res, 404, { error: 'no such passkey' });
    db.prepare('UPDATE passkeys SET revoked_at=? WHERE id=?').run(tsNow(), key.id);
    logEvent('webauthn_remove', ip, key.name);
    return json(res, 200, { ok: true, name: key.name });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/kiosk-devices\/(\d+)$/))) {
    const dev = db.prepare('SELECT id,label FROM kiosk_devices WHERE id=? AND revoked_at IS NULL').get(Number(m[1]));
    if (!dev) return json(res, 404, { error: 'no such active device' });
    db.prepare('UPDATE kiosk_devices SET revoked_at=? WHERE id=?').run(tsNow(), dev.id);
    logEvent('kiosk_device_revoke', ip, dev.label);
    return json(res, 200, { ok: true, label: dev.label });
  }
  // The audit trail itself: recent security events + who last used the kiosk
  // code. This is the card that answers "was the TV the only thing on it?".
  // API keys: create (raw shown once), list (prefix only), revoke.
  if (M === 'POST' && p === '/api/admin/api-keys') {
    const name = clampStr(body.name, 40).trim();
    if (!name) return json(res, 400, { error: 'a key name is required' });
    if (db.prepare('SELECT COUNT(*) c FROM api_keys WHERE revoked_at IS NULL').get().c >= API_KEYS_MAX) {
      return json(res, 400, { error: `keep at most ${API_KEYS_MAX} active keys — revoke one first` });
    }
    const raw = 'bdb_' + crypto.randomBytes(24).toString('hex');
    const id = Number(db.prepare('INSERT INTO api_keys(name,key_hash,prefix,created_at,last_used_at) VALUES(?,?,?,?,?)')
      .run(name, sha256(raw), raw.slice(0, 12), tsNow(), '').lastInsertRowid);
    logEvent('api_key_create', ip, name);
    return json(res, 200, { id, name, key: raw });   // the raw key is shown once
  }
  if (M === 'GET' && p === '/api/admin/api-keys') {
    const keys = db.prepare('SELECT id,name,prefix,created_at,last_used_at,revoked_at FROM api_keys ORDER BY id').all();
    return json(res, 200, { keys });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/api-keys\/(\d+)$/))) {
    const key = db.prepare('SELECT id,name FROM api_keys WHERE id=? AND revoked_at IS NULL').get(Number(m[1]));
    if (!key) return json(res, 404, { error: 'no such active key' });
    db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=?').run(tsNow(), key.id);
    logEvent('api_key_revoke', ip, key.name);
    return json(res, 200, { ok: true, name: key.name });
  }
  if (M === 'GET' && p === '/api/admin/security') {
    const events = db.prepare('SELECT ts,kind,ip,detail,ok FROM security_events ORDER BY id DESC LIMIT 50').all();
    const kiosk_devices = db.prepare('SELECT label,last_used_at FROM kiosk_devices WHERE revoked_at IS NULL ORDER BY id').all();
    const api_keys = db.prepare('SELECT name,last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY id').all();
    return json(res, 200, { kiosk_devices, api_keys, events, retention_months: getSetting('retention_months') == null ? 12 : Number(getSetting('retention_months')) });
  }
  // ---- 0017: the compliance controls ----
  // The requests log (research P2): what the child asked for, read as a
  // voice. Newest first, with the tally the family actually uses.
  if (M === 'GET' && p === '/api/admin/requests') {
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 90);
    const since = fmtTs(new Date(Date.now() - days * 864e5));
    const items = db.prepare('SELECT ts,label,by FROM requests WHERE ts>=? ORDER BY id DESC LIMIT 200').all(since);
    const tally = {};
    for (const r of items) tally[r.label] = (tally[r.label] || 0) + 1;
    return json(res, 200, { requests: items, tally: Object.entries(tally).sort((a, b) => b[1] - a[1]) });
  }
  // The consent artifact: who acknowledged what, when, from where.
  // Calendar subscription (0024): the family pastes their private iCal URL
  // (Apple or Google). Saved → fetched → parsed immediately; empty clears.
  if (M === 'PUT' && p === '/api/admin/calendar-feed') {
    const url = clampStr(body.url, 500).trim();
    if (!url) {
      tx(() => { db.prepare('DELETE FROM calendar_events').run(); setSetting('ics_url', null); setSetting('ics_state', null); });
      logEvent('calendar_feed', ip, 'removed');
      return json(res, 200, { ok: true, cleared: true });
    }
    setSetting('ics_url', url);
    await syncCalendarFeed();
    const st = JSON.parse(getSetting('ics_state') || '{}');
    if (st.error) { logEvent('calendar_feed', ip, 'error: ' + st.error, false); return json(res, 400, { error: st.error, kept: st.count || 0 }); }
    logEvent('calendar_feed', ip, `${st.count} events`);
    return json(res, 200, { ok: true, count: st.count, fetched_at: st.fetched_at });
  }
  if (M === 'GET' && p === '/api/admin/calendar-feed') {
    const st = JSON.parse(getSetting('ics_state') || '{}');
    const url = getSetting('ics_url') || '';
    return json(res, 200, { configured: !!url, url_prefix: url ? url.slice(0, 28) + '…' : '', fetched_at: st.fetched_at || null, count: calendarCount(), error: st.error || '' });
  }
  if (M === 'GET' && p === '/api/admin/consent') {
    return json(res, 200, { consents: db.prepare('SELECT who,what,ip,ts,kind,contact FROM consents ORDER BY id').all() });
  }
  // Retention: how many months of raw events the board keeps. 0 = keep
  // everything (the family's own machine, their own call). Changing it prunes
  // immediately — a policy that only applies tomorrow is not a policy.
  if (M === 'PUT' && p === '/api/admin/retention') {
    const months = toInt(body.months);
    if (months == null || months < 0 || months > 60) return json(res, 400, { error: 'months must be 0 (keep everything) through 60' });
    setSetting('retention_months', months);
    const pruned = pruneRetention();
    logEvent('retention_change', ip, months ? `${months} months (${pruned} rows pruned)` : 'keep everything');
    return json(res, 200, { ok: true, months, pruned });
  }
  // Delete-everything: the deletion request the family makes to themselves —
  // and the control that makes self-hosting a complete story. Wipes every
  // data table, reseeds the neutral copy, signs out every device but this
  // one, and keeps exactly two things: the login and the consent record.
  if (M === 'POST' && p === '/api/admin/wipe') {
    if (String(body.confirm || '') !== 'DELETE EVERYTHING') return json(res, 400, { error: 'type DELETE EVERYTHING to confirm — this cannot be undone' });
    const myHash = sha256(parseCookies(req).bd_session || '');
    tx(() => {
      for (const t of ['modes', 'mode_items', 'weekday_modes', 'day_plans', 'days', 'day_items', 'abc_events', 'battery_events', 'check_ins', 'tool_uses', 'rules', 'tools', 'battery_state', 'choices', 'abc_options', 'kiosk_devices', 'api_keys', 'passkeys']) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
      db.prepare("DELETE FROM settings WHERE key != 'admin_hash'").run();
      db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(myHash);
      db.prepare('DELETE FROM security_events').run();
      seed();
    });
    logEvent('wipe', ip, 'everything but this session and the consent record');
    return json(res, 200, { ok: true });
  }
  // The family's data, in one document they own. No redaction: it requires a
  // full admin session, and it is the human-readable half of the backup story
  // (the encrypted blob, when encryption is on, is the byte-faithful half).
  if (M === 'GET' && p === '/api/admin/export') {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      if (!/^[a-z_]+$/.test(name)) continue;   // our schema only, never anything odd
      tables[name] = db.prepare(`SELECT * FROM "${name}"`).all();
    }
    logEvent('export', ip);
    res.writeHead(200, {
      'content-type': 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS,
      'content-disposition': `attachment; filename="behavior-dashboard-${localParts().date}.json"`,
    });
    return res.end(JSON.stringify({ app: 'behavior-dashboard', version: VERSION, exported_at: tsNow(), tables }));
  }
  // Signed-in devices: visible, and killable individually. The sid is the
  // 12-char prefix of the stored hash — enough to match a row, never enough
  // to use one.
  const mySessionHash = sha256(parseCookies(req).bd_session || '');
  if (M === 'GET' && p === '/api/admin/sessions') {
    const sessions = db.prepare('SELECT token_hash, created_at, expires_at, last_seen FROM sessions ORDER BY created_at').all()
      .map(s => ({ sid: s.token_hash.slice(0, 12), created_at: s.created_at, expires_at: s.expires_at, last_seen: s.last_seen || null, current: s.token_hash === mySessionHash }));
    return json(res, 200, { sessions });
  }
  if (M === 'DELETE' && p === '/api/admin/sessions') {
    const gone = db.prepare('DELETE FROM sessions WHERE token_hash <> ?').run(mySessionHash);
    logEvent('session_revoke_all', ip, `revoked ${gone.changes}`);
    return json(res, 200, { ok: true, revoked: gone.changes });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/sessions\/([0-9a-f]{12})$/))) {
    const row = db.prepare("SELECT token_hash FROM sessions WHERE substr(token_hash,1,12)=?").get(m[1]);
    if (!row) return json(res, 404, { error: 'no such session' });
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(row.token_hash);
    logEvent('session_revoke', ip, 'sid ' + m[1]);
    return json(res, 200, { ok: true, current: row.token_hash === mySessionHash });
  }
  if (M === 'PUT' && p === '/api/admin/identity') {
    setSetting('child_name', clampStr(body.child_name, 40));
    return json(res, 200, { ok: true, child_name: childName() });
  }
  // The board profile: pick a preset (which resets the flags to it) and/or
  // hand an explicit capabilities map (which is stored verbatim over the
  // preset). Omitting capabilities keeps the family's refinements.
  if (M === 'PUT' && p === '/api/admin/profile') {
    if (body.id !== undefined && !PROFILE_PRESETS[body.id]) return json(res, 400, { error: 'unknown profile — pick one of: ' + Object.keys(PROFILE_PRESETS).join(', ') });
    let flags = null;
    if (body.capabilities !== undefined) {
      const given = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities) ? body.capabilities : null;
      if (!given) return json(res, 400, { error: 'capabilities must be an object of boolean flags' });
      const bad = Object.keys(given).filter(k => !CAPS.includes(k));
      if (bad.length) return json(res, 400, { error: 'unknown capability: ' + bad.join(', ') });
      flags = { ...profileFlags(body.id ?? (getSetting('profile_id') in PROFILE_PRESETS ? getSetting('profile_id') : 'standard')), ...Object.fromEntries(Object.entries(given).map(([k, v]) => [k, !!v])) };
    }
    const before = profile();
    if (body.id !== undefined) setSetting('profile_id', body.id);
    if (flags) setSetting('profile_overrides', JSON.stringify(flags));
    else if (body.id !== undefined) setSetting('profile_overrides', null);   // a preset switch is a reset
    const after = profile();
    if (JSON.stringify(before) !== JSON.stringify(after)) logEvent('profile_change', ip, after.id);
    return json(res, 200, { ok: true, profile: after });
  }
  if (M === 'PUT' && p === '/api/admin/bands') {
    const bs = (Array.isArray(body.bands) ? body.bands : []).slice(0, 4);
    if (bs.length < 4) return json(res, 400, { error: 'four bands required (100 / 80 / 60 / 0)' });
    const out = bs.map((b, i) => ({ min: BAND_MIN[i], name: clampStr(b.name, 40) || DEFAULTS.bands[i].name,
      color: /^#[0-9a-f]{6}$/i.test(String(b.color || '')) ? String(b.color) : DEFAULTS.bands[i].color, note: clampStr(b.note, 120) }));
    setSetting('bands_v1', JSON.stringify(out));
    return json(res, 200, { ok: true, bands: out });
  }
  if (M === 'PUT' && p === '/api/admin/rewards') {
    const grow = need('rewards', res); if (grow) return grow;
    const lines = (Array.isArray(body.lines) ? body.lines : []).map(l => clampStr(l, 200)).filter(Boolean);
    if (!lines.length) return json(res, 400, { error: 'at least one reward line' });
    setSetting('rewards_v1', JSON.stringify(lines));
    return json(res, 200, { ok: true, lines });
  }
  if (M === 'PUT' && p === '/api/admin/protocol') {
    const cur = protocol();
    const p2 = { ...cur };
    if (Array.isArray(body.proactive)) p2.proactive = body.proactive.slice(0, 10).map(x => clampStr(x, 200)).filter(Boolean);
    if (Array.isArray(body.behavior)) p2.behavior = body.behavior.slice(0, 10).map(x => clampStr(x, 200)).filter(Boolean);
    if (body.hold != null) p2.hold = clampStr(body.hold, 400);
    if (body.script_rule != null) p2.script_rule = clampStr(body.script_rule, 400);
    if (body.script != null) p2.script = clampStr(body.script, 400);
    setSetting('protocol_v1', JSON.stringify(p2));
    if (toInt(body.checkin_minutes) != null) setSetting('checkin_minutes', Math.max(10, Math.min(480, toInt(body.checkin_minutes))));
    return json(res, 200, { ok: true, protocol: p2, checkin_minutes: checkinMinutes() });
  }

  if (M === 'GET' && p === '/api/admin/config') return json(res, 200, adminConfig());
  if (M === 'POST' && p === '/api/admin/modes') return json(res, 200, { id: saveMode(null, body) });
  if ((m = p.match(/^\/api\/admin\/modes\/(\d+)$/))) {
    if (M === 'PUT') return json(res, 200, { id: saveMode(Number(m[1]), body) });
    if (M === 'DELETE') {
      if (db.prepare('SELECT COUNT(*) c FROM modes').get().c <= 1) return json(res, 400, { error: 'keep at least one mode' });
      db.prepare('DELETE FROM modes WHERE id=?').run(Number(m[1])); return json(res, 200, { ok: true });
    }
  }
  if (M === 'PUT' && p === '/api/admin/weekdays') {
    tx(() => { for (let d = 0; d < 7; d++) db.prepare('INSERT INTO weekday_modes(dow,mode_id) VALUES(?,?) ON CONFLICT(dow) DO UPDATE SET mode_id=excluded.mode_id').run(d, toInt(body[d])); });
    return json(res, 200, { ok: true });
  }
  // Manual mode override for today only (sick day, holiday...). null clears it.
  if (M === 'PUT' && p === '/api/admin/override') {
    const { date, dow } = localParts();
    const id = toInt(body.mode_id);
    if (id) { setSetting('override_mode_id', id); setSetting('override_date', date); } else { setSetting('override_mode_id', null); setSetting('override_date', null); }
    const cur = db.prepare('SELECT working_for FROM days WHERE date=?').get(date);
    const eff = resolveMode(date, dow);
    if (eff.mode) buildDay(date, eff.mode, cur?.working_for || '', eff.plan);
    return json(res, 200, adminConfig());
  }
  if (M === 'POST' && p === '/api/admin/today/reset') {
    const { date, dow } = localParts();
    const eff = resolveMode(date, dow);
    if (eff.mode) buildDay(date, eff.mode, '', eff.plan);
    return json(res, 200, todayPayload());
  }
  if (M === 'GET' && p === '/api/admin/today') return json(res, 200, todayPayload());
  if (M === 'PUT' && p === '/api/admin/today') {
    db.prepare('UPDATE days SET working_for=? WHERE date=?').run(clampStr(body.working_for, 80), ensureDay());
    return json(res, 200, todayPayload());
  }
  if (M === 'PATCH' && (m = p.match(/^\/api\/admin\/day-items\/(\d+)$/))) {
    const it = db.prepare('SELECT * FROM day_items WHERE id=?').get(Number(m[1]));
    if (!it) return json(res, 404, { error: 'not found' });
    const finished = 'finished' in body ? (body.finished === null ? null : body.finished ? 1 : 0) : it.finished;
    const rules = 'rules' in body ? (['check', 'turnaround', 'x'].includes(body.rules) ? body.rules : null) : it.rules;
    // rule_id names *which* rule an X was about, so /api/admin/risk can rank them.
    const rule_id = 'rule_id' in body ? toInt(body.rule_id) : it.rule_id;
    db.prepare('UPDATE day_items SET finished=?, rules=?, rule_id=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(finished, rules, rules === 'x' ? rule_id : null, it.id);
    return json(res, 200, todayPayload());
  }
  if (M === 'GET' && p === '/api/admin/history') {
    const days = db.prepare('SELECT * FROM days ORDER BY date DESC LIMIT 60').all().map(d => {
      const items = db.prepare('SELECT * FROM day_items WHERE date=?').all(d.date);
      return { date: d.date, mode: d.mode_name, working_for: d.working_for, reward: reward(d, items) };
    });
    return json(res, 200, days);
  }
  if (M === 'PUT' && p === '/api/admin/choices') {
    const choices = (body.choices || []).filter(c => clampStr(c.label).trim());
    // An empty list is a broken kiosk, not a preference: the whole token
    // economy hangs off "I am working for…". Keep at least one.
    if (!choices.length) return json(res, 400, { error: 'keep at least one choice' });
    tx(() => {
      db.prepare('DELETE FROM choices').run();
      choices.forEach((c, i) => db.prepare('INSERT INTO choices(label,icon,position) VALUES(?,?,?)').run(clampStr(c.label, 80), clampStr(c.icon, 8), i));
    });
    return json(res, 200, { ok: true });
  }
  if (M === 'PUT' && p === '/api/admin/abc-options') {
    const gabc = need('abc', res); if (gabc) return gabc;
    tx(() => {
      db.prepare('DELETE FROM abc_options').run();
      for (const k of ['A', 'B', 'C']) (body[k] || []).filter(l => clampStr(l).trim()).forEach((l, i) => db.prepare('INSERT INTO abc_options(kind,label,position) VALUES(?,?,?)').run(k, clampStr(l, 120), i));
    });
    return json(res, 200, { ok: true });
  }
  if (M === 'POST' && p === '/api/admin/abc') {
    const gabc2 = need('abc', res); if (gabc2) return gabc2;
    const arr = a => JSON.stringify((Array.isArray(a) ? a : []).map(x => clampStr(x, 120)));
    const ts = body.ts && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(body.ts) ? body.ts.replace('T', ' ').slice(0, 16) + ':00' : tsNow();
    const sev = Math.max(0, Math.min(5, toInt(body.severity) ?? ((Array.isArray(body.behaviors) ? body.behaviors.length : 0) ? 3 : 0)));
    const id = db.prepare('INSERT INTO abc_events(ts,antecedents,behaviors,consequences,note,by,severity) VALUES(?,?,?,?,?,?,?)')
      .run(ts, arr(body.antecedents), arr(body.behaviors), arr(body.consequences), clampStr(body.note, 1000), user, sev).lastInsertRowid;
    return json(res, 200, { id: Number(id) });
  }
  if (M === 'GET' && p === '/api/admin/abc') {
    const gabc3 = need('abc', res); if (gabc3) return gabc3;
    const rows = abcRows(Math.min(Number(url.searchParams.get('days')) || 30, 365));
    return json(res, 200, { events: rows, summary: abcSummary(rows) });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/abc\/(\d+)$/))) {
    db.prepare('DELETE FROM abc_events WHERE id=?').run(Number(m[1])); return json(res, 200, { ok: true });
  }

  // ---------- regulation: battery, tools, rules, check-ins, risk ----------
  if (M === 'GET' && p === '/api/admin/regulation') { const fl = profile(); return (fl.battery || fl.checkins || fl.pause) ? json(res, 200, regulation()) : json(res, 404, { error: 'that part of the board is switched off in this profile' }); }
  if (M === 'POST' && p === '/api/admin/battery') {
    const gbat = need('battery', res); if (gbat) return gbat;
    const cur = batteryLines();
    const delta = toInt(body.delta);
    const next = delta != null ? cur + delta : toInt(body.lines);
    if (next == null) return json(res, 400, { error: 'lines or delta required' });
    return json(res, 200, { battery: batterySet(next, delta ?? 0, body.reason, user), pause: pauseState() });
  }
  // One tap = the if-behaviors-occur procedure: name the rule, pause
  // reinforcement, drop a battery line, hand back the script + next steps.
  if (M === 'POST' && p === '/api/admin/behavior') {
    const gbeh = need('abc', res); if (gbeh) return gbeh;
    const list = v => (Array.isArray(v) ? v : v ? [String(v)] : []);
    const rule = body.rule_id ? db.prepare('SELECT * FROM rules WHERE id=?').get(Number(body.rule_id)) : null;
    const B = list(body.behaviors), A = list(body.antecedents);
    const C = list(body.consequences).length ? list(body.consequences) : [DEFAULTS.abc.C[0]];
    const sev = Math.max(1, Math.min(5, toInt(body.severity) ?? 3));
    const pr = protocol();
    const out = tx(() => {
      const id = db.prepare('INSERT INTO abc_events(ts,antecedents,behaviors,consequences,note,by,severity) VALUES(?,?,?,?,?,?,?)')
        .run(tsNow(), JSON.stringify(A.map(x => clampStr(x, 120))), JSON.stringify(B.map(x => clampStr(x, 120))),
          JSON.stringify(C.map(x => clampStr(x, 120))), clampStr(body.note, 1000), user, sev).lastInsertRowid;
      const drop = body.battery_delta === null ? 0 : (toInt(body.battery_delta) ?? 1);
      const battery = batteryWrite(batteryLines() - drop, -drop, rule ? rule.title : B.join(', '), user);
      if (body.pause !== false) setPause(rule ? rule.title : clampStr(body.reason || 'behavior', 120), toInt(body.pause_minutes));
      return { id: Number(id), battery };
    });
    return json(res, 200, {
      ...out, pause: pauseState(),
      script: fillT(rule ? pr.script_rule : pr.script, { name: childName() || 'You', rule: rule ? rule.title.toLowerCase() : '' }),
      next: pr.behavior.slice(3), hold: pr.hold,
    });
  }
  // A check-in: the risk factors, plus the battery as the parent sees it.
  if (M === 'POST' && p === '/api/admin/checkins') {
    const gchk = need('checkins', res); if (gchk) return gchk;
    const lv = k => Math.max(0, Math.min(3, toInt(body[k]) ?? 0));
    const rec = { hunger: lv('hunger'), boredom: lv('boredom'), house: lv('house') };
    const battery = Math.max(0, Math.min(BATTERY_LINES, toInt(body.battery) ?? batteryLines()));
    const id = db.prepare('INSERT INTO check_ins(ts,hunger,boredom,house,battery,note,by) VALUES(?,?,?,?,?,?,?)')
      .run(tsNow(), rec.hunger, rec.boredom, rec.house, battery, clampStr(body.note, 500), user).lastInsertRowid;
    if (toInt(body.battery) != null && battery !== batteryLines()) batteryWrite(battery, battery - batteryLines(), 'check-in', user);
    return json(res, 200, { id: Number(id), ...regulation(), risk: riskFromLevels(rec) });
  }
  if (M === 'POST' && p === '/api/admin/pause') { const gp = need('pause', res); if (gp) return gp; setPause(body.reason, toInt(body.minutes)); return json(res, 200, { pause: pauseState(), ...regulation() }); }
  // "Once back to baseline, re-engage" — restoring lines is the record that it
  // happened, and it is what un-pauses the fun.
  if (M === 'POST' && p === '/api/admin/resume') {
    const gres = need('pause', res); if (gres) return gres;
    const restore = Math.max(0, Math.min(BATTERY_LINES, toInt(body.restore) ?? 1));
    const battery = batterySet(batteryLines() + restore, restore, 'back to baseline — re-engaged', user);
    clearPause();
    return json(res, 200, { battery, pause: pauseState(), ...regulation() });
  }
  if (M === 'PUT' && p === '/api/admin/tools') {
    const gtoo = need('tools', res); if (gtoo) return gtoo;
    tx(() => syncList('tools', ['label', 'icon'], (body.tools || []).filter(t => clampStr(t.label).trim())
      .map(t => ({ id: toInt(t.id), label: clampStr(t.label, 80), icon: clampStr(t.icon, 8) }))));
    return json(res, 200, { ok: true });
  }
  if (M === 'PUT' && p === '/api/admin/rules') {
    const grul = need('rules', res); if (grul) return grul;
    tx(() => syncList('rules', ['title', 'body', 'icon'], (body.rules || []).filter(r => clampStr(r.title).trim())
      .map(r => ({ id: toInt(r.id), title: clampStr(r.title, 120), body: clampStr(r.body, 200), icon: clampStr(r.icon, 8) }))));
    return json(res, 200, { ok: true });
  }
  if (M === 'GET' && p === '/api/admin/risk') return json(res, 200, riskStats(Math.min(365, Number(url.searchParams.get('days')) || 30)));

  // ---------- the calendar: trips, free days, anything that isn't the week ----------
  if (M === 'GET' && p === '/api/admin/calendar') {
    const days = Math.min(60, Number(url.searchParams.get('days')) || 14);
    return json(res, 200, { calendar: calendar(localParts().date, days), plans: db.prepare('SELECT * FROM day_plans ORDER BY date').all() });
  }
  if (M === 'PUT' && (m = p.match(/^\/api\/admin\/plans\/(\d{4}-\d\d-\d\d)$/))) {
    const date = m[1];
    const mode_id = toInt(body.mode_id);
    const kind = ['plan', 'trip', 'free', 'special'].includes(body.kind) ? body.kind : 'plan';
    if (!mode_id && !clampStr(body.label).trim() && !clampStr(body.note).trim()) {
      db.prepare('DELETE FROM day_plans WHERE date=?').run(date);
    } else {
      db.prepare(`INSERT INTO day_plans(date,mode_id,kind,label,note,by) VALUES(?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET mode_id=excluded.mode_id, kind=excluded.kind, label=excluded.label, note=excluded.note, by=excluded.by`)
        .run(date, mode_id, kind, clampStr(body.label, 60), clampStr(body.note, 300), user);
    }
    // A plan added this morning should show up on the kiosk straight away — but
    // a day that's already been scored is left alone. A scored day still takes
    // the name: "a plan at 9pm just carries the name" is the documented behaviour.
    if (date === localParts().date) {
      const eff = resolveMode(date, localParts().dow);
      if (eff.mode && !dayIsMarked(date)) {
        const wf = db.prepare('SELECT working_for FROM days WHERE date=?').get(date);
        buildDay(date, eff.mode, wf?.working_for || '', eff.plan);
      } else if (db.prepare('SELECT 1 FROM days WHERE date=?').get(date)) {
        syncPlanLabel(date, eff.plan);
      }
    }
    return json(res, 200, { ok: true, calendar: calendar(localParts().date, 14), today: todayPayload() });
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/admin\/plans\/(\d{4}-\d\d-\d\d)$/))) {
    db.prepare('DELETE FROM day_plans WHERE date=?').run(m[1]);
    if (m[1] === localParts().date) {
      const eff = resolveMode(m[1], localParts().dow);
      if (eff.mode && !dayIsMarked(m[1])) {
        const wf = db.prepare('SELECT working_for FROM days WHERE date=?').get(m[1]);
        buildDay(m[1], eff.mode, wf?.working_for || '', eff.plan);
      } else if (db.prepare('SELECT 1 FROM days WHERE date=?').get(m[1])) {
        syncPlanLabel(m[1], null);   // the name goes with the plan, marks stay
      }
    }
    return json(res, 200, { ok: true, calendar: calendar(localParts().date, 14) });
  }
  // "sometimes a Saturday at home is more free-form" — one tap maps that weekday
  // onto the free-form template from then on (a plan is for a single day).
  if (M === 'POST' && p === '/api/admin/free-weekday') {
    const dow = toInt(body.dow); const mode = db.prepare('SELECT id FROM modes WHERE name=?').get(String(body.mode || 'Free Day'));
    if (dow == null || !mode) return json(res, 400, { error: 'dow and a real mode required' });
    db.prepare('INSERT INTO weekday_modes(dow,mode_id) VALUES(?,?) ON CONFLICT(dow) DO UPDATE SET mode_id=excluded.mode_id').run(dow, mode.id);
    return json(res, 200, { ok: true, weekdays: Object.fromEntries(db.prepare('SELECT dow,mode_id FROM weekday_modes').all().map(r => [r.dow, r.mode_id])) });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------- http plumbing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.github.com",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // HSTS only when the app knows it is behind TLS (SECURE_COOKIES=1): sending
  // it on a plain-HTTP LAN deploy would brick every browser that visits.
  ...(SECURE ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};
const json = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((ok, bad) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) { bad(new Error('too large')); req.destroy(); } });
  req.on('end', () => {
    try {
      if (/x-www-form-urlencoded/i.test(String(req.headers['content-type']))) {
        const out = {};   // Apple's form_post callback speaks this dialect
        for (const [k, v] of new URLSearchParams(s)) out[k] = v;
        return ok(out);
      }
      ok(s ? JSON.parse(s) : {});
    } catch (e) { bad(e); }
  });
});
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404, { ...SEC_HEADERS }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SEC_HEADERS });
  fs.createReadStream(p).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // The probe is what says the SQLite volume still works: an app that answers
    // while its DB is locked or unreadable is not healthy.
    if (p === '/healthz') {
      try { db.prepare('SELECT 1 AS ok').get(); return json(res, 200, { ok: true, db: true, version: VERSION, encrypted: !!store.encrypted }); }
      catch (e) { return json(res, 503, { ok: false, error: clampStr(e.message, 120) }); }
    }
    if (p.startsWith('/api/admin/')) {
      // admin() always writes the response; the unauthenticated subset (me,
      // login, setup) handles its own gating at the top; everything else is
      // session-gated inside admin().
      await admin(req, res, url, (req.method === 'GET' || req.method === 'DELETE') ? {} : await readBody(req), 'admin');
      return;
    }
    if (p.startsWith('/api/')) {
      // Kiosk API is rate-limited per IP so an exposed install cannot be hammered.
      const ip = clientIp(req);
      if (!rateLimit('kiosk:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });
      const out = kiosk(req, res, url, req.method === 'POST' ? await readBody(req) : {});
      return out === null ? json(res, 404, { error: 'not found' }) : out;
    }
    if (p === '/admin' || p.startsWith('/admin/')) return serveStatic(res, 'admin.html');
    return serveStatic(res, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});
// Operator provisioning: non-interactive installs (Docker, PaaS templates) can
// carry the credentials in env. First-run only — an existing board is never
// overwritten, and a rotated kiosk code outlives a stale env value.
if (process.env.KIOSK_TOKEN && !getSetting('kiosk_token')) {
  setSetting('kiosk_token', String(process.env.KIOSK_TOKEN).slice(0, 64));
}
seed();
// ---- 0017: retention. Written policy: raw events (ABC, battery, tool use,
// check-ins) are kept a rolling 12 months by default — old enough to see the
// patterns the risk view needs, young enough that "last year's blows" do not
// quietly become forever. The family can widen (up to 60) or zero it out.
function pruneRetention() {
  const months = getSetting('retention_months') == null ? 12 : Number(getSetting('retention_months'));
  if (!months || !Number.isFinite(months)) return 0;
  const cutoff = fmtTs(new Date(Date.now() - Math.min(months, 120) * 30 * 864e5));
  let n = 0;
  for (const t of ['abc_events', 'battery_events', 'tool_uses', 'check_ins']) {
    n += Number(db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff).changes);
  }
  return n;
}
setInterval(() => { try { pruneRetention(); } catch {} }, 3600e3).unref();
// Calendar feed sync (0024): on save, on boot, and every 6 h. A failed
// fetch keeps the last good events and records the error — the kiosk never
// goes blank because someone's calendar had a bad day.
async function syncCalendarFeed() {
  const url = getSetting('ics_url');
  if (!url) return;
  const state = () => { try { return JSON.parse(getSetting('ics_state') || '{}'); } catch { return {}; } };
  try {
    const events = parseIcs(await fetchIcsFeed(url));
    applyCalendarEvents(events);
    setSetting('ics_state', JSON.stringify({ fetched_at: tsNow(), count: events.length, error: '' }));
  } catch (e) {
    const prev = state();
    setSetting('ics_state', JSON.stringify({ fetched_at: prev.fetched_at || null, count: calendarCount(), error: String(e.message || e).slice(0, 200) }));
  }
}
setInterval(() => { syncCalendarFeed(); }, 6 * 3600e3).unref();
try { syncCalendarFeed(); } catch {}
function applyCalendarEvents(events) {
  tx(() => {
    db.prepare('DELETE FROM calendar_events').run();
    const ins = db.prepare('INSERT INTO calendar_events(uid,summary,location,start_ts,end_ts,all_day) VALUES(?,?,?,?,?,?)');
    const now = localParts().date;
    for (const e of events) {
      if (!icsWithinWindow(e.start_ts, now)) continue;
      ins.run(e.uid, e.summary, e.location, e.start_ts, e.end_ts, e.all_day);
    }
  });
}
const calendarCount = () => db.prepare('SELECT COUNT(*) c FROM calendar_events').get().c;
if (process.env.ADMIN_PASSWORD && !getSetting('admin_hash')) {
  setSetting('admin_hash', hashPassword(String(process.env.ADMIN_PASSWORD)));
  console.log('admin password set from ADMIN_PASSWORD env (first run only)');
}
// Kiosk device migration: a pre-0009 install had one shared token in
// settings. Import it as a named device so it keeps working, and revoke-by-
// device works from then on. Runs once; the legacy setting is left in place
// (harmless) but is no longer consulted by auth.
if (!db.prepare('SELECT 1 FROM kiosk_devices LIMIT 1').get()) {
  const legacy = getSetting('kiosk_token');
  if (legacy) {
    db.prepare('INSERT INTO kiosk_devices(label,token_hash,created_at,last_used_at) VALUES(?,?,?,?)')
      .run('Original kiosk', sha256(String(legacy)), tsNow(), '');
    console.log('migrated the shared kiosk code to device "Original kiosk"');
  }
}
// Setup bootstrap token — closes the first-writer-wins race on a fresh board:
// a stranger who finds the URL before the parent cannot claim the admin account.
// Issued once (or supplied by the operator via SETUP_TOKEN for headless/PaaS
// deploys), printed once, consumed by the first successful setup.
if (!getSetting('admin_hash') && !getSetting('setup_token_hash')) {
  const raw = process.env.SETUP_TOKEN || crypto.randomBytes(32).toString('hex');
  setSetting('setup_token_hash', sha256(raw));
  console.log(process.env.SETUP_TOKEN
    ? 'setup token provided via SETUP_TOKEN env'
    : `setup token: ${raw}`);
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`behavior-dashboard listening on :${PORT} (db ${DB_PATH})`));
}
module.exports = { server, db, store, itemStatus, reward, riskFromLevels, batteryView, BATTERY_LINES, hashPassword, verifyPassword, clientIp, isPrivateAddr, profileFlags, PROFILE_PRESETS, profile };
