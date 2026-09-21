import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { equityCurve, renderPage } from './chart.ts'
import { readStatement } from './statement.ts'
import { buildTrades } from './trades.ts'

const FIXTURE = join(import.meta.dirname, '..', 'ReportHistory-51554919.xlsx')

const statement = readStatement(FIXTURE)
const trades = buildTrades(statement)
const curve = equityCurve(trades)

test('the curve starts at zero and has one point per trade', () => {
  assert.equal(curve[0]?.equity, 0)
  assert.equal(curve[0]?.trade, null)
  assert.equal(curve.length, trades.length + 1)
})

test('the curve ends on the statement net result', () => {
  assert.equal(curve.at(-1)?.equity.toFixed(2), '322.81')
})

test('the curve moves forward in time', () => {
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i]!.time >= curve[i - 1]!.time)
  }
})

test('no trades means no curve', () => {
  assert.deepEqual(equityCurve([]), [])
})

test('the page carries the data and cannot break out of its script tag', () => {
  const html = renderPage(statement, trades)
  assert.ok(html.includes('"balance":32322.81'))
  assert.ok(!html.includes('__DATA__'))
  assert.ok(!/const data = .*<\//.test(html.split('\n').find((line) => line.startsWith('const data')) ?? ''))
})
