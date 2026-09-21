/**
 * One pass of the import: fetch the account, add what is new to the record.
 *
 * Deliberately a one-shot rather than a process that sleeps. Run under a timer
 * — systemd, cron, launchd — it has no state to corrupt between runs, no
 * in-memory drift, one log entry and one exit code per attempt, and a crash
 * costs a single cycle instead of the whole schedule. A non-zero exit is what
 * a timer reports as a failure, so failures are loud rather than silent.
 *
 * The record lives in Supabase and only ever grows: `ledger.ts` refuses a feed
 * that has lost or altered a row it already holds. One local file is also
 * written — `data/snapshot.json`, the raw response of this run, so a parsing
 * question can be re-asked offline without hitting the API again.
 *
 * Nothing here interprets and nothing here draws. Grouping deals into trades,
 * and every figure worked out from them, belong to `trading-journal-frontend`,
 * which reads this record from the browser.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { load, merge, save } from './ledger.ts'
import { credentialsFromEnv, fetchFeed } from './metaapi.ts'
import type { RawFeed } from './metaapi.ts'
import { storeFromEnv } from './supabase.ts'

/**
 * The credential MetaApi holds should be the investor password, which cannot
 * trade. If it is the master password the account is one API call away from a
 * live order, which is worth saying every single run rather than once.
 */
function checkReadOnly(feed: RawFeed): void {
  if (feed.account.investorMode) return
  console.warn(
    'WARNING: MetaApi holds this account\'s master password, not the investor ' +
    'password — it is able to place trades. Replace the password on the ' +
    'MetaApi account with the read-only investor password.')
}

export async function update(): Promise<string> {
  const credentials = credentialsFromEnv()
  const store = storeFromEnv()

  const feed = await fetchFeed(credentials)
  checkReadOnly(feed)

  // The record takes whatever the broker booked, whether or not anything can
  // yet make a trade of it. A deal with a shape the journal refuses still
  // happened, and belongs on record before anyone argues about it.
  const stored = await load(store, credentials.accountId)
  const added = merge(stored, feed)
  await save(store, credentials.accountId, added, feed)

  // Deals and orders carry the account holder's name; `data/` stays out of git.
  mkdirSync('data', { recursive: true })
  writeFileSync('data/snapshot.json', JSON.stringify(feed, null, 2))

  const { account } = feed
  return [
    `${feed.fetchedAt.toISOString()} ${account.login} ${account.broker}`,
    `${feed.deals.length} deals on record, ${added.deals.length} new`,
    `${feed.orders.length} orders on record, ${added.orders.length} new`,
    `balance ${account.balance.toFixed(2)} ${account.currency}`,
  ].join(' · ')
}

async function main(): Promise<void> {
  try {
    // Absent on a server that passes the credentials in as environment.
    process.loadEnvFile()
  } catch {}

  try {
    console.log(await update())
  } catch (error) {
    // A timer reads the exit code, not the message, so do both.
    console.error(`update failed: ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
