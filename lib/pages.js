'use strict';

/**
 * Server-rendered book pages.
 *
 * The site is plain HTML with no client framework, so these are built as
 * strings on the server and shipped complete. Anything interpolated from the
 * database is escaped — book copy is edited by a person, and a stray "&" or a
 * smart quote should never be able to break the markup.
 */

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(cents, currency = 'USD') {
  if (cents == null) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

const HEAD = (title, description, extra = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#12325c">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=Playfair+Display:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
${extra}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>`;

const HEADER = `
<header class="site-header">
  <span class="orn orn--header" aria-hidden="true"></span>
  <div class="wrap header-inner">
    <a class="brand" href="/"><img src="/img/logo.webp" alt="Pha Publishing" width="460" height="307"></a>
    <button class="nav-toggle" aria-expanded="false" aria-controls="nav" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
    <nav class="nav" id="nav">
      <ul>
        <li><a href="/">Home</a></li>
        <li><a href="/books">Books</a></li>
        <li><a href="/#about">About</a></li>
        <li><a href="/#mission">Pha Publishing</a></li>
        <li><a href="/#author">Author</a></li>
        <li><a href="/#contact">Contact</a></li>
      </ul>
      <a class="btn btn--gold btn--shop" href="/books">Shop Books</a>
    </nav>
  </div>
</header>`;

const FOOTER = `
<footer class="site-footer">
  <span class="orn orn--footer" aria-hidden="true"></span>
  <div class="wrap footer-bottom footer-bottom--solo">
    <p>&copy; <span id="year">2026</span> Pha Publishing. All rights reserved.
      <span class="credit">Platform by <a href="https://initiateconcept.com/?utm_source=phapublishing&amp;utm_medium=referral&amp;utm_campaign=platform-credit" rel="noopener">Initiate Concept</a>.</span>
    </p>
    <p class="footer-tags"><a href="/privacy">Privacy Policy</a><i>|</i><a href="/terms">Terms of Use</a></p>
  </div>
</footer>
<script src="/main.js" defer></script>
</body>
</html>`;

const FORMAT_LABEL = { paperback: 'Paperback', hardcover: 'Hardcover' };

/** One purchase option. Only ever rendered for an edition that can be bought. */
function editionCard(book, e) {
  const format = FORMAT_LABEL[e.format] || e.format;
  const label = e.signed ? `${format} — signed` : format;
  const low = e.signed && e.stock !== null && e.stock > 0 && e.stock <= 5;

  return `
      <li class="buy">
        <div class="buy__head">
          <h3>${esc(label)}</h3>
          <p class="buy__price">${esc(money(e.price_cents, e.currency))}</p>
        </div>
        <p class="buy__note">${e.signed
          ? 'Signed and personally posted by Susan.'
          : 'Printed to order and shipped by our print partner.'}</p>
        ${low ? `<p class="buy__stock">Only ${e.stock} left</p>` : ''}
        <form class="buy__form" method="POST" action="/api/checkout">
          <input type="hidden" name="edition_id" value="${esc(e.id)}">
          <label class="sr-only" for="qty-${esc(e.id)}">Quantity</label>
          <input class="buy__qty" id="qty-${esc(e.id)}" name="quantity" type="number"
                 value="1" min="1" max="${e.signed && e.stock ? e.stock : 10}" inputmode="numeric">
          <button class="btn ${e.signed ? 'btn--gold' : 'btn--navy'}" type="submit">
            Add to order <span aria-hidden="true">→</span>
          </button>
        </form>
      </li>`;
}

function retailerList(book) {
  if (!book.retailers.length) return '';
  return `
      <div class="retailers">
        <p class="retailers__label">Also available at</p>
        <ul>
          ${book.retailers.map(r =>
            `<li><a href="${esc(r.url)}" rel="noopener nofollow">${esc(r.retailer)}</a></li>`).join('\n          ')}
        </ul>
      </div>`;
}

function bookPage(book) {
  const buyable = book.editions.filter(e => e.price_cents > 0 && (e.stock === null || e.stock > 0));

  // A book with no priced edition is the normal state before Susan sets
  // prices. Saying so plainly beats showing a button that cannot work.
  const purchase = buyable.length
    ? `<ul class="buy-list">${buyable.map(e => editionCard(book, e)).join('')}\n      </ul>`
    : `<p class="buy-soon">Available to order soon${book.retailers.length ? ' — in the meantime you can find it at the retailers below' : ''}.</p>`;

  const title = `${book.title} — Pha Publishing`;

  return HEAD(title, book.description || book.title, `
<meta property="og:type" content="book">
<meta property="og:title" content="${esc(book.title)}">
<meta property="og:description" content="${esc(book.description || '')}">
${book.cover_path ? `<meta property="og:image" content="${esc(book.cover_path)}">` : ''}
<link rel="canonical" href="https://phapublishing.com/books/${esc(book.slug)}">`)
  + HEADER + `
<main id="main" class="bookpage">
  <span class="orn orn--bookpage" aria-hidden="true"></span>
  <div class="wrap bookpage__inner">

    <p class="crumb"><a href="/books">← All books</a></p>

    <div class="bookpage__grid">
      <div class="bookpage__cover">
        ${book.cover_path
          ? `<img src="${esc(book.cover_path)}" alt="Cover of ${esc(book.title)}" width="520" height="650">`
          : ''}
      </div>

      <div class="bookpage__detail">
        <h1>${esc(book.title)}</h1>
        ${book.subtitle ? `<p class="bookpage__sub">${esc(book.subtitle)}</p>` : ''}
        <p class="bookpage__author">${esc(book.author)}</p>
        ${book.description ? `<p class="bookpage__desc">${esc(book.description)}</p>` : ''}
        ${purchase}
        ${retailerList(book)}
      </div>
    </div>
  </div>
</main>` + FOOTER;
}

function booksIndex(books) {
  const cards = books.map(b => {
    // Titles sell in more than one format, so the index shows the entry price
    // and says so, rather than picking one and looking like the only option.
    const sellable = b.editions.filter(e => e.price_cents > 0 && (e.stock === null || e.stock > 0));
    const cheapest = sellable.length ? Math.min(...sellable.map(e => e.price_cents)) : null;
    const multiple = new Set(sellable.map(e => e.format)).size > 1;

    return `
        <li class="book">
          <a class="book__link" href="/books/${esc(b.slug)}">
            <div class="book__cover">
              ${b.cover_path ? `<img src="${esc(b.cover_path)}" alt="Cover of ${esc(b.title)}" width="520" height="650" loading="lazy">` : ''}
            </div>
            <h2>${esc(b.title)}</h2>
          </a>
          ${cheapest !== null
            ? `<p class="book__price">${multiple ? 'From ' : ''}${esc(money(cheapest))}</p>`
            : ''}
          ${b.description ? `<p>${esc(b.description)}</p>` : ''}
          <a class="btn btn--navy" href="/books/${esc(b.slug)}">
            ${b.buyable ? 'Buy the book' : 'Read more'} <span aria-hidden="true">→</span>
          </a>
        </li>`;
  }).join('');

  return HEAD('Books — Pha Publishing',
    'Books by Susan Kaying Pha, published by Pha Publishing.',
    '<link rel="canonical" href="https://phapublishing.com/books">')
  + HEADER + `
<main id="main" class="books books--index">
  <span class="orn orn--books-l" aria-hidden="true"></span>
  <span class="orn orn--books-r" aria-hidden="true"></span>
  <div class="wrap">
    <p class="eyebrow">Our Books</p>
    <h1 class="section-title">Meaningful Books for a Brighter Tomorrow</h1>
    ${books.length
      ? `<ul class="book-grid">${cards}\n      </ul>`
      : `<p class="buy-soon">Our titles are being listed — please check back shortly.</p>`}
  </div>
</main>` + FOOTER;
}

module.exports = { bookPage, booksIndex, esc, money };
