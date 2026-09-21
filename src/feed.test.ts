import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { parseFeed, reconcileBalance } from './feed.ts'
import type { RawAccount, RawDeal, RawFeed, RawOrder } from './metaapi.ts'
import { readStatement } from './statement.ts'
import { buildTrades } from './trades.ts'
import type { Trade } from './trade.ts'

const ACCOUNT: RawAccount = {
  broker: 'Test Broker', currency: 'AUD', server: 'Test-MT5', login: 1, name: 'Test',
  balance: 0, equity: 0, marginMode: 'ACCOUNT_MARGIN_MODE_RETAIL_HEDGING',
  investorMode: true, tradeAllowed: false,
}

function deal(over: Partial<RawDeal> & Pick<RawDeal, 'id'>): RawDeal {
  return {
    type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN',
    time: '2026-09-07T11:30:03.000Z', brokerTime: '2026-09-07 14:30:03.000',
    symbol: 'XAUUSD', volume: 1, price: 100,
    commission: 0, swap: 0, profit: 0, orderId: over.id, positionId: over.id,
    ...over,
  }
}

function feed(deals: RawDeal[], orders: RawOrder[] = [], balance = 0): RawFeed {
  return {
    account: { ...ACCOUNT, balance },
    deals, orders, fetchedAt: new Date('2026-09-21T00:00:00.000Z'),
  }
}

/** The report records whole seconds; the live feed keeps milliseconds too. */
function toSeconds(trades: Trade[]): Trade[] {
  const floor = (time: Date) => new Date(Math.floor(time.getTime() / 1000) * 1000)
  return trades.map((trade) => ({
    ...trade,
    entry: { ...trade.entry, time: floor(trade.entry.time) },
    exits: trade.exits.map((exit) => ({ ...exit, time: floor(exit.time) })),
  }))
}

const SNAPSHOT = 'data/snapshot.json'
const REPORT = 'ReportHistory-51554919.xlsx'

test('the live feed and the report describe the same trades', { skip:
  existsSync(SNAPSHOT) && existsSync(REPORT)
    ? false
    : `needs ${SNAPSHOT} (npm run update) and ${REPORT}`,
}, () => {
  const raw = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as RawFeed
  raw.fetchedAt = new Date(raw.fetchedAt)

  const live = buildTrades(parseFeed(raw))
  const report = buildTrades(readStatement(REPORT))

  // Two sources, two entirely different reconstructions of the same account:
  // if they agree trade for trade, neither is inventing anything.
  assert.deepEqual(toSeconds(live), toSeconds(report))
})

test('reads the broker offset from the two clocks on a deal', () => {
  const statement = parseFeed(feed([deal({ id: '1' })]))
  // 14:30 broker against 11:30 UTC.
  assert.equal(statement.serverUtcOffsetMinutes, 180)
})

test('timestamps are server time, matching the report', () => {
  const statement = parseFeed(feed([deal({ id: '1' })]))
  assert.equal(statement.deals[0]?.time.toISOString(), '2026-09-07T14:30:03.000Z')
})

test('groups deals into the closed positions MT5 does not store', () => {
  const statement = parseFeed(feed([
    deal({ id: '1', entryType: 'DEAL_ENTRY_IN', volume: 1, price: 100 }),
    deal({ id: '2', positionId: '1', entryType: 'DEAL_ENTRY_OUT', type: 'DEAL_TYPE_SELL',
      volume: 0.5, price: 110, brokerTime: '2026-09-07 15:00:00.000', profit: 5 }),
    deal({ id: '3', positionId: '1', entryType: 'DEAL_ENTRY_OUT', type: 'DEAL_TYPE_SELL',
      volume: 0.5, price: 120, brokerTime: '2026-09-07 16:00:00.000', profit: 10 }),
  ], [], 15))

  assert.equal(statement.positions.length, 1)
  const [position] = statement.positions
  assert.equal(position?.volume, 1)
  // Volume-weighted, as the report's own close price is.
  assert.equal(position?.closePrice, 115)
  assert.equal(position?.profit, 15)
  assert.equal(position?.closeTime.toISOString(), '2026-09-07T16:00:00.000Z')
})

test('leaves a position still open out of the ledger', () => {
  const statement = parseFeed(feed([
    deal({ id: '1', volume: 1 }),
    deal({ id: '2', positionId: '1', entryType: 'DEAL_ENTRY_OUT', type: 'DEAL_TYPE_SELL',
      volume: 0.5, brokerTime: '2026-09-07 15:00:00.000' }),
  ]))
  assert.equal(statement.positions.length, 0)
})

test('refuses a deal type it does not model rather than treating it as a trade', () => {
  assert.throws(
    () => parseFeed(feed([deal({ id: '1', type: 'DEAL_TYPE_CORRECTION' })])),
    /unrecognised type "DEAL_TYPE_CORRECTION"/)
})

test('refuses a close-by, which belongs to two round trips at once', () => {
  assert.throws(
    () => parseFeed(feed([deal({ id: '1', entryType: 'DEAL_ENTRY_OUT_BY' })])),
    /unrecognised entry type "DEAL_ENTRY_OUT_BY"/)
})

test('refuses a history that does not add up to the broker balance', () => {
  // The failure a poll actually has: a page that never arrived.
  assert.throws(
    () => parseFeed(feed([deal({ id: '1', profit: 100 })], [], 250)),
    /add up to 100\.00.*balance of 250\.00.*incomplete/s)
})

test('a balance the deals do add up to passes', () => {
  const statement = parseFeed(feed([deal({ id: '1', profit: 100, commission: -2 })], [], 98))
  assert.doesNotThrow(() => reconcileBalance(statement))
})
