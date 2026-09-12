-- ============================================================
-- 003_edition_format.sql — format is the variant, signing is an attribute
-- ------------------------------------------------------------
-- 001 modelled an edition as kind = standard | signed, with a unique
-- constraint of (book_id, kind). That was wrong, and the real prices proved
-- it: My Daughter and We Are Hmong each sell in paperback AND hardcover at
-- different prices, which the old shape cannot represent at all — one book
-- could hold at most one "standard" row.
--
-- The mistake was assuming the axis that splits a title into products is who
-- ships it. It isn't. The axis is FORMAT — a hardcover is a different object
-- with a different cost, and both of the colour-printed titles carry a
-- premium for it. Whether a copy is signed is a separate, orthogonal fact:
-- any format can in principle be signed, and signing is what decides who
-- fulfils it.
--
-- So an edition is now (book, format, signed):
--
--   paperback, unsigned   printed to order by IngramSpark
--   hardcover, unsigned   printed to order by IngramSpark
--   paperback, signed     off Susan's shelf, posted by her
--   hardcover, signed     off Susan's shelf, posted by her
--
-- Safe to restructure destructively: book_editions and order_items are both
-- empty, verified before writing this. Doing it now costs nothing; doing it
-- after the first sale would mean migrating live order history.
--
-- The stock rule from 001 is unchanged and still the important one: print on
-- demand must carry null stock, direct must carry a count, so the database
-- cannot represent a signed copy that isn't on the shelf.
-- ============================================================

-- ── book_editions ─────────────────────────────────────────────────────────
alter table public.book_editions drop constraint if exists book_editions_book_id_kind_key;
alter table public.book_editions drop constraint if exists book_editions_kind_check;

alter table public.book_editions
  add column if not exists format text,
  add column if not exists signed boolean not null default false;

-- No rows exist, but be explicit rather than leaving a nullable column that
-- later reads as "format unknown".
update public.book_editions set format = 'paperback' where format is null;

alter table public.book_editions alter column format set not null;

alter table public.book_editions drop constraint if exists book_editions_format_check;
alter table public.book_editions
  add constraint book_editions_format_check
    check (format in ('paperback', 'hardcover'));

alter table public.book_editions drop column if exists kind;

alter table public.book_editions drop constraint if exists book_editions_book_format_signed_key;
alter table public.book_editions
  add constraint book_editions_book_format_signed_key unique (book_id, format, signed);

-- Signing is what makes a copy Susan's to post. Keeping these two in step is
-- the difference between an order queue that makes sense and one that doesn't,
-- so it is enforced rather than remembered.
alter table public.book_editions drop constraint if exists book_editions_signed_is_direct;
alter table public.book_editions
  add constraint book_editions_signed_is_direct check (
    (signed = true  and fulfilment = 'direct') or
    (signed = false and fulfilment = 'pod')
  );

comment on column public.book_editions.format is
  'paperback | hardcover. The physical object — a different format is a different product at a different price.';
comment on column public.book_editions.signed is
  'Signed copies come off Susan''s shelf and are posted by her; unsigned are printed to order.';

-- ── order_items ───────────────────────────────────────────────────────────
-- The snapshot has to record the same two facts, so a past order still reads
-- correctly years after the catalogue changed around it.
alter table public.order_items drop constraint if exists order_items_edition_kind_check;

alter table public.order_items
  add column if not exists format text,
  add column if not exists signed boolean not null default false;

update public.order_items set format = 'paperback' where format is null;
alter table public.order_items alter column format set not null;

alter table public.order_items drop constraint if exists order_items_format_check;
alter table public.order_items
  add constraint order_items_format_check check (format in ('paperback', 'hardcover'));

alter table public.order_items drop column if exists edition_kind;
