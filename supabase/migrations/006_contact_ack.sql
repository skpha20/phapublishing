-- ============================================================
-- 006_contact_ack.sql — track the acknowledgement too
-- ------------------------------------------------------------
-- The form now sends two emails: a notification to Susan, and an
-- acknowledgement to whoever wrote in. Both are worth tracking for the same
-- reason, from opposite directions.
--
-- A failed notification means Susan never learns a message exists. A failed
-- acknowledgement means the sender thinks they were ignored — and unlike the
-- notification, nobody on this side would ever notice. So it gets its own
-- column rather than being folded in with the other.
-- ============================================================

alter table public.contact_messages
  add column if not exists ack_emailed_at timestamptz,
  add column if not exists ack_error      text;

comment on column public.contact_messages.ack_emailed_at is
  'When the sender was told their message arrived. Null means they were not.';

-- The ones where the sender is still waiting on silence.
create index if not exists contact_messages_ack_unsent_idx
  on public.contact_messages (created_at desc)
  where ack_emailed_at is null;
