/**
 * Layer 2 — the trade.
 *
 * Layer 1 is the feed itself: `data/snapshot.json` holds every deal and order
 * exactly as MetaApi sent them. This module turns that into round trips. It
 * holds facts about each trade — what was done, at what price, why it ended —
 * and no metrics: net P&L, R-multiples and the equity curve are functions of
 * these fields, derived when needed so they can never drift from the broker.
 *
 * MT5 does not store closed positions. A terminal draws that table by grouping
 * deals on their position id, and the same grouping happens here. Anything the
 * feed can send that this module has no shape for — a correction, a close-by,
 * a stop-out — is refused rather than guessed at, so a surprise is loud.
 */

import type { RawDeal, RawFeed, RawOrder } from './metaapi.ts'

export type Side = 'buy' | 'sell'

/** A single execution. */
export interface Fill {
  dealId: string
  /** Broker server time, read as UTC: the clock the MT5 terminal shows. */
  time: Date
  price: number
  volume: number
}

/**
 * A closing fill, carrying why that particular exit happened. The reason sits
 * here rather than on the trade because they genuinely differ: one position
 * was closed 0.26 by hand and the remaining 0.03 by its take-profit, seconds
 * apart. A single trade-level reason has to lie about one.
 */
export interface ExitFill extends Fill {
  reason: ExitReason
}

/**
 * Why an exit happened. `price` is the level that triggered, which is not the
 * price that filled — the gap between them is slippage, and it is worth keeping.
 */
export type ExitReason =
  | { kind: 'stop'; price: number }
  | { kind: 'target'; price: number }
  | { kind: 'manual' }

/**
 * A protective or profit level across the life of the trade.
 *
 * Splitting initial from final is the whole point. Only orders placed with a
 * level attached record one at entry; everywhere else the level was set
 * afterwards and the original is unrecoverable. Collapsing the two into one
 * number turns a stop trailed to breakeven into a trade that risked six cents
 * — and an R-multiple of 54 where the honest answer is 0.86.
 */
export interface Level {
  /** From the entry order. `null` means it was set after entry: unknown. */
  initial: number | null
  /** As it stood at the close. */
  final: number | null
}

/**
 * A completed round trip.
 *
 * One entry, because this is a hedging account: adding to a position opens a
 * second one rather than enlarging the first. Many exits, because closing in
 * pieces is ordinary.
 */
export interface Trade {
  positionId: string
  symbol: string
  side: Side
  entry: Fill
  exits: ExitFill[]
  stop: Level
  target: Level
  /** The entry order's comment — often the strategy or tool that placed it. */
  tag: string | null
  /**
   * Broker figures, kept apart rather than pre-summed. Profit is gross; net is
   * profit + commission + swap, and one `pnl` field would quietly hide the
   * costs that make the difference.
   */
  grossProfit: number
  commission: number
  swap: number
}

/** The account as of one fetch. */
export interface Journal {
  account: { id: string; broker: string; currency: string }
  /** What the broker says the account holds right now. */
  balance: number
  /** Deposits less withdrawals. */
  deposited: number
  /**
   * How far ahead of UTC the broker's clock runs, from the latest deal. One
   * deal rather than an average: brokers shift with daylight saving, so the
   * offset in force now is the only honest answer.
   */
  serverUtcOffsetMinutes: number | null
  /** Closed round trips only. An open position is not a trade yet. */
  trades: Trade[]
}

/** Money and volumes are reported to two decimals, so compare at half a cent. */
const TOLERANCE = 0.005

const SIDES: Record<string, Side> = { DEAL_TYPE_BUY: 'buy', DEAL_TYPE_SELL: 'sell' }

const MANUAL = new Set([
  'DEAL_REASON_CLIENT', 'DEAL_REASON_MOBILE', 'DEAL_REASON_WEB', 'DEAL_REASON_EXPERT',
])

/** A fill: a deal that changed exposure, with everything a deposit lacks. */
type FillDeal = RawDeal &
  Required<Pick<RawDeal, 'entryType' | 'symbol' | 'volume' | 'price' | 'orderId' | 'positionId'>>

/**
 * Whether a deal is a fill rather than a deposit — refusing on the way any
 * deal the journal has no shape for. Corrections, credits and dividends each
 * need deciding on rather than defaulting into a trade, and a close-by
 * (DEAL_ENTRY_OUT_BY) belongs to two round trips at once.
 */
function isFill(deal: RawDeal): deal is FillDeal {
  if (deal.type === 'DEAL_TYPE_BALANCE') return false
  if (SIDES[deal.type] === undefined) {
    throw new Error(`deal ${deal.id}: unrecognised type "${deal.type}"`)
  }
  if (deal.entryType !== 'DEAL_ENTRY_IN' && deal.entryType !== 'DEAL_ENTRY_OUT') {
    throw new Error(`deal ${deal.id}: unrecognised entry type "${deal.entryType}"`)
  }
  if (deal.symbol === undefined || deal.volume === undefined || deal.price === undefined ||
      deal.orderId === undefined || deal.positionId === undefined) {
    throw new Error(`deal ${deal.id}: a fill is missing its symbol, volume, price or order`)
  }
  return true
}

/**
 * Broker server time, read as if it were UTC.
 *
 * The feed carries true UTC as well, but the terminal, its charts and the
 * trader's memory all run on the broker's clock, so that is the one the
 * journal keeps. The real offset is recorded once, on the journal.
 */
function serverTime(deal: RawDeal): Date {
  const time = new Date(deal.brokerTime.replace(' ', 'T') + 'Z')
  if (Number.isNaN(time.getTime())) {
    throw new Error(`deal ${deal.id}: unrecognised broker time "${deal.brokerTime}"`)
  }
  return time
}

const byTime = (a: RawDeal, b: RawDeal) => a.time.localeCompare(b.time)

function serverUtcOffsetMinutes(deals: RawDeal[]): number | null {
  const latest = deals.toSorted(byTime).at(-1)
  if (latest === undefined) return null
  return Math.round((serverTime(latest).getTime() - new Date(latest.time).getTime()) / 60_000)
}

function fill(deal: FillDeal): Fill {
  return { dealId: deal.id, time: serverTime(deal), price: deal.price, volume: deal.volume }
}

/**
 * Why a closing deal fired, from the broker's own reason code. The level that
 * triggered is the position's stop or target as it stood on that very deal.
 */
function exitReason(deal: FillDeal): ExitReason {
  if (deal.reason === 'DEAL_REASON_SL' && deal.stopLoss !== undefined) {
    return { kind: 'stop', price: deal.stopLoss }
  }
  if (deal.reason === 'DEAL_REASON_TP' && deal.takeProfit !== undefined) {
    return { kind: 'target', price: deal.takeProfit }
  }
  if (MANUAL.has(deal.reason ?? '')) return { kind: 'manual' }
  // A stop-out is a margin call, not a decision; it must not pass as manual.
  throw new Error(`deal ${deal.id}: unrecognised reason "${deal.reason}"`)
}

/**
 * What placed the entry, from its order's comment. MT5 overwrites a comment
 * with "[sl 1.23]" or "[tp 1.23]" when that bracket fires, and a stamp like
 * that names a level, not a strategy.
 */
function tagOf(order: RawOrder | undefined): string | null {
  const comment = order?.comment?.trim() ?? ''
  return comment === '' || /^\[(sl|tp) /.test(comment) ? null : comment
}

/** One position's deals, oldest first, as a trade — or `null` if not closed yet. */
function toTrade(
  positionId: string, deals: FillDeal[], orders: Map<string, RawOrder>,
): Trade | null {
  const [entry, ...more] = deals.filter((deal) => deal.entryType === 'DEAL_ENTRY_IN')
  if (more.length > 0) {
    // A netting account enlarges a position rather than opening another; the
    // journal has no shape for a round trip with two entries.
    throw new Error(`position ${positionId}: opened by ${more.length + 1} deals, expected one`)
  }

  const exits = deals.filter((deal) => deal.entryType === 'DEAL_ENTRY_OUT')
  const closed = exits.reduce((total, deal) => total + deal.volume, 0)
  // Still open, or opened before the history fetched: not a trade yet.
  if (entry === undefined || closed < entry.volume - TOLERANCE) return null
  if (closed > entry.volume + TOLERANCE) {
    throw new Error(`position ${positionId}: closed ${closed} of ${entry.volume} lots`)
  }

  const order = orders.get(entry.orderId)
  const last = deals.at(-1)!
  const sum = (pick: (deal: FillDeal) => number) =>
    deals.reduce((total, deal) => total + pick(deal), 0)

  return {
    positionId,
    symbol: entry.symbol,
    side: SIDES[entry.type]!,
    entry: fill(entry),
    exits: exits.map((deal) => ({ ...fill(deal), reason: exitReason(deal) })),
    stop: { initial: order?.stopLoss ?? null, final: last.stopLoss ?? null },
    target: { initial: order?.takeProfit ?? null, final: last.takeProfit ?? null },
    tag: tagOf(order),
    grossProfit: sum((deal) => deal.profit),
    commission: sum((deal) => deal.commission),
    swap: sum((deal) => deal.swap),
  }
}

/**
 * Every deal ever booked, against the balance the broker reports now.
 *
 * The one check this path needs. A deal lost to a dropped page, or counted
 * twice by a paging slip, shows up here as a discrepancy, and nothing else
 * would notice. A deposit books its amount as profit with no commission or
 * swap, so one sum covers every kind of deal.
 */
function reconcileBalance(feed: RawFeed): void {
  const booked = feed.deals.reduce(
    (total, deal) => total + deal.profit + deal.commission + deal.swap, 0)
  if (Math.abs(booked - feed.account.balance) >= TOLERANCE) {
    throw new Error(
      `${feed.deals.length} deals add up to ${booked.toFixed(2)}, but the broker reports ` +
      `a balance of ${feed.account.balance.toFixed(2)} — the history fetched is incomplete`)
  }
}

export function buildJournal(feed: RawFeed): Journal {
  reconcileBalance(feed)

  const orders = new Map(feed.orders.map((order) => [order.id, order]))
  const fills = feed.deals.filter(isFill).toSorted(byTime)
  const trades: Trade[] = []
  for (const [positionId, deals] of Map.groupBy(fills, (deal) => deal.positionId)) {
    const trade = toTrade(positionId, deals, orders)
    if (trade !== null) trades.push(trade)
  }

  const { account } = feed
  return {
    account: { id: String(account.login), broker: account.broker, currency: account.currency },
    balance: account.balance,
    deposited: feed.deals
      .filter((deal) => deal.type === 'DEAL_TYPE_BALANCE')
      .reduce((total, deal) => total + deal.profit, 0),
    serverUtcOffsetMinutes: serverUtcOffsetMinutes(feed.deals),
    trades,
  }
}
