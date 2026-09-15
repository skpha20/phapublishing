'use strict';

/**
 * Orders, written with the service role.
 *
 * lib/catalog.js deliberately uses the anon key, because the catalogue is
 * public and nothing reading it should be able to touch an order even by
 * mistake. This module is the other half of that split: orders and order_items
 * carry no RLS policy at all, so only this key reaches them, and it never
 * leaves the server.
 */

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const READY = Boolean(URL_BASE && SERVICE_KEY);

function headers(extra = {}) {
  return {
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest(path, init = {}) {
  if (!READY) throw new Error('Supabase service role not configured');
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, init);
  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`${res.status} ${text}`.slice(0, 300));
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * The order and its single line, written before the buyer reaches Stripe.
 *
 * Recording it up front rather than on the webhook is deliberate. If it were
 * created when payment succeeded, a webhook that failed to deliver would leave
 * money taken and no record of what it was for. This way the worst case is a
 * pending row nobody paid for, which is harmless and tells you what happened.
 *
 * The line snapshots title, format and price, because what someone bought must
 * stay readable years after the catalogue moved on around it.
 */
async function createPending({ book, edition, quantity, shippingCents }) {
  const subtotal = edition.price_cents * quantity;

  const [order] = await rest('orders', {
    method: 'POST',
    headers: headers({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      status: 'pending',
      subtotal_cents: subtotal,
      shipping_cents: shippingCents,
      // Tax is computed by Stripe at checkout and total is only known once the
      // buyer has entered an address, so both are filled in by the webhook.
      tax_cents: 0,
      total_cents: 0,
      currency: (edition.currency || 'USD').toUpperCase(),
    }),
  });

  await rest('order_items', {
    method: 'POST',
    headers: headers({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      order_id: order.id,
      edition_id: edition.id,
      title: book.title,
      format: edition.format,
      signed: Boolean(edition.signed),
      unit_price_cents: edition.price_cents,
      quantity,
      fulfilment: edition.fulfilment,
      fulfilment_status: 'pending',
    }),
  });

  return order;
}

async function attachSession(orderId, sessionId) {
  return rest(`orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: headers({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ stripe_session_id: sessionId }),
  });
}

async function byId(orderId) {
  const rows = await rest(`orders?id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: headers() });
  return (rows && rows[0]) || null;
}

async function bySessionId(sessionId) {
  const rows = await rest(
    `orders?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=*`,
    { headers: headers() });
  return (rows && rows[0]) || null;
}

async function byPaymentIntent(pi) {
  const rows = await rest(
    `orders?stripe_payment_intent_id=eq.${encodeURIComponent(pi)}&select=*`,
    { headers: headers() });
  return (rows && rows[0]) || null;
}

async function itemsFor(orderId) {
  return rest(`order_items?order_id=eq.${encodeURIComponent(orderId)}&select=*`, { headers: headers() });
}

async function update(orderId, patch) {
  return rest(`orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: headers({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(patch),
  });
}

/**
 * Claim a Stripe event, returning false if it has been handled already.
 *
 * Stripe delivers at least once and retries anything that is not a 2xx, so
 * "payment succeeded" arrives more than once more often than people expect.
 * The insert is the claim: the primary key is Stripe's event id, so a second
 * delivery collides and loses, and the caller stops. Doing this in the database
 * rather than in memory is what makes it hold across two instances and a
 * restart.
 */
async function claimEvent(eventId, type, orderId = null) {
  try {
    await rest('stripe_events', {
      method: 'POST',
      headers: headers({ 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ id: eventId, type, order_id: orderId }),
    });
    return true;
  } catch (err) {
    if (err.status === 409) return false;              // already handled
    throw err;
  }
}

/**
 * Release a claim so a retry can pick the event up again.
 *
 * The claim is taken before the work is done, which is the only order that
 * makes two simultaneous deliveries safe. The cost is that a claim followed by
 * a failure would suppress Stripe's retry of an event that never actually got
 * handled, so a failed handler gives the claim back.
 */
async function releaseEvent(eventId) {
  return rest('stripe_events?id=eq.' + encodeURIComponent(eventId), {
    method: 'DELETE',
    headers: headers({ 'Prefer': 'return=minimal' }),
  });
}

/** Atomic in the database; see decrement_stock in migration 008. */
async function takeStock(editionId, qty) {
  return rest('rpc/decrement_stock', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ p_edition_id: editionId, p_qty: qty }),
  });
}

async function giveStockBack(editionId, qty) {
  return rest('rpc/restore_stock', {
    method: 'POST',
    headers: headers({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({ p_edition_id: editionId, p_qty: qty }),
  });
}

function status() {
  return { configured: READY };
}

module.exports = {
  createPending, attachSession, update,
  byId, bySessionId, byPaymentIntent, itemsFor,
  claimEvent, releaseEvent, takeStock, giveStockBack,
  status, READY,
};
