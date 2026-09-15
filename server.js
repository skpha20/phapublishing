const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const catalog = require('./lib/catalog');
const pages = require('./lib/pages');
const email = require('./lib/email');

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

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  // Health endpoint for Railway. Reports the catalogue too, so a shop that has
  // quietly lost its database is visible without reading logs.
  if (url.pathname === '/healthz') {
    const c = catalog.status();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, catalog: c }));
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
    if (err) {
      // Everything unmatched falls back to the landing page.
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, fallback) => {
        if (e2) {
          res.writeHead(500);
          return res.end('Internal Server Error');
        }
        res.writeHead(404, { 'Content-Type': TYPES['.html'] });
        res.end(fallback);
      });
    }
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
