const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalog = require('./lib/catalog');
const pages = require('./lib/pages');
const email = require('./lib/email');
const stripe = require('./lib/stripe');
const orders = require('./lib/orders');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
};

const LONG_CACHE = ['.webp', '.avif', '.png', '.jpg', '.jpeg', '.svg', '.woff2', '.ico', '.mp3'];

// Markup, styles and scripts are versioned together by a deploy, so they must
// revalidate every time. Serving a cached stylesheet against freshly deployed
// markup renders a broken page — the two have to move as one. "no-cache" still
// allows a 304 via the ETag below, so revalidation costs a header exchange
// rather than a re-download. Images are named per asset and change rarely, so
// they get a long TTL.
function cacheFor(ext) {
  return LONG_CACHE.includes(ext) ? 'public, max-age=604800' : 'no-cache';
}

function etagFor(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

// Railway's edge rewrites our Cache-Control on .css to a four-hour TTL, so
// asking politely for revalidation is not enough: a visitor can end up running
// a stale stylesheet against freshly deployed markup, which renders broken.
// The only reliable lever is the URL itself. Markup is served no-cache (that
// header does survive the edge), so stamping a token derived from the assets'
// own bytes onto their URLs guarantees a deploy is picked up immediately,
// while letting the edge cache each version hard and indefinitely.
const VERSIONED = ['styles.css', 'main.js'];

const ASSET_VERSION = (() => {
  try {
    const h = crypto.createHash('sha1');
    for (const f of VERSIONED) h.update(fs.readFileSync(path.join(ROOT, f)));
    return h.digest('hex').slice(0, 10);
  } catch {
    return String(Date.now());
  }
})();

function stampAssetUrls(html) {
  return html.replace(
    /(href|src)="\/(styles\.css|main\.js)"/g,
    (_, attr, file) => `${attr}="/${file}?v=${ASSET_VERSION}"`
  );
}

/* ---------------------------------------------------------------------------
   Newsletter sign-up
   The Resend key never reaches the browser, so the form posts here and this
   process talks to Resend. Both settings come from the environment: without
   them the endpoint reports itself unconfigured rather than pretending to
   have stored an address.
   --------------------------------------------------------------------------- */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID || '';
const SUBSCRIBE_READY = Boolean(RESEND_API_KEY && RESEND_AUDIENCE_ID);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Crude per-IP throttle. These forms are unauthenticated and public, so
// without this a single client could enumerate the audience or run up the API
// bill. Buckets are namespaced per endpoint — writing a long message should
// not use up someone's newsletter attempts.
const hits = new Map();
function rateLimited(key, limit = 5, windowMs = 60_000) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now - rec.start > windowMs) {
    hits.set(key, { start: now, n: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return false;
  }
  rec.n += 1;
  return rec.n > limit;
}

// Every server-rendered page goes out through here, so this is where the asset
// version gets stamped on. Doing it in the static handler alone was not enough:
// book pages are built in lib/pages.js and never touch that path, so they were
// shipping a bare /styles.css — the one URL the edge is allowed to cache for
// four hours. That is the exact stale-stylesheet-against-fresh-markup case the
// stamping exists to prevent, and it made a new page section arrive unstyled.
//
// Stamping twice is a no-op: once a URL carries ?v= it no longer matches, so
// pre-stamped markup passing through here (the 404 fallback) is left alone.
function sendHtml(res, status, html) {
  const body = Buffer.from(stampAssetUrls(html), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  res.end(body);
}

// Unknown URLs fall back to the landing page, so a mistyped book slug lands
// somewhere useful rather than on a bare error.
function serveNotFound(res) {
  fs.readFile(path.join(ROOT, 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Internal Server Error'); }
    sendHtml(res, 404, stampAssetUrls(buf.toString('utf8')));
  });
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handleSubscribe(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  if (rateLimited(`subscribe:${ip}`)) {
    return sendJson(res, 429, { ok: false, error: 'Too many attempts. Please try again in a minute.' });
  }

  let body = '';
  let tooBig = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 2048) { tooBig = true; req.destroy(); }
  });

  req.on('end', async () => {
    if (tooBig) return;

    let email = '';
    try {
      email = String((JSON.parse(body || '{}').email || '')).trim().toLowerCase();
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Could not read that request.' });
    }

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return sendJson(res, 400, { ok: false, error: 'Please enter a valid email address.' });
    }

    if (!SUBSCRIBE_READY) {
      return sendJson(res, 503, {
        ok: false,
        error: 'Sign-ups aren’t switched on yet — please email hello@phapublishing.com and we’ll add you.',
      });
    }

    try {
      const r = await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, unsubscribed: false }),
      });

      if (r.ok) return sendJson(res, 200, { ok: true, message: 'Thank you — you’re on the list.' });

      // Resend reports an existing contact as a conflict; to the visitor that
      // is a success, and saying so avoids disclosing who is already signed up.
      if (r.status === 409 || r.status === 422) {
        return sendJson(res, 200, { ok: true, message: 'Thank you — you’re on the list.' });
      }

      console.error('[subscribe] Resend responded', r.status, await r.text().catch(() => ''));
      return sendJson(res, 502, { ok: false, error: 'Something went wrong signing you up. Please try again later.' });
    } catch (err) {
      console.error('[subscribe] request failed:', err.message);
      return sendJson(res, 502, { ok: false, error: 'Something went wrong signing you up. Please try again later.' });
    }
  });
}

/* ---------------------------------------------------------------------------
   Contact form
   Stored before it is emailed. Email is the notification; the row is the
   record. A forwarding rule that breaks silently should cost Susan a nudge,
   not somebody's message.
   --------------------------------------------------------------------------- */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CONTACT_TO = process.env.CONTACT_TO || 'hello@phapublishing.com';
const CONTACT_FROM = process.env.CONTACT_FROM || 'Pha Publishing <website@phapublishing.com>';
// The acknowledgement goes to a reader, so it comes from the address a person
// would expect to see — and replies to it route to the same inbox.
const ACK_FROM = process.env.ACK_FROM || 'Pha Publishing <hello@phapublishing.com>';

async function storeMessage(row) {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Supabase not configured');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/contact_messages`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`store failed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json())[0];
}

async function markEmailed(id, patch) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/contact_messages?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.error('[contact] could not record email state:', e.message);
  }
}

function handleContact(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  let body = '';
  let tooBig = false;
  req.on('data', c => { body += c; if (body.length > 20_000) { tooBig = true; req.destroy(); } });

  req.on('end', async () => {
    if (tooBig) return;

    let p;
    try { p = JSON.parse(body || '{}'); }
    catch { return sendJson(res, 400, { ok: false, error: 'Could not read that request.' }); }

    // Honeypot: a field no human sees and no human fills. Accept silently so a
    // bot gets no feedback to tune against.
    if (String(p.website || '').trim()) {
      return sendJson(res, 200, { ok: true, message: 'Thank you — your message has been sent.' });
    }

    const name = String(p.name || '').trim().slice(0, 120);
    const from = String(p.email || '').trim().toLowerCase().slice(0, 254);
    const subject = String(p.subject || '').trim().slice(0, 200) || null;
    const message = String(p.message || '').trim().slice(0, 5000);

    if (!name) return sendJson(res, 400, { ok: false, error: 'Please tell us your name.' });
    if (!EMAIL_RE.test(from)) return sendJson(res, 400, { ok: false, error: 'Please enter a valid email address.' });
    if (message.length < 10) return sendJson(res, 400, { ok: false, error: 'Please write a little more so we can help.' });

    // Throttle only what is expensive. A rejected submission costs nothing, so
    // counting it would mean somebody who mistypes their address three times
    // is locked out for five minutes — punishing the wrong person.
    if (rateLimited(`contact:${ip}`, 3, 300_000)) {
      return sendJson(res, 429, { ok: false, error: 'Too many messages. Please try again shortly.' });
    }

    let stored;
    try {
      stored = await storeMessage({ name, email: from, subject, message });
    } catch (err) {
      console.error('[contact] store failed:', err.message);
      return sendJson(res, 502, { ok: false, error: 'Something went wrong sending your message. Please try again later.' });
    }

    // The message is safe now. Both emails are best effort from here, and a
    // failure is recorded rather than shown to the visitor — their message did
    // arrive, and telling them otherwise would only prompt a duplicate.
    const payload = { name, email: from, subject, message };

    async function send(spec) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 260)}`);
    }

    if (RESEND_API_KEY) {
      const note = email.contactNotification(payload);
      const ack = email.contactAcknowledgement(payload);

      // Sent independently: the sender should still be told their message
      // landed even if the notification to Susan fails, and vice versa.
      const [noteResult, ackResult] = await Promise.allSettled([
        send({
          from: CONTACT_FROM,
          to: [CONTACT_TO],
          reply_to: from,
          subject: note.subject,
          html: note.html,
          text: note.text,
        }),
        send({
          from: ACK_FROM,
          to: [from],
          reply_to: CONTACT_TO,
          subject: ack.subject,
          html: ack.html,
          text: ack.text,
        }),
      ]);

      const patch = {};
      if (noteResult.status === 'fulfilled') patch.emailed_at = new Date().toISOString();
      else {
        console.error('[contact] notification failed:', noteResult.reason.message);
        patch.email_error = noteResult.reason.message.slice(0, 500);
      }
      if (ackResult.status === 'fulfilled') patch.ack_emailed_at = new Date().toISOString();
      else {
        console.error('[contact] acknowledgement failed:', ackResult.reason.message);
        patch.ack_error = ackResult.reason.message.slice(0, 500);
      }
      await markEmailed(stored.id, patch);
    } else {
      await markEmailed(stored.id, {
        email_error: 'RESEND_API_KEY not configured',
        ack_error: 'RESEND_API_KEY not configured',
      });
    }

    return sendJson(res, 200, { ok: true, message: 'Thank you — your message has been sent.' });
  });
}

/* ---------------------------------------------------------------------------
   Songs
   Susan writes a song for a book and wants it both playable on the page and
   keepable, so /audio/* gets its own handler rather than falling through to the
   generic static path. Three things it does that the static path does not:

     Range requests. A five-minute MP3 is several megabytes, and without
     Accept-Ranges a listener who drags the scrubber gets nothing until the
     whole file has arrived — and re-downloads it on a reload. Every media
     element asks for ranges; answering properly is what makes seeking work.

     Streams rather than readFile. The static path buffers a whole file into
     memory per request, which is fine for a stylesheet and wasteful for a 7 MB
     song being pulled by several people at once.

     ?download=1 sends Content-Disposition, so the file lands in someone's
     music library under the song's real name instead of its URL slug. That name
     comes from the catalogue, never from the request — a filename that ends up
     in a response header is not something a visitor gets to choose.
   --------------------------------------------------------------------------- */

const AUDIO_DIR = path.join(ROOT, 'audio');

// Deliberately narrow: this is the exact shape of the names we publish, so
// there is nothing to traverse out of and no need to re-check containment.
const AUDIO_RE = /^\/audio\/([a-z0-9][a-z0-9-]{0,78}\.mp3)$/;

/** RFC 7233 single range, resolved against a known length. Null if unusable. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  let start, end;

  if (rawStart === '') {
    // "bytes=-500" — the trailing N bytes.
    const len = Number(rawEnd);
    if (!rawEnd || !Number.isFinite(len) || len <= 0) return null;
    start = Math.max(0, size - len);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }

  if (start > end || start >= size) return null; // unsatisfiable
  return { start, end };
}

function serveAudio(req, res, file, wantsDownload) {
  const target = path.join(AUDIO_DIR, file);

  fs.stat(target, async (err, stat) => {
    if (err || !stat.isFile()) return serveNotFound(res);

    const etag = etagFor(stat);
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheFor('.mp3'),
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
    };

    if (wantsDownload) {
      // Start from the file's own name and improve on it if the catalogue knows
      // the song. A database that is briefly unreachable should cost a prettier
      // filename, not the download.
      let name = file;
      try {
        const hit = await catalog.songByPath(`/audio/${file}`);
        if (hit) name = pages.downloadName(hit.book, hit.song);
      } catch (e) {
        console.error('[audio] name lookup failed:', e.message);
      }
      // downloadName already returns plain ASCII with no quotes, but a header
      // is a header: strip anything that could end the value early.
      const safe = name.replace(/[^\x20-\x7e]/g, '').replace(/["\\;]/g, '');
      headers['Content-Disposition'] = `attachment; filename="${safe}"`;
    }

    // An unchanged file needs no body. Range is ignored for a conditional hit
    // on purpose: if the ETag still matches, the client already has the file.
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        'ETag': etag,
        'Accept-Ranges': 'bytes',
        'Cache-Control': headers['Cache-Control'],
      });
      return res.end();
    }

    const asked = req.headers.range;
    const range = asked ? parseRange(asked, stat.size) : null;

    // A Range we cannot satisfy has to be refused rather than quietly answered
    // with the whole file — a player would splice the response at the wrong
    // offset and play noise.
    if (asked && !range && /^bytes=/.test(asked.trim())) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
        'Accept-Ranges': 'bytes',
      });
      return res.end();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    headers['Content-Length'] = end - start + 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;

    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(target, { start, end });
    // Skipping ahead or closing the tab aborts mid-file. That is normal, not an
    // error, and must not be able to take the process down.
    stream.on('error', (e) => {
      console.error('[audio] stream failed:', e.message);
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

/* ---------------------------------------------------------------------------
   Legacy URLs
   Pages that existed on the previous WordPress site and are still linked from
   print, social posts and other people's pages. 301 because these were only
   ever GET and are never coming back, which also moves the search ranking onto
   the new URL.

   The target is a path, not an absolute URL, so a visitor stays on the host
   they arrived on. Choosing between the apex and www is a separate decision and
   belongs in one redirect rule at the edge, not scattered per route.
   --------------------------------------------------------------------------- */

const LEGACY_REDIRECTS = new Map([
  ['/my-daughters', '/books/my-daughter'],
  ['/we-are-hmong', '/books/we-are-hmong'],
]);

/* ---------------------------------------------------------------------------
   Checkout and the Stripe webhook

   The split matters: this process never sees a card. The buy button posts here,
   this creates a Checkout Session and sends the browser to Stripe's own page,
   and Stripe tells us what happened afterwards over the webhook. The secret key
   stays in this process and the publishable key is not needed at all, because
   there is no Stripe JavaScript on the site.

   Two rules run through everything below.

   Nothing about money is taken from the request. The form sends an edition id
   and a quantity, and that is all that is trusted; every price is read back out
   of the catalogue. A form field is a suggestion from a stranger.

   The order is written BEFORE the buyer leaves for Stripe. If it were created
   when payment succeeded, a webhook that never arrived would mean money taken
   with no record of what it was for. This way the worst case is a pending row
   nobody paid for, which costs nothing and reads as exactly what it is.
   --------------------------------------------------------------------------- */

const SHIPPING_CENTS = 600;       // flat, per order
const MAX_QTY = 10;
const CHECKOUT_COUNTRIES = ['US'];

// Absolute URLs are required by Stripe for the return trip. Prefer what the
// platform tells us over the request's own Host header, which a client sets.
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');

function originFor(req) {
  return PUBLIC_BASE || `https://${req.headers.host || 'phapublishing.com'}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    let over = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { over = true; req.destroy(); }
    });
    req.on('end', () => over ? reject(new Error('body too large')) : resolve(body));
    req.on('error', reject);
  });
}

/** The buy button. Ends in a redirect to Stripe, or back with nothing charged. */
async function handleCheckout(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';

  const declined = (reason) => {
    console.warn('[checkout] declined:', reason);
    sendHtml(res, 200, pages.orderResult({ outcome: 'cancelled', order: null, items: [] }));
  };

  // A Checkout Session costs an API call and creates a row at Stripe, so this
  // is throttled harder than a page view but loosely enough that a genuine
  // buyer changing their mind twice is unaffected.
  if (rateLimited(`checkout:${ip}`, 8, 60_000)) {
    return sendHtml(res, 429, pages.orderResult({ outcome: 'cancelled', order: null, items: [] }));
  }

  if (!stripe.READY || !orders.READY) {
    return declined('stripe or supabase service role not configured');
  }

  let params;
  try {
    params = new URLSearchParams(await readBody(req, 2048));
  } catch {
    return declined('unreadable body');
  }

  const editionId = String(params.get('edition_id') || '').trim();
  if (!UUID_RE.test(editionId)) return declined('bad edition id');

  const found = await catalog.editionById(editionId).catch(() => null);
  if (!found) return declined(`unknown edition ${editionId}`);

  const { edition, book } = found;

  if (!edition.active || !(edition.price_cents > 0)) {
    return declined(`edition ${editionId} is not for sale`);
  }

  // Null stock means print-on-demand, which cannot run out.
  const ceiling = edition.stock === null ? MAX_QTY : Math.min(MAX_QTY, edition.stock);
  if (ceiling < 1) return declined(`edition ${editionId} is out of stock`);

  const asked = parseInt(params.get('quantity'), 10);
  const quantity = Math.max(1, Math.min(ceiling, Number.isFinite(asked) ? asked : 1));

  let order;
  try {
    order = await orders.createPending({ book, edition, quantity, shippingCents: SHIPPING_CENTS });
  } catch (err) {
    console.error('[checkout] could not record the order:', err.message);
    return declined('order not recorded');
  }

  const origin = originFor(req);
  const label = `${book.title} — ${edition.format === 'hardcover' ? 'Hardcover' : 'Paperback'}` +
    (edition.signed ? ', signed' : '');

  let session;
  try {
    session = await stripe.post('/checkout/sessions', {
      mode: 'payment',
      line_items: [{
        quantity,
        price_data: {
          currency: (edition.currency || 'usd').toLowerCase(),
          unit_amount: edition.price_cents,
          // Stripe Tax needs to know whether the price already includes tax.
          // These are shelf prices, so tax is added on top.
          tax_behavior: 'exclusive',
          product_data: {
            name: label,
            description: book.subtitle || undefined,
            images: book.cover_path ? [`${origin}${book.cover_path}`] : undefined,
          },
        },
      }],

      // Susan has this configured on the Stripe side; rates and registrations
      // are hers to set and should not be duplicated here.
      automatic_tax: { enabled: true },

      shipping_address_collection: { allowed_countries: CHECKOUT_COUNTRIES },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: 'Standard shipping',
          fixed_amount: { amount: SHIPPING_CENTS, currency: 'usd' },
          tax_behavior: 'exclusive',
        },
      }],

      success_url: `${origin}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/order/cancelled`,

      client_reference_id: order.reference,
      metadata: { order_id: order.id, reference: order.reference },
      // Repeated onto the payment intent so a refund event, which arrives
      // carrying a charge rather than a session, can still name the order.
      payment_intent_data: { metadata: { order_id: order.id, reference: order.reference } },
    }, { idempotencyKey: `order-${order.id}` });
  } catch (err) {
    console.error('[checkout] Stripe refused the session:', err.stripeCode || '', err.message);
    await orders.update(order.id, { status: 'cancelled', cancelled_at: new Date().toISOString() })
      .catch(() => {});
    return declined('stripe session not created');
  }

  await orders.attachSession(order.id, session.id).catch(err =>
    console.error('[checkout] could not attach session id:', err.message));

  // 303 so the browser follows with GET rather than re-POSTing to Stripe.
  res.writeHead(303, { 'Location': session.url, 'Cache-Control': 'no-store' });
  res.end();
}

/* ---------------------------------------------------------------------------
   Webhook

   Everything that makes an order real happens here rather than on the success
   page, because the success page is just wherever the buyer's browser ended up.
   A buyer who closes the tab the instant they pay still gets their book.
   --------------------------------------------------------------------------- */

function handleStripeWebhook(req, res) {
  let raw = '';
  let over = false;

  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 256 * 1024) { over = true; req.destroy(); }
  });

  req.on('end', async () => {
    if (over) { res.writeHead(413); return res.end(); }

    if (!stripe.WEBHOOK_READY || !orders.READY) {
      console.error('[stripe] webhook received but not configured');
      res.writeHead(503); return res.end();
    }

    // The signature is checked against the raw bytes, before anything is
    // parsed. Everything past this line is Stripe's word; everything before it
    // is a stranger's.
    let event;
    try {
      event = stripe.verify(raw, req.headers['stripe-signature']);
    } catch (err) {
      console.warn('[stripe] rejected webhook:', err.message);
      res.writeHead(400); return res.end();
    }

    // Claimed before it is handled, so two simultaneous deliveries cannot both
    // proceed. A 200 here tells Stripe to stop retrying something already done.
    let claimed;
    try {
      claimed = await orders.claimEvent(event.id, event.type);
    } catch (err) {
      console.error('[stripe] could not claim event:', err.message);
      res.writeHead(500); return res.end();          // let Stripe retry
    }

    if (!claimed) {
      console.log(`[stripe] ${event.type} ${event.id} already handled`);
      res.writeHead(200); return res.end('duplicate');
    }

    try {
      await dispatch(event);
      res.writeHead(200); res.end('ok');
    } catch (err) {
      console.error(`[stripe] handling ${event.type} failed:`, err.message);
      // Give the claim back, or the retry would be swallowed as a duplicate.
      await orders.releaseEvent(event.id).catch(() => {});
      res.writeHead(500); res.end();
    }
  });

  req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
}

async function dispatch(event) {
  const object = event.data && event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onPaid(object);

    // A card that needed extra time and then failed. The session is over and
    // nothing was taken, so the order is closed rather than left pending
    // forever in a queue nobody reads.
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return onClosed(object);

    case 'charge.refunded':
      return onRefunded(object);

    default:
      console.log(`[stripe] ignoring ${event.type}`);
  }
}

async function findOrder(session) {
  const byMeta = session.metadata && session.metadata.order_id;
  if (byMeta) {
    const o = await orders.byId(byMeta);
    if (o) return o;
  }
  return orders.bySessionId(session.id);
}

async function onPaid(session) {
  // A delayed payment method can complete the session while still unpaid. That
  // is not a sale yet, and async_payment_succeeded will follow if it becomes one.
  if (session.payment_status && session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.log(`[stripe] session ${session.id} completed but ${session.payment_status}; waiting`);
    return;
  }

  const order = await findOrder(session);
  if (!order) throw new Error(`no order for session ${session.id}`);

  if (order.status === 'paid' || order.status === 'fulfilled') {
    console.log(`[stripe] order ${order.reference} already paid`);
    return;
  }

  const details = session.customer_details || {};
  const breakdown = session.total_details || {};

  // Where the delivery address lives depends on the API version the webhook
  // endpoint is pinned to: Stripe moved it under collected_information, so an
  // endpoint on a recent version sends that shape and an older one sends the
  // flat field. Read both, and only fall back to the billing address if
  // neither is present — silently posting a book to the billing address is a
  // parcel that goes to the wrong house.
  const shipping = (session.collected_information && session.collected_information.shipping_details)
    || session.shipping_details
    || null;

  const ship = (shipping && shipping.address) || details.address || {};
  const shipName = (shipping && shipping.name) || details.name || null;

  if (!shipping) {
    console.warn(`[stripe] session ${session.id} carried no shipping details;` +
      ' falling back to the billing address');
  }

  await orders.update(order.id, {
    status: 'paid',
    paid_at: new Date().toISOString(),
    email: details.email || null,
    customer_name: details.name || null,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    // Stripe's arithmetic, not ours. It is what the buyer was actually charged.
    subtotal_cents: session.amount_subtotal != null ? session.amount_subtotal : order.subtotal_cents,
    shipping_cents: breakdown.amount_shipping != null ? breakdown.amount_shipping : order.shipping_cents,
    tax_cents: breakdown.amount_tax != null ? breakdown.amount_tax : 0,
    total_cents: session.amount_total != null ? session.amount_total : order.total_cents,
    currency: (session.currency || order.currency || 'usd').toUpperCase(),
    ship_name: shipName,
    ship_line1: ship.line1 || null,
    ship_line2: ship.line2 || null,
    ship_city: ship.city || null,
    ship_state: ship.state || null,
    ship_postal: ship.postal_code || null,
    ship_country: ship.country || null,
  });

  // Signed copies come off a shelf. Print-on-demand lines return true without
  // touching anything, so this is a no-op for everything sold today.
  for (const item of await orders.itemsFor(order.id)) {
    if (!item.edition_id) continue;
    const took = await orders.takeStock(item.edition_id, item.quantity);
    if (took === false) {
      console.error(`[stripe] order ${order.reference}: not enough stock for edition ${item.edition_id}` +
        ' — paid, needs manual attention');
    }
  }

  console.log(`[stripe] order ${order.reference} paid`);
}

async function onClosed(session) {
  const order = await findOrder(session);
  if (!order || order.status !== 'pending') return;

  await orders.update(order.id, {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
  });
  console.log(`[stripe] order ${order.reference} cancelled`);
}

/**
 * A refund, which only ever originates in the Stripe dashboard.
 *
 * Without this the site would go on saying "paid" for money that had been given
 * back, and the line would sit in the fulfilment queue waiting to be posted.
 *
 * Partial refunds stay 'paid' with an amount recorded against them. Calling a
 * $5 goodwill refund on a $35 order 'refunded' would read, a year later, as a
 * book that came back.
 */
async function onRefunded(charge) {
  const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  const byMeta = charge.metadata && charge.metadata.order_id;

  let order = byMeta ? await orders.byId(byMeta) : null;
  if (!order && pi) order = await orders.byPaymentIntent(pi);
  if (!order) throw new Error(`no order for charge ${charge.id}`);

  const refunded = charge.amount_refunded || 0;
  const full = refunded >= (charge.amount || 0);

  await orders.update(order.id, {
    refunded_cents: refunded,
    refunded_at: new Date().toISOString(),
    ...(full ? { status: 'refunded' } : {}),
  });

  // Only a full refund puts the books back; a partial one is a price
  // adjustment, not a return.
  if (full) {
    for (const item of await orders.itemsFor(order.id)) {
      if (item.edition_id) await orders.giveStockBack(item.edition_id, item.quantity);
    }
  }

  console.log(`[stripe] order ${order.reference} refunded ${refunded} (${full ? 'full' : 'partial'})`);
}

/** The page the buyer lands on coming back from Stripe. */
async function handleOrderResult(req, res, url, outcome) {
  if (outcome === 'cancelled') {
    return sendHtml(res, 200, pages.orderResult({ outcome, order: null, items: [] }));
  }

  const sessionId = String(url.searchParams.get('session_id') || '');
  let order = null;
  let items = [];

  if (sessionId && orders.READY) {
    try {
      order = await orders.bySessionId(sessionId);
      if (order) items = await orders.itemsFor(order.id);
    } catch (err) {
      console.error('[order] lookup failed:', err.message);
    }
  }

  sendHtml(res, 200, pages.orderResult({ outcome: 'success', order, items }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/contact') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      return res.end('Method Not Allowed');
    }
    return handleContact(req, res);
  }

  if (url.pathname === '/api/subscribe') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      return res.end('Method Not Allowed');
    }
    return handleSubscribe(req, res);
  }

  if (url.pathname === '/api/checkout') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      return res.end('Method Not Allowed');
    }
    return handleCheckout(req, res).catch(err => {
      console.error('[checkout] unhandled:', err.message);
      sendHtml(res, 500, pages.orderResult({ outcome: 'cancelled', order: null, items: [] }));
    });
  }

  if (url.pathname === '/api/stripe/webhook') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      return res.end('Method Not Allowed');
    }
    return handleStripeWebhook(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  // Health endpoint for Railway. Reports the catalogue too, so a shop that has
  // quietly lost its database is visible without reading logs.
  if (url.pathname === '/healthz') {
    const c = catalog.status();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      catalog: c,
      stripe: stripe.status(),
      orders: orders.status(),
    }));
  }

  // Old WordPress URLs, kept working. Any query string rides along so a
  // campaign's utm tags survive the hop.
  const legacy = LEGACY_REDIRECTS.get(url.pathname.replace(/\/+$/, '') || '/');
  if (legacy) {
    res.writeHead(301, {
      'Location': legacy + url.search,
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end();
  }

  // ── Back from Stripe ────────────────────────────────────────────
  if (url.pathname === '/order/success' || url.pathname === '/order/cancelled') {
    const outcome = url.pathname.endsWith('cancelled') ? 'cancelled' : 'success';
    return handleOrderResult(req, res, url, outcome).catch(err => {
      console.error('[order] page failed:', err.message);
      sendHtml(res, 500, '<h1>Something went wrong</h1>');
    });
  }

  // ── Songs ───────────────────────────────────────────────────────────────
  const audioMatch = AUDIO_RE.exec(url.pathname);
  if (audioMatch) {
    return serveAudio(req, res, audioMatch[1], url.searchParams.get('download') === '1');
  }

  // ── Book pages ──────────────────────────────────────────────────────────
  // Rendered from the database rather than stored as files, so a price or a
  // description edited in Supabase is live without a deploy.
  if (url.pathname === '/books' || url.pathname === '/books/') {
    return catalog.all()
      .then(books => sendHtml(res, 200, pages.booksIndex(books)))
      .catch(err => {
        console.error('[books] index failed:', err.message);
        sendHtml(res, 500, '<h1>Something went wrong</h1>');
      });
  }

  const bookMatch = url.pathname.match(/^\/books\/([a-z0-9-]{1,80})\/?$/i);
  if (bookMatch) {
    return catalog.bySlug(bookMatch[1].toLowerCase())
      .then(book => {
        if (!book) return serveNotFound(res);
        sendHtml(res, 200, pages.bookPage(book));
      })
      .catch(err => {
        console.error('[books] page failed:', err.message);
        sendHtml(res, 500, '<h1>Something went wrong</h1>');
      });
  }

  // Resolve within ROOT only — reject any path that escapes it.
  const rel = decodeURIComponent(url.pathname);
  const base = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!base.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  // Clean URLs: /privacy serves privacy.html, /foo/ serves foo/index.html.
  const candidates = path.extname(base)
    ? [base]
    : [base, base + '.html', path.join(base, 'index.html')];

  let stat = null;
  const target = candidates.find(p => {
    try {
      const s = fs.statSync(p);
      if (s.isFile()) { stat = s; return true; }
      return false;
    } catch { return false; }
  }) || base;

  // Let an unchanged file answer with 304 instead of resending its body. The
  // asset version is folded into the markup's tag, so changing only the CSS
  // still invalidates the HTML that points at it.
  if (stat) {
    const isHtml = path.extname(target).toLowerCase() === '.html';
    const etag = isHtml
      ? etagFor(stat).replace(/"$/, `-${ASSET_VERSION}"`)
      : etagFor(stat);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, {
        'ETag': etag,
        'Cache-Control': cacheFor(path.extname(target).toLowerCase()),
      });
      return res.end();
    }
  }

  fs.readFile(target, (err, buf) => {
    // Everything unmatched falls back to the landing page. serveNotFound does
    // exactly this and does it properly — stamped asset URLs and the security
    // headers — where the copy that used to live here had neither.
    if (err) return serveNotFound(res);
    const ext = path.extname(target).toLowerCase();
    let body = buf;
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheFor(ext),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    };

    if (ext === '.html') {
      body = Buffer.from(stampAssetUrls(buf.toString('utf8')), 'utf8');
      if (stat) headers['ETag'] = etagFor(stat).replace(/"$/, `-${ASSET_VERSION}"`);
    } else if (stat) {
      headers['ETag'] = etagFor(stat);
    }

    res.writeHead(200, headers);
    res.end(body);
  });
});

server.listen(PORT, () => {
  console.log(`phapublishing-website listening on ${PORT}`);
});
