import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { buildJournal } from './journal.ts'
import type { RawDeal, RawFeed, RawOrder } from './metaapi.ts'

/** An opening deal for a position of the same id, unless told otherwise. */
function deal(over: Partial<RawDeal> & Pick<RawDeal, 'id'>): RawDeal {
  return {
    type: 'DEAL_TYPE_BUY', entryType: 'DEAL_ENTRY_IN', reason: 'DEAL_REASON_CLIENT',
    time: '2026-09-07T11:30:03.000Z', brokerTime: '2026-09-07 14:30:03.000',
    symbol: 'XAUUSD', volume: 1, price: 100,
    commission: 0, swap: 0, profit: 0, orderId: over.id, positionId: over.id,
    ...over,
  }
}

/** A closing deal for position `of`, an hour after it opened. */
function exit(over: Partial<RawDeal> & Pick<RawDeal, 'id'>, of: string): RawDeal {
  return deal({
    type: 'DEAL_TYPE_SELL', entryType: 'DEAL_ENTRY_OUT', positionId: of,
    time: '2026-09-07T12:30:03.000Z', brokerTime: '2026-09-07 15:30:03.000',
    ...over,
  })
}

/** A feed whose balance is whatever its deals add up to, unless told otherwise. */
function feed(deals: RawDeal[], orders: RawOrder[] = [], balance?: number): RawFeed {
  const booked = deals.reduce((total, d) => total + d.profit + d.commission + d.swap, 0)
  return {
    account: { broker: 'Test', currency: 'AUD', login: 1, balance: balance ?? booked, investorMode: true },
    deals, orders, fetchedAt: new Date('2026-09-21T00:00:00.000Z'),
  }
}

test('one trade per closed position, with its deals summed', () => {
  const { trades } = buildJournal(feed([
    deal({ id: '1', commission: -1 }),
    exit({ id: '2', price: 110, profit: 10, commission: -1, swap: -0.5 }, '1'),
  ]))
  assert.equal(trades.length, 1)
  const [trade] = trades
  assert.equal(trade?.positionId, '1')
  assert.equal(trade?.symbol, 'XAUUSD')
  assert.equal(trade?.side, 'buy')
  assert.equal(trade?.entry.price, 100)
  assert.deepEqual(trade?.exits.map((e) => e.price), [110])
  assert.equal(trade?.grossProfit, 10)
  assert.equal(trade?.commission, -2)
  assert.equal(trade?.swap, -0.5)
})

test('a position closed in two pieces keeps both exits, each with its own reason', () => {
  const { trades } = buildJournal(feed([
    deal({ id: '1', volume: 0.29 }),
    exit({ id: '2', volume: 0.26 }, '1'),
    exit({ id: '3', volume: 0.03, reason: 'DEAL_REASON_TP', takeProfit: 120, price: 120.2,
      time: '2026-09-07T12:30:04.000Z', brokerTime: '2026-09-07 15:30:04.000' }, '1'),
  ]))
  assert.deepEqual(trades[0]?.exits.map((e) => e.volume), [0.26, 0.03])
  // The level that fired is kept apart from the price that filled.
  assert.deepEqual(trades[0]?.exits.map((e) => e.reason),
    [{ kind: 'manual' }, { kind: 'target', price: 120 }])
  assert.equal(trades[0]?.exits[1]?.price, 120.2)
})

test('a stop trailed after entry keeps both the risk taken and where it ended', () => {
  const { trades } = buildJournal(feed(
    [deal({ id: '1', stopLoss: 90, takeProfit: 130 }), exit({ id: '2', stopLoss: 99, takeProfit: 125 }, '1')],
    [{ id: '1', stopLoss: 90, takeProfit: 130, comment: 'RiskManager' }]))
  assert.deepEqual(trades[0]?.stop, { initial: 90, final: 99 })
  assert.deepEqual(trades[0]?.target, { initial: 130, final: 125 })
  assert.equal(trades[0]?.tag, 'RiskManager')
})

test('a stop set after entry records the original as unknown, not as zero', () => {
  const { trades } = buildJournal(feed(
    [deal({ id: '1' }), exit({ id: '2', stopLoss: 99 }, '1')], [{ id: '1' }]))
  assert.deepEqual(trades[0]?.stop, { initial: null, final: 99 })
})

test('a bracket stamp on the entry order is not a tag', () => {
  const { trades } = buildJournal(feed(
    [deal({ id: '1' }), exit({ id: '2' }, '1')], [{ id: '1', comment: '[tp 4382.63]' }]))
  assert.equal(trades[0]?.tag, null)
})

test('an open position is not a trade yet', () => {
  const { trades } = buildJournal(feed([deal({ id: '1' }), exit({ id: '2', volume: 0.5 }, '1')]))
  assert.deepEqual(trades, [])
})

test('deposits are summed apart from trading', () => {
  const journal = buildJournal(feed([
    { id: '0', type: 'DEAL_TYPE_BALANCE', time: '2026-09-07T11:00:00.000Z',
      brokerTime: '2026-09-07 14:00:00.000', commission: 0, swap: 0, profit: 10_000 },
    deal({ id: '1' }),
    exit({ id: '2', profit: 10 }, '1'),
  ]))
  assert.equal(journal.deposited, 10_000)
  assert.equal(journal.balance, 10_010)
  assert.equal(journal.trades.length, 1)
})

test('timestamps are broker server time, the clock the terminal shows', () => {
  const { trades } = buildJournal(feed([deal({ id: '1' }), exit({ id: '2' }, '1')]))
  assert.equal(trades[0]?.entry.time.toISOString(), '2026-09-07T14:30:03.000Z')
})

test('reads the broker offset from the two clocks on a deal', () => {
  // 14:30 broker against 11:30 UTC.
  assert.equal(buildJournal(feed([deal({ id: '1' })])).serverUtcOffsetMinutes, 180)
  assert.equal(buildJournal(feed([])).serverUtcOffsetMinutes, null)
})

test('refuses a history that does not add up to the broker balance', () => {
  // The failure a poll actually has: a page that never arrived.
  assert.throws(
    () => buildJournal(feed([deal({ id: '1', profit: 100 })], [], 250)),
    /add up to 100\.00.*balance of 250\.00.*incomplete/s)
})

test('refuses a deal type it does not model rather than treating it as a trade', () => {
  assert.throws(
    () => buildJournal(feed([deal({ id: '1', type: 'DEAL_TYPE_CORRECTION' })])),
    /unrecognised type "DEAL_TYPE_CORRECTION"/)
})

test('refuses a close-by, which belongs to two round trips at once', () => {
  assert.throws(
    () => buildJournal(feed([deal({ id: '1', entryType: 'DEAL_ENTRY_OUT_BY' })])),
    /unrecognised entry type "DEAL_ENTRY_OUT_BY"/)
})

test('refuses a position opened twice, which only a netting account does', () => {
  assert.throws(
    () => buildJournal(feed([deal({ id: '1' }), deal({ id: '2', positionId: '1' })])),
    /position 1: opened by 2 deals/)
})

test('refuses a stop-out rather than filing it as a manual close', () => {
  assert.throws(
    () => buildJournal(feed([deal({ id: '1' }), exit({ id: '2', reason: 'DEAL_REASON_SO' }, '1')])),
    /deal 2: unrecognised reason "DEAL_REASON_SO"/)
})

const SNAPSHOT = 'data/snapshot.json'

test('the last real fetch still builds', {
  skip: existsSync(SNAPSHOT) ? false : `needs ${SNAPSHOT} (npm run update)`,
}, () => {
  const journal = buildJournal(JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as RawFeed)
  assert.ok(journal.trades.length > 0)
  for (const trade of journal.trades) {
    const closed = trade.exits.reduce((total, e) => total + e.volume, 0)
    assert.ok(Math.abs(closed - trade.entry.volume) < 0.005, `position ${trade.positionId}`)
  }
})
