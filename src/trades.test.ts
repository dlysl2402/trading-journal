import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import type { Statement } from './ledger.ts'
import { readStatement } from './statement.ts'
import { buildTrades } from './trades.ts'

const FIXTURE = join(import.meta.dirname, '..', 'ReportHistory-51554919.xlsx')

const statement = readStatement(FIXTURE)
const trades = buildTrades(statement)

const find = (id: string) => trades.find((trade) => trade.positionId === id)

test('one trade per round trip', () => {
  assert.equal(trades.length, 34)
})

test('net result matches the statement total', () => {
  const net = trades.reduce((total, t) => total + t.grossProfit + t.commission + t.swap, 0)
  assert.equal(net.toFixed(2), '322.81')
})

test('gross profit alone overstates the result by the cost of trading', () => {
  const gross = trades.reduce((total, t) => total + t.grossProfit, 0)
  assert.equal(gross.toFixed(2), '376.15')
})

test('every closing deal is accounted for', () => {
  const fills = trades.reduce((total, t) => total + t.exits.length, 0)
  assert.equal(fills, 35)
})

test('exits are classified by what closed them', () => {
  const counted = { stop: 0, target: 0, manual: 0 }
  for (const trade of trades) for (const exit of trade.exits) counted[exit.reason.kind]++

  assert.deepEqual(counted, { stop: 5, target: 3, manual: 27 })
})

test('a position closed in two pieces keeps both, with their own reasons', () => {
  const trade = find('330080948')
  assert.equal(trade?.exits.length, 2)
  assert.deepEqual(trade?.exits.map((exit) => exit.volume), [0.26, 0.03])
  assert.deepEqual(trade?.exits.map((exit) => exit.reason.kind), ['manual', 'target'])
})

test('a trailed stop keeps both the risk taken and the level it ended at', () => {
  const trade = find('330080948')
  assert.deepEqual(trade?.stop, { initial: 4389.36, final: 4385.49 })
})

test('a stop set after entry records the original as unknown, not as zero', () => {
  const trade = find('327547948')
  assert.deepEqual(trade?.stop, { initial: null, final: 4355.23 })
})

test('a target moved closer keeps the original', () => {
  const trade = find('329591296')
  assert.deepEqual(trade?.target, { initial: 4323.28, final: 4321.43 })
})

test('the level that fired is kept apart from the price that filled', () => {
  const exit = find('329591296')?.exits[0]
  assert.deepEqual(exit?.reason, { kind: 'target', price: 4321.43 })
  assert.equal(exit?.price, 4321.62)
})

test('carries the tag of whatever placed the entry', () => {
  assert.equal(find('329107216')?.tag, 'RiskSizer')
  assert.equal(find('330080948')?.tag, 'RiskManager')
  assert.equal(find('325519725')?.tag, null)
})

test('two positions opened in the same second keep their own exits', () => {
  // Both bought 0.25 at 04:01:19; the second one closed first. Matching by
  // close time rather than open time is what keeps these from swapping.
  assert.deepEqual(find('326898108')?.exits.map((exit) => exit.price), [4407.54])
  assert.deepEqual(find('326898107')?.exits.map((exit) => exit.price), [4412.29])
  assert.equal(find('326898108')?.grossProfit, -11.44)
  assert.equal(find('326898107')?.grossProfit, 164.27)
})

/** Deep copy, so a test can corrupt the ledger without affecting the others. */
function corrupt(edit: (statement: Statement) => void): Statement {
  const copy = structuredClone(statement)
  edit(copy)
  return copy
}

test('rejects a join that disagrees with the broker', () => {
  const broken = corrupt((s) => {
    const deal = s.deals.find((d) => d.id === '289310369')
    if (deal?.kind === 'trade') deal.profit += 10
  })
  assert.throws(() => buildTrades(broken), /profit from deals is 143.24, statement says 133.24/)
})

test('rejects a position whose exits do not add up to its size', () => {
  const broken = corrupt((s) => {
    s.deals = s.deals.filter((deal) => deal.id !== '289310863')
  })
  assert.throws(() => buildTrades(broken), /closed 0.26 of 0.29 lots/)
})

test('rejects a closing deal that belongs to no position', () => {
  const broken = corrupt((s) => {
    s.positions = s.positions.filter((position) => position.id !== '325519725')
  })
  assert.throws(() => buildTrades(broken), /1 closing deals belong to no position/)
})
