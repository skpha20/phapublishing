const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
};

const LONG_CACHE = ['.webp', '.avif', '.png', '.jpg', '.jpeg', '.svg', '.woff2', '.ico'];

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

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  // Health endpoint for Railway.
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
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
