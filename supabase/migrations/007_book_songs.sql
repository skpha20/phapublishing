-- ============================================================
-- 007_book_songs.sql — the songs that belong to a book
-- ------------------------------------------------------------
-- Susan writes a song for a title, and it belongs to the book the way a
-- retailer link does: a separate row, not a column on books. Two reasons that
-- is worth a table rather than an `audio_path` column:
--
--   A book can end up with more than one. "We Are Hmong" already reads like a
--   song cycle, and the first time a second track appears, a single column has
--   to be migrated away under live traffic.
--
--   A song has its own copy — a title that is not the book's title, and a
--   line of context for the reader. That is a row's worth of fields.
--
-- The audio itself is a file in public/audio, not a bytea and not Supabase
-- storage. These are a few megabytes that change approximately never, they
-- deploy with the site, and the edge caches them for a week. Putting them
-- behind a second service would add a dependency and a failure mode to buy
-- nothing.
-- ============================================================

create table if not exists public.book_songs (
  id         uuid primary key default gen_random_uuid(),
  book_id    uuid not null references public.books(id) on delete cascade,

  title      text not null,
  -- Site-relative, e.g. /audio/we-are-hmong.mp3. Same shape as books.cover_path.
  audio_path text not null,
  -- Shown under the player. Optional: some songs need no introducing.
  note       text,
  -- Seconds. Display only, so the page can say "5:14" before anything loads
  -- rather than reflowing once the browser has read the file's header.
  duration_seconds int check (duration_seconds is null or duration_seconds > 0),

  position   int  not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per file per book. Makes the seed below idempotent, and stops a
  -- re-run from listing the same song twice.
  unique (book_id, audio_path)
);

comment on table public.book_songs is
  'Songs Susan wrote for a title. Audio lives in public/audio and deploys with the site.';

create index if not exists book_songs_book_idx on public.book_songs (book_id, position);

drop trigger if exists set_book_songs_updated_at on public.book_songs;
create trigger set_book_songs_updated_at before update on public.book_songs
  for each row execute function public.set_updated_at();

-- ── Public read, like every other catalogue table ─────────────────────────
alter table public.book_songs enable row level security;

drop policy if exists "Active songs are public" on public.book_songs;
create policy "Active songs are public"
  on public.book_songs for select using (active);

-- ── The two songs that exist today ───────────────────────────────────────
-- Joined by slug rather than a hardcoded uuid, so this runs against any
-- environment. A missing slug inserts nothing instead of failing the deploy.
insert into public.book_songs (book_id, title, audio_path, note, duration_seconds, position)
select b.id, s.title, s.audio_path, s.note, s.duration_seconds, s.position
from (values
  ('my-daughter',
   'For All Your Life to Hold',
   '/audio/for-all-your-life-to-hold.mp3',
   'The song Susan wrote to carry this book''s promise.',
   270, 1),

  ('we-are-hmong',
   'We Are Hmong',
   '/audio/we-are-hmong.mp3',
   'Fierce and strong — the book''s title, set to music.',
   314, 1)
) as s(slug, title, audio_path, note, duration_seconds, position)
join public.books b on b.slug = s.slug

on conflict (book_id, audio_path) do update
  set title            = excluded.title,
      note             = excluded.note,
      duration_seconds = excluded.duration_seconds,
      position         = excluded.position,
      active           = true;
