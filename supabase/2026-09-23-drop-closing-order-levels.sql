-- Closing orders no longer keep `stopLoss` or `takeProfit`, so drop them from
-- the rows already on record.
--
-- Only the order that opened a position has a stop and target of its own; a
-- position takes that order's ticket as its id. A closing order has none, but
-- while it is fresh MetaApi stamps it with the position's levels, and once it
-- re-reads history from the terminal it serves the order bare. The pass after
-- 12:21 UTC on 2026-09-22 recorded closing orders 331089617 and 331089934
-- with levels; by 15:00 MetaApi had dropped them; from then on `ledger.ts`
-- refused the feed as amended and the record stood still for eighteen hours.
--
-- Nothing is lost. The level a close fired at is on its deal, and the page
-- reads only the opening order's levels. `metaapi.ts` now drops them from
-- every other order before it reaches the record; this brings the rows
-- already stored into that same shape. Deals are not touched.
--
-- Run it in the SQL editor. The append-only trigger stands aside for the one
-- statement and is put straight back, as in 2026-09-22-drop-open-price.sql.
-- The feed unjams on the first pass after this and the matching `metaapi.ts`.

begin;

alter table orders disable trigger orders_append_only;

update orders set raw = raw - 'stopLoss' - 'takeProfit'
  where raw->>'id' is distinct from raw->>'positionId'
    and (raw ? 'stopLoss' or raw ? 'takeProfit');

alter table orders enable trigger orders_append_only;

commit;
