-- ============================================================
-- 008_stripe.sql — what the webhook needs in order to be safe
-- ------------------------------------------------------------
-- 001 deliberately left Stripe out: "Stripe owns the payment; this owns the
-- record of what was bought and what still has to be sent." That still holds.
-- This adds only what the site needs to receive Stripe's word for it.
--
-- THREE THINGS, AND WHY EACH IS A TABLE OR A COLUMN RATHER THAN CODE
--
--   stripe_events. Webhooks are delivered at least once, not exactly once.
--   Stripe retries on any non-2xx, and a retry of "payment succeeded" must not
--   mark an order paid twice, decrement stock twice, or send a second email.
--   The primary key is Stripe's own event id, so a duplicate delivery loses the
--   insert and the handler stops there. Idempotency belongs in the database,
--   because that is the only place two concurrent deliveries can be ordered.
--
--   Refund columns. A refund is issued in the Stripe dashboard, not on this
--   site, so the site only ever learns about one from a webhook. Without that
--   the record would still read "paid" and a refunded order would keep sitting
--   in the fulfilment queue waiting to be posted. refunded_cents is separate
--   from status on purpose: a partial refund is real and common, and flipping
--   status to 'refunded' for a $5 goodwill refund on a $35 order would be a
--   lie that later reads as "this was returned".
--
--   decrement_stock(). Signed copies come off a shelf and can run out. Reading
--   a count, subtracting in JavaScript and writing it back loses one of two
--   simultaneous orders — which is exactly how a shop sells the same last copy
--   twice. A single UPDATE with the guard in its WHERE clause cannot.
--   No signed editions exist yet, so this changes nothing today; it is here so
--   that the day Susan lists one, overselling is already impossible.
-- ============================================================

-- ── Webhook idempotency ──────────────────────────────────────────────────
create table if not exists public.stripe_events (
  id          text primary key,            -- Stripe's evt_… id
  type        text not null,
  order_id    uuid references public.orders(id) on delete set null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'One row per Stripe event handled. The primary key is what makes a redelivery a no-op.';

create index if not exists stripe_events_received_idx
  on public.stripe_events (received_at desc);

-- ── Refunds and cancellations ────────────────────────────────────────────
alter table public.orders
  add column if not exists refunded_cents int not null default 0
    check (refunded_cents >= 0),
  add column if not exists refunded_at  timestamptz,
  add column if not exists cancelled_at timestamptz;

comment on column public.orders.refunded_cents is
  'Amount refunded so far. Non-zero with status ''paid'' means a partial refund.';

-- The webhook for a refund identifies the order by payment intent, so that
-- lookup needs to be indexed rather than a scan of every order ever placed.
create index if not exists orders_payment_intent_idx
  on public.orders (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ── Stock, decremented safely ────────────────────────────────────────────
-- Returns true if the stock was taken, false if there was not enough. Null
-- stock means print-on-demand, which cannot run out, so it always succeeds and
-- leaves the null alone.
create or replace function public.decrement_stock(p_edition_id uuid, p_qty int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated int;
  is_pod  boolean;
begin
  if p_qty is null or p_qty < 1 then
    return false;
  end if;

  select stock is null into is_pod
    from public.book_editions
   where id = p_edition_id;

  if is_pod is null then
    return false;          -- no such edition
  elsif is_pod then
    return true;           -- print on demand: nothing to take
  end if;

  -- The guard lives in the WHERE clause, so two concurrent orders for the last
  -- copy cannot both pass it.
  update public.book_editions
     set stock = stock - p_qty
   where id = p_edition_id
     and stock >= p_qty;

  get diagnostics updated = row_count;
  return updated = 1;
end $$;

-- Restoring stock after a refund is the same operation with the sign flipped,
-- and needs no guard: putting a copy back can never overdraw.
create or replace function public.restore_stock(p_edition_id uuid, p_qty int)
returns void
language sql
security definer
set search_path = public
as $$
  update public.book_editions
     set stock = stock + p_qty
   where id = p_edition_id
     and stock is not null
     and p_qty > 0;
$$;

-- ── Row level security ───────────────────────────────────────────────────
-- Same posture as orders: no policy at all, so only the service role reaches
-- it. A browser holding the anon key can neither read nor forge an event row.
alter table public.stripe_events enable row level security;

-- The stock functions run as their owner, so they must not be callable by the
-- public roles — otherwise anyone with the anon key could drain an edition.
revoke all on function public.decrement_stock(uuid, int) from public, anon, authenticated;
revoke all on function public.restore_stock(uuid, int)   from public, anon, authenticated;
grant execute on function public.decrement_stock(uuid, int) to service_role;
grant execute on function public.restore_stock(uuid, int)   to service_role;
