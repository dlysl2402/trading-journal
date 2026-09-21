import assert from 'node:assert/strict'
import test from 'node:test'
import { equityCurve, renderPage } from './chart.ts'
import type { Journal, Trade } from './journal.ts'

function trade(positionId: string, net: number, opened: string, closed: string): Trade {
  return {
    positionId, symbol: 'XAUUSD', side: 'buy', tag: null,
    entry: { dealId: positionId, time: new Date(opened), price: 100, volume: 1 },
    exits: [{ dealId: positionId + 'x', time: new Date(closed), price: 101, volume: 1, reason: { kind: 'manual' } }],
    stop: { initial: null, final: null }, target: { initial: null, final: null },
    grossProfit: net + 1, commission: -1, swap: 0,
  }
}

// Given out of order, so the curve has to sort them itself.
const trades = [
  trade('2', -5, '2026-09-08T10:00:00Z', '2026-09-08T11:00:00Z'),
  trade('1', 20, '2026-09-07T10:00:00Z', '2026-09-07T11:00:00Z'),
  trade('3', 7.5, '2026-09-09T10:00:00Z', '2026-09-09T11:00:00Z'),
]

const journal: Journal = {
  account: { id: '1', broker: 'Bad </script> Broker', currency: 'AUD' },
  balance: 10_022.5, deposited: 10_000, serverUtcOffsetMinutes: 180, trades,
}

test('the curve starts at zero when the first trade opened, then steps once per trade', () => {
  const curve = equityCurve(trades)
  assert.deepEqual(curve.map((p) => p.equity), [0, 20, 15, 22.5])
  assert.equal(curve[0]?.time.toISOString(), '2026-09-07T10:00:00.000Z')
  assert.equal(curve[0]?.trade, null)
  assert.deepEqual(curve.slice(1).map((p) => p.trade?.positionId), ['1', '2', '3'])
})

test('no trades means no curve', () => {
  assert.deepEqual(equityCurve([]), [])
})

test('the page carries the facts of each trade and cannot break out of its script tag', () => {
  const html = renderPage(journal)
  assert.ok(html.includes('"balance":10022.5'))
  assert.ok(html.includes('"ended":"manual"'))
  assert.ok(html.includes('"stop":null'))
  assert.ok(!html.includes('__DATA__'))
  assert.ok(!html.includes('</script> Broker'))
})

test('a trade closed in pieces is filed under the exit that closed most of it', () => {
  const split = trade('1', 10, '2026-09-07T10:00:00Z', '2026-09-07T11:00:00Z')
  split.entry.volume = 1
  split.exits = [
    { dealId: 'a', time: new Date('2026-09-07T11:00:00Z'), price: 101.1, volume: 0.75, reason: { kind: 'manual' } },
    { dealId: 'b', time: new Date('2026-09-07T11:00:05Z'), price: 102.3, volume: 0.25, reason: { kind: 'target', price: 102.3 } },
  ]
  const html = renderPage({ ...journal, trades: [split] })
  assert.ok(html.includes('"ended":"manual"'))
  // The exit price is the average weighted by volume, to the decimals the broker quotes.
  assert.ok(html.includes('"exit":101.4'))
})

test('a dollar sign in a tag survives being put on the page', () => {
  const tagged = { ...trade('1', 10, '2026-09-07T10:00:00Z', '2026-09-07T11:00:00Z'), tag: 'cost $& more' }
  assert.ok(renderPage({ ...journal, trades: [tagged] }).includes('"tag":"cost $& more"'))
})
