import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { insert, selectAll, storeFromEnv, upsert } from './supabase.ts'

const store = { url: 'https://x.supabase.co', key: 'sb_secret_test' }

/** Answer each request from a script, remembering what was asked. */
function fakeFetch(answers: Array<{ body?: unknown; total?: number; status?: number }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = mock.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const answer = answers.shift() ?? {}
    const headers = new Headers()
    if (answer.total !== undefined) headers.set('content-range', `0-0/${answer.total}`)
    return new Response(JSON.stringify(answer.body ?? []), { status: answer.status ?? 200, headers })
  })
  mock.method(globalThis, 'fetch', fetch as typeof globalThis.fetch)
  return calls
}

test.afterEach(() => mock.restoreAll())

test('credentials come from the environment, with a trailing slash dropped', () => {
  assert.deepEqual(
    storeFromEnv({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SECRET_KEY: 'k' }),
    { url: 'https://x.supabase.co', key: 'k' })
  assert.throws(() => storeFromEnv({}), /SUPABASE_URL/)
})

test('a read walks pages until the total the server states is reached', async () => {
  const calls = fakeFetch([
    { body: [{ raw: 1 }], total: 3 },
    { body: [{ raw: 2 }], total: 3 },
    { body: [{ raw: 3 }], total: 3 },
  ])
  const rows = await selectAll(store, 'deals', 'account_id=eq.a&select=raw')
  assert.deepEqual(rows, [{ raw: 1 }, { raw: 2 }, { raw: 3 }])
  assert.deepEqual(calls.map((c) => c.url), [
    'https://x.supabase.co/rest/v1/deals?account_id=eq.a&select=raw&limit=1000&offset=0',
    'https://x.supabase.co/rest/v1/deals?account_id=eq.a&select=raw&limit=1000&offset=1',
    'https://x.supabase.co/rest/v1/deals?account_id=eq.a&select=raw&limit=1000&offset=2',
  ])
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers.apikey, 'sb_secret_test')
  assert.equal(headers.Authorization, 'Bearer sb_secret_test')
  assert.equal(headers.Prefer, 'count=exact')
})

test('an insert never asks to merge, an upsert does, and neither sends empty', async () => {
  const calls = fakeFetch([{}, {}])
  await insert(store, 'deals', [])
  await upsert(store, 'accounts', [])
  assert.equal(calls.length, 0)

  await insert(store, 'deals', [{ id: '1' }])
  await upsert(store, 'accounts', [{ account_id: 'a' }])
  const prefers = calls.map((c) => (c.init.headers as Record<string, string>).Prefer)
  assert.deepEqual(prefers, ['return=minimal', 'return=minimal,resolution=merge-duplicates'])
  assert.equal(calls[0]!.init.body, '[{"id":"1"}]')
})

test('a refusal names the status, the table and what the server said', async () => {
  fakeFetch([{ status: 409, body: { message: 'duplicate key' } }])
  await assert.rejects(
    insert(store, 'deals', [{ id: '1' }]),
    /Supabase 409 on POST deals: .*duplicate key/)
})
