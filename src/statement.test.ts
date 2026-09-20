import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { parseStatement, readStatement } from './statement.ts'
import { readSheet } from './xlsx.ts'

const FIXTURE = join(import.meta.dirname, '..', 'ReportHistory-51554919.xlsx')

const statement = readStatement(FIXTURE)

test('reads the account header', () => {
  assert.deepEqual(statement.account, {
    id: '51554919',
    name: 'Joshua Zeus Dela Ysla #113',
    currency: 'AUD',
    broker: 'Pepperstone-MT5-Live01',
    marginMode: 'hedge',
  })
})

test('finds every row of all three tables', () => {
  assert.equal(statement.positions.length, 34)
  assert.equal(statement.orders.length, 69)
  assert.equal(statement.deals.length, 73)
})

test('stops at the totals row rather than parsing it as a deal', () => {
  const last = statement.deals.at(-1)
  assert.equal(last?.id, '289310863')
})

test('separates deposits from trading deals', () => {
  const balance = statement.deals.filter((deal) => deal.kind === 'balance')
  const trades = statement.deals.filter((deal) => deal.kind === 'trade')

  assert.equal(balance.length, 4)
  assert.equal(trades.length, 69)
  assert.equal(balance.reduce((total, deal) => total + deal.amount, 0), 32_000)
})

test('one more closing deal than opening deal: a position closed in two pieces', () => {
  const trades = statement.deals.filter((deal) => deal.kind === 'trade')
  assert.equal(trades.filter((deal) => deal.entry === 'in').length, 34)
  assert.equal(trades.filter((deal) => deal.entry === 'out').length, 35)
})

test('an absent stop is null, not zero', () => {
  const withoutStop = statement.positions.filter((position) => position.stopLoss === null)
  assert.equal(withoutStop.length, 8)
})

test('only three entry orders carry a stop; the rest were set after entry', () => {
  assert.equal(statement.orders.filter((order) => order.stopLoss !== null).length, 3)
})

test('a market order has no price; a triggered stop or target does', () => {
  const market = statement.orders.filter((order) => order.price === null)
  const priced = statement.orders.filter((order) => order.price !== null)

  assert.equal(market.length, 61)
  assert.equal(priced.length, 8)
  assert.ok(priced.every((order) => order.comment?.startsWith('[')))
})

test('timestamps do not depend on the machine running the parser', () => {
  const first = statement.positions[0]
  assert.equal(first?.openTime.toISOString(), '2026-09-07T14:30:03.000Z')
  assert.equal(statement.serverUtcOffsetMinutes, null)
})

test('every row records where it came from', () => {
  assert.equal(statement.positions[0]?.sourceRow, 8)
  assert.equal(statement.deals[0]?.sourceRow, 115)
})

test('refuses a report it does not recognise', () => {
  assert.throws(() => parseStatement([['Trade History Report']]), /no "Account:" line/)
})

test('refuses a malformed number rather than reading it as zero', () => {
  const rows = readSheet(FIXTURE)
  rows[7]![12] = 'n/a'
  assert.throws(() => parseStatement(rows), /row 8: expected a number, got "n\/a"/)
})
