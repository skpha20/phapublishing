-- ============================================================
-- 001_store.sql — books, editions and orders for phapublishing.com
-- ------------------------------------------------------------
-- The site sells Susan's titles two ways, and that split shapes the whole
-- schema:
--
--   standard copies  printed and shipped by IngramSpark (print on demand)
--   signed copies    posted by Susan herself, from stock she holds
--
-- So the sellable thing is not a book, it is an *edition* of a book. Price,
-- ISBN, stock and who ships all differ between the two, and modelling them as
-- one row with a "signed?" flag would mean nullable columns that mean
-- different things depending on a sibling column — the kind of table that is
-- fine for a month and awful thereafter.
--
-- WHAT IS DELIBERATE HERE
--
--   Order items snapshot the title, edition and price at the time of sale.
--   A price change next year must not silently rewrite what someone paid.
--
--   Stock is tracked per edition and is null for print-on-demand, because
--   "how many are left" is not a question that applies to POD. A null here
--   means unlimited, not unknown, and the check constraint says so.
--
--   Fulfilment state lives on the order *item*, not the order. A single order
--   can contain one signed copy Susan posts and one standard copy Ingram
--   prints, and those two finish at different times.
--
--   Money is integer cents. Floating point has no business near a price.
--
--   Nothing here talks to Stripe. Stripe owns the payment; this owns the
--   record of what was bought and what still has to be sent.
-- ============================================================

-- ── Books ────────────────────────────────────────────────────────────────
create table if not exists public.books (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  subtitle    text,
  author      text not null default 'Susan Kaying Pha',
  description text,
  cover_path  text,                       -- e.g. /img/book-hmong-names.webp
  position    int  not null default 0,    -- display order on the site
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.books is
  'One row per title. What is actually sold is an edition — see book_editions.';

-- ── Editions: the sellable thing ─────────────────────────────────────────
create table if not exists public.book_editions (
  id          uuid primary key default gen_random_uuid(),
  book_id     uuid not null references public.books(id) on delete cascade,

  kind        text not null check (kind in ('standard', 'signed')),
  fulfilment  text not null check (fulfilment in ('pod', 'direct')),

  price_cents int  not null check (price_cents >= 0),
  currency    text not null default 'USD',
  isbn        text,
  sku         text unique,

  -- Null means unlimited, which is the honest answer for print on demand.
  -- A number means Susan is holding that many and can run out.
  stock       int check (stock is null or stock >= 0),

  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (book_id, kind),

  -- Print on demand cannot run out; signed copies come off a shelf. Letting
  -- these drift apart is how a storefront sells a signed copy that is not
  -- there, so the database refuses the combination outright.
  constraint book_editions_stock_matches_fulfilment check (
    (fulfilment = 'pod'    and stock is null) or
    (fulfilment = 'direct' and stock is not null)
  )
);

comment on column public.book_editions.stock is
  'Null = unlimited (print on demand). A number = physical copies Susan holds.';

create index if not exists book_editions_book_idx on public.book_editions (book_id);

-- ── Where else the book can be bought ────────────────────────────────────
create table if not exists public.retailer_links (
  id        uuid primary key default gen_random_uuid(),
  book_id   uuid not null references public.books(id) on delete cascade,
  retailer  text not null,               -- 'Amazon', 'Barnes & Noble', …
  url       text not null,
  position  int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists retailer_links_book_idx on public.retailer_links (book_id);

-- ── Orders ───────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  reference     text not null unique,     -- human-quotable, e.g. PHA-1042

  status        text not null default 'pending'
                  check (status in ('pending','paid','fulfilled','cancelled','refunded')),

  email         text,
  customer_name text,

  stripe_session_id        text unique,
  stripe_payment_intent_id text,

  subtotal_cents int not null default 0 check (subtotal_cents >= 0),
  shipping_cents int not null default 0 check (shipping_cents >= 0),
  tax_cents      int not null default 0 check (tax_cents      >= 0),
  total_cents    int not null default 0 check (total_cents    >= 0),
  currency       text not null default 'USD',

  ship_name     text,
  ship_line1    text,
  ship_line2    text,
  ship_city     text,
  ship_state    text,
  ship_postal   text,
  ship_country  text,

  notes         text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz,
  fulfilled_at  timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists orders_status_idx  on public.orders (status, created_at desc);
create index if not exists orders_created_idx on public.orders (created_at desc);

comment on column public.orders.reference is
  'Short human reference for email and support. Not the primary key.';

-- ── Order items ──────────────────────────────────────────────────────────
create table if not exists public.order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.orders(id) on delete cascade,

  -- Kept for reporting, nulled rather than cascading if an edition is removed:
  -- deleting a product must never delete the history of it having been sold.
  edition_id  uuid references public.book_editions(id) on delete set null,

  -- Snapshot. What the buyer actually bought, at the price they actually paid,
  -- independent of anything later edited on the product.
  title       text not null,
  edition_kind text not null check (edition_kind in ('standard','signed')),
  unit_price_cents int not null check (unit_price_cents >= 0),
  quantity    int not null default 1 check (quantity > 0),

  -- Who ships this line, and how far along it is. On the item because one
  -- order can span both routes and they complete independently.
  fulfilment  text not null check (fulfilment in ('pod','direct')),
  fulfilment_status text not null default 'pending'
                      check (fulfilment_status in ('pending','placed','shipped','cancelled')),
  ingram_order_ref text,                 -- reference from IngramSpark, once placed
  tracking_number  text,
  shipped_at       timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_queue_idx
  on public.order_items (fulfilment, fulfilment_status)
  where fulfilment_status in ('pending','placed');

-- ── updated_at ───────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['books','book_editions','orders','order_items'] loop
    execute format('drop trigger if exists set_%1$s_updated_at on public.%1$s', t);
    execute format(
      'create trigger set_%1$s_updated_at before update on public.%1$s
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── Order references ─────────────────────────────────────────────────────
create sequence if not exists public.order_reference_seq start 1001;

create or replace function public.assign_order_reference()
returns trigger language plpgsql as $$
begin
  if new.reference is null or new.reference = '' then
    new.reference := 'PHA-' || nextval('public.order_reference_seq');
  end if;
  return new;
end $$;

drop trigger if exists assign_order_reference on public.orders;
create trigger assign_order_reference
  before insert on public.orders
  for each row execute function public.assign_order_reference();

-- ── Row level security ───────────────────────────────────────────────────
-- The catalogue is public; everything about a purchase is not. The website
-- writes orders with the service role from its own server, so no anonymous
-- write policy exists anywhere here — a browser cannot create or read an
-- order even with the anon key in hand.
alter table public.books          enable row level security;
alter table public.book_editions  enable row level security;
alter table public.retailer_links enable row level security;
alter table public.orders         enable row level security;
alter table public.order_items    enable row level security;

drop policy if exists "Active books are public" on public.books;
create policy "Active books are public"
  on public.books for select using (active);

drop policy if exists "Active editions are public" on public.book_editions;
create policy "Active editions are public"
  on public.book_editions for select using (active);

drop policy if exists "Retailer links are public" on public.retailer_links;
create policy "Retailer links are public"
  on public.retailer_links for select using (true);

-- orders and order_items get no policy at all, which under RLS means no
-- access for anon or authenticated. Only the service role reaches them.
