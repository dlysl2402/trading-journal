import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchFeed } from './metaapi.ts'
import type { Reply, Transport } from './metaapi.ts'

const credentials = { accountId: 'acc', token: 't', region: 'london' }
const account = { broker: 'B', currency: 'AUD', login: 1, balance: 0, investorMode: true }
const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) })
const down: Reply = { status: 503, body: '<html>503 Service Temporarily Unavailable</html>' }
const reconnecting: Reply = { status: 504, body: '{"error":"TimeoutError","message":"not connected to broker yet"}' }

/** A MetaApi whose front servers each behave as told; every request is remembered. */
function metaapi(fronts: Record<string, Reply | 'refused' | ((path: string) => Reply)>) {
  const calls: string[] = []
  const transport: Transport = async (host, address, path) => {
    calls.push(`${address} ${path.replace(/\?.*/, '').split('/').at(-3) === 'time' ? path.split('/')[5] : path.split('/').at(-1)}`)
    assert.equal(host, 'mt-client-api-v1.london.agiliumtrade.ai')
    const front = fronts[address]
    if (front === 'refused') throw new Error('ECONNREFUSED')
    if (front === undefined) throw new Error(`no such address ${address}`)
    return typeof front === 'function' ? front(path) : front
  }
  const resolve = async () => Object.keys(fronts)
  return { calls, fetch: () => fetchFeed(credentials, new Date(0), transport, resolve) }
}

const answering = (path: string): Reply =>
  path.includes('/accountInformation') ? ok(account) : ok([])

test('a front server that answers 503 is skipped for one that answers', async () => {
  const api = metaapi({ '10.0.0.1': down, '10.0.0.2': answering })
  const feed = await api.fetch()
  assert.equal(feed.account.broker, 'B')
  assert.ok(api.calls.some((c) => c.startsWith('10.0.0.1')), 'the first address was tried')
  assert.ok(api.calls.some((c) => c.startsWith('10.0.0.2')), 'then the second')
})

test('a refused connection is skipped the same way', async () => {
  const api = metaapi({ '10.0.0.1': 'refused', '10.0.0.2': answering })
  assert.equal((await api.fetch()).account.currency, 'AUD')
})

test('when every front server is down the error says so and names the last one', async () => {
  const api = metaapi({ '10.0.0.1': down, '10.0.0.2': down })
  await assert.rejects(api.fetch(), /MetaApi 503 on \/accountInformation via 10\.0\.0\.2/)
})

test('any other status is an answer about the request and is not retried elsewhere', async () => {
  const api = metaapi({ '10.0.0.1': { status: 401, body: '{"error":"UnauthorizedError"}' }, '10.0.0.2': answering })
  await assert.rejects(api.fetch(), /MetaApi 401 on \/accountInformation via 10\.0\.0\.1: .*Unauthorized/)
  assert.ok(!api.calls.some((c) => c.startsWith('10.0.0.2 accountInformation')), 'the second address was not asked')
})

test('what MetaApi restates after the fact is dropped from deals and orders', async () => {
  const api = metaapi({ '10.0.0.1': (path) =>
    path.includes('/accountInformation') ? ok(account)
      : path.includes('/history-deals') ? ok([{ id: '1', accountCurrencyExchangeRate: 0.7 }])
      : ok([{ id: '2', accountCurrencyExchangeRate: 0.7, openPrice: 4352.23 }]) })
  const feed = await api.fetch()
  assert.deepEqual(feed.deals, [{ id: '1' }])
  assert.deepEqual(feed.orders, [{ id: '2' }])
})

test('a 504 is MetaApi reconnecting to the broker, so the list is asked again', async () => {
  // No address answers during a reconnect, so trying the next one is not the
  // remedy; asking again a moment later is.
  const asked = new Set<string>()
  const api = metaapi({ '10.0.0.1': (path) =>
    asked.has(path) ? answering(path) : (asked.add(path), reconnecting) })
  assert.equal((await api.fetch()).account.broker, 'B')
})

test('a reconnect that does not clear still fails the pass', async () => {
  const api = metaapi({ '10.0.0.1': reconnecting })
  await assert.rejects(api.fetch(), /MetaApi 504 on \/accountInformation via 10\.0\.0\.1/)
})
