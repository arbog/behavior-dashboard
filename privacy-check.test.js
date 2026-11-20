// scripts/privacy-check.sh must fail closed and catch added lines, never removed ones.
// Runs against a throwaway git repo and a FAKE denylist; the real one is private and not in this repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scripts', 'privacy-check.sh');
// core.hooksPath=/dev/null: the fixture is a throwaway repo, so a contributor's global git hooks
// (e.g. a worktree-only guard) must not apply to it.
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null'];

function git(cwd, ...args) {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// A repo with `main` holding one file, then a `feature` branch the test edits.
function fixture(denylist) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privcheck-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'a clean line\nZEBRA lives here on main\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'switch', '-qc', 'feature');
  const deny = path.join(dir, 'denylist.txt');
  if (denylist !== null) fs.writeFileSync(deny, denylist);
  return { dir, deny };
}

function run({ dir, deny }, base = 'main') {
  return spawnSync('bash', [SCRIPT, base], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, BEHAVIOR_DASHBOARD_DENYLIST: deny },
  });
}

function commit(dir, file, text, msg = 'change') {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', msg);
}

test('clean branch passes', () => {
  const f = fixture('# comment\n\\bzebra\\b\n');
  commit(f.dir, 'notes.md', 'a clean line\nZEBRA lives here on main\nanother clean line\n');
  // ZEBRA already existed on main: only ADDED lines count, so this must pass.
  const r = run(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean/);
});

test('an added line that matches fails, case-insensitively, and reports it', () => {
  const f = fixture('\\bzebra\\b\n');
  commit(f.dir, 'new.md', 'hello\nthe Zebra is here\n');
  const r = run(f);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Zebra/);
});

test('word boundaries: a substring of a longer word is not a hit', () => {
  const f = fixture('\\bmorro\\b\n');
  commit(f.dir, 'new.md', 'see you tomorrow\n');
  assert.strictEqual(run(f).status, 0);
});

test('a match only on a REMOVED line is fine', () => {
  const f = fixture('\\bzebra\\b\n');
  commit(f.dir, 'notes.md', 'a clean line\n');
  assert.strictEqual(run(f).status, 0);
});

test('a match in a commit message fails', () => {
  const f = fixture('\\bzebra\\b\n');
  commit(f.dir, 'new.md', 'hello\n', 'mention the zebra');
  assert.strictEqual(run(f).status, 1);
});

test('uncommitted edits to tracked files are checked too', () => {
  const f = fixture('\\bzebra\\b\n');
  fs.writeFileSync(path.join(f.dir, 'notes.md'), 'a clean line\nZEBRA lives here on main\nnew zebra line\n');
  assert.strictEqual(run(f).status, 1);
});

test('fails closed: missing denylist, empty denylist, unknown base', () => {
  const missing = fixture(null);
  assert.strictEqual(run(missing).status, 2);
  const empty = fixture('# only a comment\n\n');
  assert.strictEqual(run(empty).status, 2);
  const ok = fixture('\\bzebra\\b\n');
  assert.strictEqual(run(ok, 'no-such-ref').status, 2);
});
