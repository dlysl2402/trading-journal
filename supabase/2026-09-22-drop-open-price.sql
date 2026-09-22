-- Orders no longer keep `openPrice`, so drop it from the rows already on record.
--
-- `openPrice` is the price an order asked for: 0 on a market order, the
-- bracket level on an SL or TP fill. While an order is still live MetaApi
-- serves the working price there instead and settles it afterwards. The pass
-- at 06:15 on 2026-09-21 caught order 330490870 mid-trade and recorded
-- 4352.23; MetaApi later settled it to 0; from then on `ledger.ts` refused
-- the feed as amended and the record stood still for thirteen hours.
--
-- Nothing is lost. Every nonzero `openPrice` on this account equals the
-- matching deal's `stopLoss` or `takeProfit` exactly, and the page has never
-- read the field. `metaapi.ts` now drops it before a row reaches the record;
-- this brings the rows already stored into that same shape. Deals never
-- carried the field, so only `orders` is touched.
--
-- Run it in the SQL editor. The append-only trigger stands aside for the one
-- statement and is put straight back, which is the procedure deploy/README.md
-- describes for a row that genuinely has to be corrected. Both repositories
-- can be deployed before or after; the feed unjams on the first pass that
-- follows this and the matching `metaapi.ts`.

begin;

alter table orders disable trigger orders_append_only;

update orders set raw = raw - 'openPrice' where raw ? 'openPrice';

alter table orders enable trigger orders_append_only;

commit;
