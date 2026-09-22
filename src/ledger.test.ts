import assert from 'node:assert/strict'
import test from 'node:test'
import { merge } from './ledger.ts'
import { withoutUnsettledFields } from './metaapi.ts'
import type { RawDeal, RawOrder } from './metaapi.ts'

function deal(id: string, over: Partial<RawDeal> = {}): RawDeal {
  return {
    id, type: 'DEAL_TYPE_BUY', time: '2026-09-07T11:30:03.000Z',
    brokerTime: '2026-09-07 14:30:03.000', commission: 0, swap: 0, profit: 0, ...over,
  }
}

const order = (id: string, over: Partial<RawOrder> = {}): RawOrder => ({ id, ...over })

const rows = (deals: RawDeal[] = [], orders: RawOrder[] = []) => ({ deals, orders })

test('an empty record takes the whole feed', () => {
  const feed = rows([deal('1'), deal('2')], [order('1')])
  assert.deepEqual(merge(rows(), feed), feed)
})

test('only rows not yet on record are additions', () => {
  const added = merge(rows([deal('1')], [order('1')]), rows([deal('1'), deal('2')], [order('1'), order('9')]))
  assert.deepEqual(added.deals.map((d) => d.id), ['2'])
  assert.deepEqual(added.orders.map((o) => o.id), ['9'])
})

test('a row on record that the feed no longer has stops the run', () => {
  assert.throws(
    () => merge(rows([deal('1'), deal('2')]), rows([deal('1')])),
    /1 deal\(s\) on record are missing from the feed \(2\)/)
})

test('a row on record that the feed now states differently stops the run', () => {
  assert.throws(
    () => merge(rows([deal('1', { profit: 10 })]), rows([deal('1', { profit: 11 })])),
    /1 deal\(s\) on record differ from the feed \(1\)/)
  assert.throws(
    () => merge(rows([], [order('1', { comment: 'a' })]), rows([], [order('1', { comment: 'b' })])),
    /1 order\(s\) on record differ/)
})

test('key order is not a difference: Postgres reorders JSON keys', () => {
  const stored = { profit: 1, id: '1', swap: 0, commission: 0, type: 'DEAL_TYPE_BUY',
    time: '2026-09-07T11:30:03.000Z', brokerTime: '2026-09-07 14:30:03.000' } as RawDeal
  assert.deepEqual(merge(rows([stored]), rows([deal('1', { profit: 1 })])), rows())
})

test('a field the journal does not read still counts', () => {
  const extra = { ...deal('1'), magic: 7 } as RawDeal
  const other = { ...deal('1'), magic: 8 } as RawDeal
  assert.throws(() => merge(rows([extra]), rows([other])), /differ/)
  assert.deepEqual(merge(rows([extra]), rows([{ ...extra }])), rows())
})

test('the exchange rate MetaApi stamps at fetch time is not part of the row', () => {
  const stamped = { ...deal('1'), accountCurrencyExchangeRate: 0.71257 } as RawDeal
  const later = { ...deal('1'), accountCurrencyExchangeRate: 0.71255 } as RawDeal
  assert.throws(() => merge(rows([stamped]), rows([later])), /differ/)
  assert.deepEqual(merge(rows([withoutUnsettledFields(stamped)]), rows([withoutUnsettledFields(later)])), rows())
  assert.deepEqual(withoutUnsettledFields(stamped), deal('1'))
})

test('the price an order asked for is not part of the row either', () => {
  // What stopped the record on 2026-09-21: the pass that caught order
  // 330490870 while the position was still open recorded the working price,
  // and MetaApi settled the field to 0 once the order was done.
  const live = { ...order('1'), openPrice: 4352.23 } as RawOrder
  const settled = { ...order('1'), openPrice: 0 } as RawOrder
  assert.throws(() => merge(rows([], [live]), rows([], [settled])), /1 order\(s\) on record differ/)
  assert.deepEqual(
    merge(rows([], [withoutUnsettledFields(live)]), rows([], [withoutUnsettledFields(settled)])), rows())
})
