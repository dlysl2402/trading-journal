-- The trading journal's record. Run once in the Supabase SQL editor.
--
-- Two kinds of table. The broker's tables (deals, orders, accounts) hold each
-- row exactly as MetaApi sent it and are written only by the scheduled import,
-- using the project's secret key. Your table (annotations) holds what you add
-- and is written only by the UI, logged in as you. Trades, P&L and every chart
-- are recomputed from the broker's rows on demand and never stored, so a
-- number on a screen can never disagree with the record beneath it.

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

create table annotations (
  account_id  text not null,
  position_id text not null,
  note        text,
  tags        text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (account_id, position_id)
);

-- Who may touch what. The import's secret key bypasses row-level security;
-- the UI's login gets exactly these policies and nothing else.

alter table deals       enable row level security;
alter table orders      enable row level security;
alter table accounts    enable row level security;
alter table annotations enable row level security;

create policy read_only on deals       for select to authenticated using (true);
create policy read_only on orders      for select to authenticated using (true);
create policy read_only on accounts    for select to authenticated using (true);
create policy own_notes on annotations for all    to authenticated
  using (true) with check (true);

-- Videos live in a private Storage bucket named "videos", one folder per
-- trade: {account_id}/{position_id}/. Nothing about them is in a table.
