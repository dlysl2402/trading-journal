-- The trading journal's record. Run once in the Supabase SQL editor.
--
-- This file is the contract between the two repositories. `trading-journal`
-- (this one) writes; `trading-journal-frontend` reads, and declares the same row
-- shapes in its `src/rows.ts`. Adding a field is safe from either side;
-- renaming or removing one needs both in the same breath.
--
-- Two kinds of table. The broker's tables (deals, orders, accounts) hold each
-- row exactly as MetaApi sent it and are written only by the scheduled import,
-- using the project's secret key. Your table (annotations) holds what you add
-- and is written only by the web app, logged in as you. Trades, P&L and every
-- chart are recomputed from the broker's rows in the browser and never stored,
-- so a number on a screen can never disagree with the record beneath it.

-- Layer 1: the broker's pen.

create table deals (
  account_id text not null,   -- MetaApi account id, so a second account cannot collide
  id         text not null,   -- the broker's deal ticket
  raw        jsonb not null,  -- the deal exactly as MetaApi sent it
  primary key (account_id, id)
);

create table orders (
  account_id text not null,
  id         text not null,
  raw        jsonb not null,
  primary key (account_id, id)
);

create table accounts (
  account_id text primary key,
  raw        jsonb not null,           -- accountInformation, overwritten each run
  fetched_at timestamptz not null      -- when the last successful import ran
);

-- Ink, not pencil. A broker row can be added, never edited or removed, whoever
-- holds the key. If a broker ever genuinely amends a deal, drop the trigger,
-- fix the row by hand, and put it back.
create function refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'broker rows are append-only';
end $$;

create trigger deals_append_only
  before update or delete on deals for each row execute function refuse_change();
create trigger orders_append_only
  before update or delete on orders for each row execute function refuse_change();

-- Layer 4: the margin. Never a field the broker already names.

-- The words you are allowed to tag a trade with. One row per tag, so "1h
-- overextended" is spelled one way on every trade and a filter can find them
-- all. The kinds are fixed here and in the page's `tags.ts`; the tags inside
-- them are yours to add, rename, describe and retire. A tag is archived, never
-- deleted, so the trades that carry it keep meaning what they meant.
create table tags (
  slug        text primary key,     -- never changes once a trade carries it
  kind        text not null check (kind in ('context', 'trigger', 'play', 'mistake')),
  label       text not null,        -- what the page shows; rename freely
  description text,                 -- what it means, so it means the same thing next month
  sort        integer not null default 0,
  archived    boolean not null default false
);

create table annotations (
  account_id  text not null,
  position_id text not null,
  note        text,
  tags        text[] not null default '{}',  -- tags.slug, at most one of kind 'play'
  grade       text check (grade in ('A', 'B', 'C')),  -- the setup at entry, never the result
  updated_at  timestamptz not null default now(),
  primary key (account_id, position_id)
);

-- Who may touch what. The import's secret key bypasses row-level security;
-- the UI's login gets exactly these policies and nothing else.

alter table deals       enable row level security;
alter table orders      enable row level security;
alter table accounts    enable row level security;
alter table annotations enable row level security;
alter table tags        enable row level security;

create policy read_only on deals       for select to authenticated using (true);
create policy read_only on orders      for select to authenticated using (true);
create policy read_only on accounts    for select to authenticated using (true);
create policy own_notes on annotations for all    to authenticated
  using (true) with check (true);
create policy own_tags  on tags        for all    to authenticated
  using (true) with check (true);

-- A starting vocabulary, so the picker is not empty on day one. Every one of
-- these can be renamed or archived from the page.
insert into tags (slug, kind, label, description, sort) values
  ('1h-overextended',            'context', '1h overextended',            'Price is stretched far from where the 1h chart would call fair; a move already well along.', 1),
  ('30m-overextended',           'context', '30m overextended',           'Same on the 30m: the leg you are trading against or with has already run.', 2),
  ('into-daily-level',           'context', 'Into daily level',           'Trading into support or resistance the daily chart cares about.', 3),
  ('trend-day',                  'context', 'Trend day',                  'The session is going one way and pullbacks are shallow.', 4),
  ('strong-close-below-support', 'trigger', 'Strong close below support', 'The entry bar closed decisively through support with a full body and little wick.', 1),
  ('weak-close-below-support',   'trigger', 'Weak close below support',   'The entry bar closed under support, but on a small body or with a long wick back.', 2),
  ('failed-retest',              'trigger', 'Failed retest',              'Price came back to the level, could not reclaim it, and turned.', 3),
  ('break-and-continue',         'play',    'Break and continue',         'Enter on the break of a level, expecting the move to carry on.', 1),
  ('retrace-and-push',           'play',    'Retrace and push',           'Wait for the pullback after the move, enter as it resumes.', 2),
  ('chased',                     'mistake', 'Chased',                     'Entered late, after the move you wanted had already happened.', 1),
  ('cut-early',                  'mistake', 'Cut early',                  'Closed before the stop or the target had anything to say.', 2);

-- The tape: the clips you recorded of a trade. They live in Storage, not in a
-- table — a private bucket with one folder per trade, {account_id}/{position_id}/,
-- so the page finds a trade's clips by listing its folder and there is no row
-- that could fall out of step with the files. MP4 only, so a file the browser
-- could not play is refused at the door. The size cap is the project's global
-- upload limit (Project Settings → Storage), which starts at 50 MB on every
-- plan and is raised there, not here. The import never touches this bucket.
-- The page, signed in as you, reads it and adds to it from a trade's own tab,
-- and can neither replace nor remove a clip: that is the dashboard's, on
-- purpose, so a recording cannot be lost to a misclick on the page.
insert into storage.buckets (id, name, public, allowed_mime_types)
  values ('videos', 'videos', false, '{video/mp4}');

create policy read_videos on storage.objects for select to authenticated
  using (bucket_id = 'videos');
create policy add_videos  on storage.objects for insert to authenticated
  with check (bucket_id = 'videos');
