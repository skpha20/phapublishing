-- ============================================================
-- 005_contact_messages.sql — keep what people write to us
-- ------------------------------------------------------------
-- The contact form emails hello@phapublishing.com, but email is a notification
-- and not a record. Mailboxes fill up, forwarding rules break, a message lands
-- in spam, someone deletes a thread. A person who wrote to an author and got
-- no reply does not know any of that happened — they just think they were
-- ignored.
--
-- So every submission is stored here first and emailed second. If the email
-- fails the message is still recoverable, and `emailed_at` says plainly which
-- ones never made it out.
--
-- The stored fields are only what the form asks for. Nothing is inferred about
-- the sender beyond their own words and the address they gave.
-- ============================================================

create table if not exists public.contact_messages (
  id         uuid primary key default gen_random_uuid(),

  name       text not null,
  email      text not null,
  subject    text,
  message    text not null,

  -- Null means the notification email never went out — worth being able to
  -- find, rather than assuming delivery.
  emailed_at timestamptz,
  email_error text,

  handled_at timestamptz,          -- Susan has dealt with it
  notes      text,

  created_at timestamptz not null default now()
);

create index if not exists contact_messages_created_idx
  on public.contact_messages (created_at desc);

-- Unsent notifications are the ones that need chasing, so make them cheap to find.
create index if not exists contact_messages_unsent_idx
  on public.contact_messages (created_at desc)
  where emailed_at is null;

comment on table public.contact_messages is
  'Every contact form submission. Stored before the notification email is attempted, '
  'so a mail failure loses a notification rather than the message.';
comment on column public.contact_messages.emailed_at is
  'When the notification was successfully sent. Null means it was not.';

-- Private. Written by the website using the service role; no policy exists for
-- anon or authenticated, so neither can read or write a single row.
alter table public.contact_messages enable row level security;
