'use strict';
// The Dockerfile is a hand-written allowlist of files, and it has drifted once
// already: when `ics.js` landed, `COPY server.js webauthn.js store.js oauth.js`
// did not, so the published :latest image died on boot with
//
//   Error: Cannot find module './ics.js'
//
// in the cluster (found 2026-11-05 deploying the dev board) while every test
// here passed — the tests run from the checkout, where the file exists. Nothing
// in `node --test` can catch a missing COPY, so this test reads the Dockerfile
// and proves the shipped file set actually closes over every local `require()`
// reachable from the container's entrypoint.
//
// It is deliberately a static check: no docker daemon, no build, so it runs in
// the same `node --test` pass as everything else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

// --- tiny glob, because there are no dependencies to reach for ---------------
// Supports `*` within one path segment, which is all this Dockerfile uses.
function globToRegex(pattern) {
  const escaped = pattern
    .split('')
    .map(c => (c === '*' ? '[^/]*' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp('^' + escaped + '$');
}

function isIgnored(relPath) {
  return dockerignore.some(pattern => {
    const p = pattern.replace(/^\.\//, '');
    if (p.includes('/')) return relPath === p || relPath.startsWith(p + '/');
    return globToRegex(p).test(relPath) || globToRegex(p).test(path.basename(relPath));
  });
}

// --- the file set the image gets --------------------------------------------
// Parses `COPY <src...> <dest>` (no --from stages here) and expands sources
// against the checkout, honouring .dockerignore the way the builder does.
const copied = new Set(); // paths relative to ROOT, as they land in the image
const imageName = new Map(); // in-image path -> source path

const copyLines = dockerfile.split('\n').filter(l => /^\s*COPY\s/.test(l));
assert.ok(copyLines.length > 0, 'Dockerfile has no COPY lines — parser is wrong');

for (const line of copyLines) {
  const tokens = line.trim().split(/\s+/).slice(1).filter(t => !t.startsWith('--'));
  const dest = tokens.pop();
  assert.ok(tokens.length > 0, `COPY line has no source: ${line}`);

  for (const src of tokens) {
    const matches = [];
    if (src.includes('*')) {
      const re = globToRegex(src);
      for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (entry.isFile() && re.test(entry.name)) matches.push(entry.name);
      }
    } else {
      matches.push(src);
    }
    for (const m of matches) {
      if (isIgnored(m)) continue;
      copied.add(m);
      imageName.set(dest.endsWith('/') ? dest + path.basename(m) : dest, m);
    }
  }
}

// --- walk requires from the entrypoint ---------------------------------------
const CMD = dockerfile.match(/^CMD\s+\[([^\]]*)\]/m);
assert.ok(CMD, 'Dockerfile has no JSON-form CMD to find the entrypoint from');
const entry = JSON.parse('[' + CMD[1] + ']').pop();
assert.ok(copied.has(entry), `entrypoint ${entry} is not COPYed into the image`);

const missing = [];
const seen = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (!/\.js$/.test(file)) return;
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of source.matchAll(/require\((['"])\.\/([^'"]+)\1\)/g)) {
    const dep = m[2];
    const inImage = copied.has(dep);
    if (!inImage) {
      missing.push(`${file} requires ./${dep}, which the Dockerfile does not ship`);
      continue;
    }
    walk(dep);
  }
}
walk(entry);

test('every module reachable from the entrypoint is COPYed into the image', () => {
  assert.deepStrictEqual(missing, [], missing.join('\n'));
});

test('the entrypoint is server.js and it reaches the modules the API needs', () => {
  assert.strictEqual(entry, 'server.js');
  // A canary for the specific regression: these are required transitively today.
  for (const dep of ['ics.js', 'store.js', 'webauthn.js', 'oauth.js']) {
    assert.ok(seen.has(dep), `expected server.js to require ${dep} — walker may be broken`);
  }
});

test('test files and other non-runtime files stay out of the image', () => {
  for (const file of copied) {
    assert.ok(!/\.test\.js$/.test(file), `${file} should not be shipped (.dockerignore it)`);
  }
  assert.ok(!copied.has('compose.yaml'), 'compose.yaml should not be shipped');
  assert.ok(copied.has('public'), 'public/ assets must be shipped');
});

test('nothing in the image is silently ignored by .dockerignore', () => {
  // A pattern that excludes a required file would make the COPY a no-op and the
  // container crash exactly the way ics.js did — check the ones that matter.
  for (const required of ['server.js', 'package.json']) {
    assert.strictEqual(isIgnored(required), false, `${required} must not be dockerignored`);
  }
});
