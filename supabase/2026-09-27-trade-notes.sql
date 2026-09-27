-- For a project that ran schema.sql before 2026-09-27. Run once in the SQL
-- editor, and before deploying the page that reads these columns: it asks for
-- them by name, and a column that is not there fails the whole read. Fresh
-- projects run schema.sql alone and do not need this.
--
-- A trade is written up in three notes now, all in review: pre-trade,
-- in-trade and post-trade. The post-trade one is the `note` that was already
-- here, so every note written so far stays where it is; the two new ones
-- start empty.

alter table annotations
  add column pre_trade text,
  add column in_trade  text;
