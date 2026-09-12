-- ============================================================
-- 002_seed_books.sql — the four titles
-- ------------------------------------------------------------
-- Titles, subtitles, descriptions and cover art only. Every field here comes
-- from the approved homepage copy or the cover art itself.
--
-- NO EDITIONS ARE CREATED. An edition is the sellable thing, and it needs a
-- price and (for signed copies) a stock count. Neither is known yet, and a
-- placeholder price on a storefront is the single worst thing to invent: it
-- either sells a book for the wrong money or reads as real to whoever sees it
-- next. Product pages render without editions and simply offer nothing to buy
-- until real ones exist.
--
-- Note "Success That Looks Like Me" is co-authored — the author column is
-- per-book for exactly this reason rather than a site-wide constant.
--
-- Idempotent: re-running refreshes copy, never duplicates a title.
-- ============================================================

insert into public.books (slug, title, subtitle, author, description, cover_path, position)
values
  ('hmong-names',
   'Hmong Names',
   'Reference Book — 1st Edition',
   'Susan Kaying Pha',
   'Over 7,000 traditional, popular, famous and gender neutral names, their meanings, variations and spellings.',
   '/img/book-hmong-names.webp',
   1),

  ('my-daughter',
   'My Daughter',
   'From my heart, for you.',
   'Susan Pha',
   'A heartfelt collection of messages about love, identity, and the hopes we hold for our children.',
   '/img/book-my-daughter.webp',
   2),

  ('success-that-looks-like-me',
   'Success That Looks Like Me',
   '25 Successful Hmong Men and Women from across the United States',
   'Susan Kaying Pha and Nicolas Vachoua Pha',
   '25 successful Hmong men and women from across the United States sharing their journeys, wisdom, and inspiration.',
   '/img/book-success.webp',
   3),

  ('we-are-hmong',
   'We Are Hmong',
   'Fierce and Strong',
   'Susan Kaying Pha',
   'A celebration of Hmong identity, resilience, and the strength of our community.',
   '/img/book-we-are-hmong.webp',
   4)

on conflict (slug) do update
  set title       = excluded.title,
      subtitle    = excluded.subtitle,
      author      = excluded.author,
      description = excluded.description,
      cover_path  = excluded.cover_path,
      position    = excluded.position;
