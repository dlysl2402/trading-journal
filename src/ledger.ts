/**
 * Layer 1 — the record.
 *
 * The feed is re-read in full every run. This module compares that read with
 * what is already on record and adds only what is new. It never removes and
 * never overwrites: a row that is on record but missing from the feed, or that
 * differs from it, stops the run with the ids named, because either the broker
 * has pruned or amended history or the fetch is broken, and both deserve a
 * person rather than a sync.
 *
 * `merge` is a pure function of two lists and holds every rule; `load` and
 * `save` only move rows. Once a merge has passed, the record plus its additions
 * equals the feed exactly — which is what lets the journal keep building from
 * the feed it fetched.
 */

import type { RawDeal, RawFeed, RawOrder } from './metaapi.ts'
import { insert, selectAll, upsert } from './supabase.ts'
import type { Store } from './supabase.ts'

export interface Rows {
  deals: RawDeal[]
  orders: RawOrder[]
}

/**
 * The same object however its keys are ordered. Postgres stores JSON with its
 * own key order, so a row read back never matches a fresh one byte for byte.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v)
}

function additions<T extends { id: string }>(kind: string, stored: T[], fresh: T[]): T[] {
  const freshById = new Map(fresh.map((row) => [row.id, row]))
  const missing: string[] = []
  const changed: string[] = []
  for (const row of stored) {
    const now = freshById.get(row.id)
    if (now === undefined) missing.push(row.id)
    else if (canonical(now) !== canonical(row)) changed.push(row.id)
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} ${kind}(s) on record are missing from the feed (${missing.join(', ')}) ` +
      '— the record was left as it was')
  }
  if (changed.length > 0) {
    throw new Error(
      `${changed.length} ${kind}(s) on record differ from the feed (${changed.join(', ')}) ` +
      '— the record was left as it was')
  }

  const known = new Set(stored.map((row) => row.id))
  return fresh.filter((row) => !known.has(row.id))
}

/** What the feed has that the record does not. Throws rather than ever shrinking or changing it. */
export function merge(stored: Rows, feed: Rows): Rows {
  return {
    deals: additions('deal', stored.deals, feed.deals),
    orders: additions('order', stored.orders, feed.orders),
  }
}

export async function load(store: Store, accountId: string): Promise<Rows> {
  const filter = `account_id=eq.${encodeURIComponent(accountId)}&select=raw`
  const [deals, orders] = await Promise.all([
    selectAll<{ raw: RawDeal }>(store, 'deals', filter),
    selectAll<{ raw: RawOrder }>(store, 'orders', filter),
  ])
  return { deals: deals.map((row) => row.raw), orders: orders.map((row) => row.raw) }
}

/**
 * Record the additions, then stamp the account. Deals first, orders second,
 * account last: a run that dies between steps leaves nothing to undo, because
 * the next merge simply finds fewer additions, and `fetched_at` only moves
 * once every row is in.
 */
export async function save(
  store: Store, accountId: string, added: Rows, feed: RawFeed,
): Promise<void> {
  const row = (raw: RawDeal | RawOrder) => ({ account_id: accountId, id: raw.id, raw })
  await insert(store, 'deals', added.deals.map(row))
  await insert(store, 'orders', added.orders.map(row))
  await upsert(store, 'accounts', [
    { account_id: accountId, raw: feed.account, fetched_at: feed.fetchedAt.toISOString() },
  ])
}
