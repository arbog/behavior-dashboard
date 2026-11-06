'use strict';
// ---- 0023: OAuth sign-in primitives (zero-dependency) ----
// Apple/Google sign-in for the parent console: verify the provider's ID
// token (a JWT) against their published JWKS, with the same zero-npm rule
// as everything else. The trust rules live in server.js — this module is
// just the crypto and the cache. Public analysis: docs/integrations.md.
const crypto = require('node:crypto');

// JWKS cache: the providers' key sets rotate on their schedule, not ours —
// fetch at most hourly, per provider, and fail closed if a kid is unknown
// (a fresh fetch may have raced; a second look happens on the next attempt).
const jwksCache = new Map();   // uri -> { keys, fetched_at }
const JWKS_TTL = 3600e3;
async function getJwks(uri) {
  const hit = jwksCache.get(uri);
  if (hit && Date.now() - hit.fetched_at < JWKS_TTL) return hit.keys;
  const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`key set fetch failed (${r.status})`);
  const body = await r.json();
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('key set malformed');
  jwksCache.set(uri, { keys: body.keys, fetched_at: Date.now() });
  return body.keys;
}

// An ID token is exactly three base64url parts, signed RS256 (Apple, Google)
// or ES256. 'none' and unknown algs are refused — the alg-confusion classic.
async function verifyIdToken(idToken, { jwksUri, issuer, audience }) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('token malformed');
  const [h, p, s] = idToken.split('.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); }
  catch { throw new Error('token malformed'); }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error(`refused algorithm ${header.alg}`);
  if (!header.kid) throw new Error('token has no key id');
  const keys = await getJwks(jwksUri);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not recognized');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  const ok = crypto.verify(header.alg === 'ES256' ? 'sha256' : 'sha256', signed, key, sig);
  if (!ok) throw new Error('signature did not verify');
  if (claims.iss !== issuer) throw new Error('wrong issuer');
  if (claims.aud !== audience) throw new Error('wrong audience — this token was not for this board');
  if (!claims.exp || claims.exp <= Date.now() / 1000) throw new Error('token expired');
  if (!claims.email) throw new Error('no email on the token — re-consent with the email scope');
  return claims;
}

// Normalize the two providers' small differences into one shape.
// Google: authorization-code flow (we exchange the code, then verify).
// Apple: form_post of the finished id_token (their client_secret is THEIR
// problem — the id_token is what we verify).
const PROVIDERS = {
  google: {
    name: 'Google',
    verify: async (params, cfg) => {
      if (!params.code) throw new Error('no code from the provider');
      const body = new URLSearchParams({ code: params.code, client_id: cfg.clientId, client_secret: cfg.secret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' });
      const r = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`token exchange failed (${r.status})`);
      const t = await r.json();
      return verifyIdToken(t.id_token, { jwksUri: cfg.jwksUrl, issuer: 'https://accounts.google.com', audience: cfg.clientId });
    },
    authorizeUrl: (cfg, state) => {
      const u = new URL(cfg.authUrl);
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', cfg.redirectUri);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'openid email');
      u.searchParams.set('state', state);
      return u.toString();
    },
  },
  apple: {
    name: 'Apple',
    verify: async (params, cfg) => {
      if (!params.id_token) throw new Error('no id_token from the provider');
      return verifyIdToken(params.id_token, { jwksUri: cfg.jwksUrl, issuer: 'https://appleid.apple.com', audience: cfg.clientId });
    },
    authorizeUrl: (cfg, state) => {
      const u = new URL(cfg.authUrl);
      u.searchParams.set('client_id', cfg.clientId);
      u.searchParams.set('redirect_uri', cfg.redirectUri);
      u.searchParams.set('response_type', 'id_token');
      u.searchParams.set('response_mode', 'form_post');
      u.searchParams.set('scope', 'name email');
      u.searchParams.set('state', state);
      return u.toString();
    },
  },
};

function cfgFor(provider, origin) {
  const id = provider === 'google' ? 'GOOGLE' : provider === 'apple' ? 'APPLE' : null;
  if (!id) throw new Error('unknown provider');
  const clientId = process.env[`BD_OAUTH_${id}_CLIENT_ID`], secret = process.env[`BD_OAUTH_${id}_CLIENT_SECRET`];
  if (!clientId || !secret) throw new Error('not configured on this board');
  const d = (k, v) => process.env[`BD_OAUTH_${id}_${k}`] || v;
  return {
    clientId, secret,
    authUrl: d('AUTH_URL', provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://appleid.apple.com/auth/authorize'),
    tokenUrl: d('TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    jwksUrl: d('JWKS_URL', provider === 'google' ? 'https://www.googleapis.com/oauth2/v3/certs' : 'https://appleid.apple.com/auth/keys'),
    redirectUri: `${origin}/api/admin/oauth/${provider}/callback`,
  };
}

module.exports = { PROVIDERS, cfgFor, verifyIdToken, getJwks, jwksCache };
