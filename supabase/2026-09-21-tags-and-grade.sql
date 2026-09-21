-- For a project that already ran schema.sql before 2026-09-21. Run once in the
-- SQL editor; it brings the record up to what schema.sql now creates.
-- Fresh projects run schema.sql alone and do not need this.

create table tags (
  slug        text primary key,
  kind        text not null check (kind in ('context', 'trigger', 'play', 'mistake')),
  label       text not null,
  description text,
  sort        integer not null default 0,
  archived    boolean not null default false
);

alter table annotations
  add column grade text check (grade in ('A', 'B', 'C'));

alter table tags enable row level security;
create policy own_tags on tags for all to authenticated
  using (true) with check (true);

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
