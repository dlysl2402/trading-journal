/**
 * One pass of the import: fetch the account, rebuild everything from it.
 *
 * Deliberately a one-shot rather than a process that sleeps. Run under a timer
 * — systemd, cron, launchd — it has no state to corrupt between runs, no
 * in-memory drift, one log entry and one exit code per attempt, and a crash
 * costs a single cycle instead of the whole schedule. A non-zero exit is what
 * a timer reports as a failure, so failures are loud rather than silent.
 *
 * Two files are written each pass. `data/snapshot.json` keeps the raw feed
 * exactly as MetaApi sent it, so a parsing question can be re-asked offline
 * without hitting the API again, and so a monitor can read `fetchedAt` and
 * notice the feed has gone stale. `equity.html` is the current view.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { renderPage } from './chart.ts'
import { buildJournal } from './journal.ts'
import { credentialsFromEnv, fetchFeed } from './metaapi.ts'
import type { RawFeed } from './metaapi.ts'

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
  const feed = await fetchFeed(credentialsFromEnv())
  checkReadOnly(feed)
  const journal = buildJournal(feed)

  // Deals and orders carry the account holder's name; `data/` stays out of git.
  mkdirSync('data', { recursive: true })
  writeFileSync('data/snapshot.json', JSON.stringify(feed, null, 2))
  writeFileSync('equity.html', renderPage(journal))

  const { account, serverUtcOffsetMinutes: offset } = journal
  return [
    `${feed.fetchedAt.toISOString()} ${account.id} ${account.broker}`,
    `${feed.deals.length} deals, ${journal.trades.length} trades`,
    `balance ${journal.balance.toFixed(2)} ${account.currency}`,
    `server UTC${offset === null ? '?' : offset >= 0 ? `+${offset / 60}` : offset / 60}`,
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
