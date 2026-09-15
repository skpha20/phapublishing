'use strict';

/**
 * Stripe, over fetch.
 *
 * No SDK, for the same reason the rest of this site has no dependencies: the
 * two things needed here are a form-encoded POST and an HMAC check, and both
 * are a few lines of Node. A payment dependency is also the one you least want
 * updating itself unattended.
 *
 * The secret key never leaves this process. The browser is sent to Stripe's own
 * hosted page, so no card detail ever touches phapublishing.com.
 */

const crypto = require('crypto');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Pinned rather than floating. A Stripe API version changes response shapes,
// and a shop should start charging differently only when someone decided it
// should, not because a date passed.
const API_VERSION = '2024-06-20';
const API = 'https://api.stripe.com/v1';

const READY = Boolean(SECRET);
const WEBHOOK_READY = Boolean(WEBHOOK_SECRET);

/**
 * Stripe takes form-encoded bodies and expresses nesting in the key:
 * line_items[0][price_data][unit_amount]=1999. Arrays are indexed, objects are
 * bracketed, and nothing is JSON.
 */
function encode(value, prefix, out) {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => encode(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      encode(value[key], prefix ? `${prefix}[${key}]` : key, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
}

function form(params) {
  const out = [];
  encode(params, '', out);
  return out.join('&');
}

async function post(path, params, opts = {}) {
  if (!READY) throw new Error('STRIPE_SECRET_KEY not configured');

  const headers = {
    'Authorization': `Bearer ${SECRET}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': API_VERSION,
  };

  // Stripe deduplicates on this key for 24 hours, so a retried checkout after
  // a dropped connection reuses the first session instead of opening a second.
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: form(params) });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const e = data && data.error ? data.error : {};
    const err = new Error(e.message || `Stripe ${res.status}`);
    err.stripeCode = e.code || e.type || String(res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function get(path) {
  if (!READY) throw new Error('STRIPE_SECRET_KEY not configured');
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${SECRET}`, 'Stripe-Version': API_VERSION },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Stripe ${res.status}`);
  return data;
}

/**
 * Verify a webhook against the raw request body.
 *
 * This is the only thing standing between Stripe's word and anyone who knows
 * the URL. Without it, a stranger could POST "payment succeeded" and have
 * Susan post a book for free.
 *
 * Three things matter and each is a way people get this wrong:
 *
 *   The RAW bytes are signed, not a parsed-and-restringified object. Re-encoding
 *   JSON reorders keys and changes spacing, and the signature stops matching.
 *
 *   The timestamp is checked, or a valid old payload captured once can be
 *   replayed forever.
 *
 *   The comparison is timing-safe. A byte-at-a-time compare leaks the expected
 *   signature to anyone patient enough to measure it.
 */
function verify(rawBody, header, secret = WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
  if (!rawBody || !header) throw new Error('missing body or signature');

  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }

  if (!timestamp || !signatures.length) throw new Error('malformed signature header');

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) throw new Error('signature timestamp outside tolerance');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const matched = signatures.some(sig => {
    const sigBuf = Buffer.from(sig, 'utf8');
    // timingSafeEqual throws on a length mismatch, which is itself a leak-free
    // rejection — but it has to be guarded rather than thrown out of here.
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });

  if (!matched) throw new Error('signature mismatch');

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error('signed body was not JSON');
  }
}

function status() {
  return {
    configured: READY,
    webhookConfigured: WEBHOOK_READY,
    mode: SECRET.startsWith('sk_live_') ? 'live' : SECRET.startsWith('sk_test_') ? 'test' : 'unset',
  };
}

module.exports = { post, get, verify, form, status, READY, WEBHOOK_READY, API_VERSION };
