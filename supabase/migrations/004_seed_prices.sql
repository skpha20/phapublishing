-- ============================================================
-- 004_seed_prices.sql — the real prices
-- ------------------------------------------------------------
-- Supplied by the client 2026-09-12:
--
--   Hmong Names                  paperback  $24.99
--   Success That Looks Like Me   paperback  $34.99
--   My Daughter                  paperback  $24.99   hardcover  $34.99
--   We Are Hmong                 paperback  $19.99   hardcover  $25.99
--
-- My Daughter and We Are Hmong are printed in full colour, which is why they
-- carry a hardcover at a premium while the other two are paperback only.
--
-- ONLY UNSIGNED, PRINT-ON-DEMAND EDITIONS ARE CREATED HERE.
-- No signed prices have been given, and a signed copy is not simply the same
-- book at the same price: it comes off Susan's own shelf, she posts it
-- herself, and it needs a stock count she has actually verified. Inventing
-- either the price or the count would put a buy button in front of a customer
-- for a book that might not exist. Signed editions get their own migration
-- once those two numbers are known.
--
-- Prices are integer cents. Idempotent — re-running refreshes prices.
-- ============================================================

insert into public.book_editions (book_id, format, signed, fulfilment, price_cents, stock, sku)
select b.id, v.format, false, 'pod', v.price_cents, null,
       'PHA-' || upper(replace(b.slug, '-', '')) || '-' || upper(left(v.format, 2))
  from (values
    ('hmong-names',                'paperback', 2499),
    ('success-that-looks-like-me', 'paperback', 3499),
    ('my-daughter',                'paperback', 2499),
    ('my-daughter',                'hardcover', 3499),
    ('we-are-hmong',               'paperback', 1999),
    ('we-are-hmong',               'hardcover', 2599)
  ) as v(slug, format, price_cents)
  join public.books b on b.slug = v.slug
on conflict (book_id, format, signed) do update
  set price_cents = excluded.price_cents,
      active      = true;

-- A price that silently failed to land is worse than an error, because the
-- page just keeps saying "available to order soon" and nobody knows why.
do $$
declare n int;
begin
  select count(*) into n from public.book_editions where signed = false;
  if n <> 6 then
    raise exception 'Expected 6 unsigned editions, found %', n;
  end if;
  raise notice 'Seeded % unsigned editions.', n;
end $$;
