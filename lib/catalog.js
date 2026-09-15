'use strict';

/**
 * The book catalogue, read from Supabase.
 *
 * Every page render needs this, so it is cached in memory and refreshed on a
 * timer rather than fetched per request. Two deliberate behaviours:
 *
 *   A failed refresh keeps serving the last good copy. Supabase being briefly
 *   unreachable should not turn the shop into an error page — stale book
 *   descriptions are vastly better than no site.
 *
 *   The anon key is used, not the service role. These tables are public by
 *   policy and nothing here should be able to read an order even by mistake.
 */

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const CONFIGURED = Boolean(URL_BASE && ANON_KEY);

const TTL_MS = 60_000;

let cache = { books: [], fetchedAt: 0, ok: false };
let inFlight = null;

async function get(path) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  return res.json();
}

/** Like get(), but a failure is logged and treated as "no rows". */
async function optional(path, label) {
  try {
    return await get(path);
  } catch (err) {
    console.error(`[catalog] ${label} unavailable:`, err.message);
    return [];
  }
}

async function load() {
  const [books, editions, links, songs] = await Promise.all([
    get('books?select=*&active=is.true&order=position'),
    get('book_editions?select=*&active=is.true'),
    get('retailer_links?select=*&order=position'),
    // Songs are an enhancement, not the shop. If this one query fails the rest
    // of the catalogue must still load: that is what makes the deploy safe
    // before its migration has run, and it means a song table problem can never
    // cost Susan a book page.
    optional('book_songs?select=*&active=is.true&order=position', 'book_songs'),
  ]);

  const byBook = (arr) => arr.reduce((m, row) => {
    (m[row.book_id] = m[row.book_id] || []).push(row);
    return m;
  }, {});

  const ed = byBook(editions);
  const rl = byBook(links);
  const sg = byBook(songs);

  return books.map(b => {
    const mine = ed[b.id] || [];
    return {
      ...b,
      // Paperback before hardcover, unsigned before signed — cheapest and
      // most common option first, which is the order a reader expects.
      editions: mine.slice().sort((x, y) =>
        (x.format === y.format)
          ? Number(x.signed) - Number(y.signed)
          : (x.format === 'paperback' ? -1 : 1)),
      retailers: rl[b.id] || [],
      songs: sg[b.id] || [],
      // "Can someone actually buy this right now?" is asked on every page, so
      // answer it once here rather than re-deriving the rule in each template.
      buyable: mine.some(e => e.price_cents > 0 && (e.stock === null || e.stock > 0)),
    };
  });
}

async function refresh() {
  if (!CONFIGURED) return cache;
  if (inFlight) return inFlight;

  inFlight = load()
    .then(books => {
      cache = { books, fetchedAt: Date.now(), ok: true };
      return cache;
    })
    .catch(err => {
      console.error('[catalog] refresh failed:', err.message);
      cache = { ...cache, fetchedAt: Date.now() }; // back off; keep last good data
      return cache;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

/** All active books. Never throws; may return an empty list. */
async function all() {
  if (!CONFIGURED) return [];
  if (Date.now() - cache.fetchedAt > TTL_MS) await refresh();
  return cache.books;
}

async function bySlug(slug) {
  return (await all()).find(b => b.slug === slug) || null;
}

/**
 * The song served from a given path, with its book attached.
 *
 * Used so a download can be named from the catalogue rather than from the
 * request — a filename that reaches a response header should never be
 * something a visitor got to choose.
 */
/**
 * One edition, with the book it belongs to.
 *
 * Checkout is handed an edition id by a form, and a price must never be taken
 * from that form — only the id is trusted, and everything charged is read back
 * from here.
 */
async function editionById(id) {
  for (const book of await all()) {
    const edition = (book.editions || []).find(e => e.id === id);
    if (edition) return { edition, book };
  }
  return null;
}

async function songByPath(audioPath) {
  for (const book of await all()) {
    const song = (book.songs || []).find(s => s.audio_path === audioPath);
    if (song) return { song, book };
  }
  return null;
}

function status() {
  return {
    configured: CONFIGURED,
    ok: cache.ok,
    count: cache.books.length,
    ageMs: cache.fetchedAt ? Date.now() - cache.fetchedAt : null,
  };
}

module.exports = { all, bySlug, editionById, songByPath, refresh, status };
