/**
 * Reads a MetaApi feed into the layer 1 ledger.
 *
 * The live twin of `statement.ts`: same job, different source. Fields are
 * transcribed, never computed, and an unrecognised value is refused rather
 * than guessed at.
 *
 * One departure from pure transcription is unavoidable. MT5 does not store
 * closed positions at all — the Positions table in a report is drawn up by
 * the terminal by grouping deals on their position id. There is no table to
 * copy here, so the same grouping happens below. It is the sounder of the two
 * paths: the broker states each deal's position id outright, where a report
 * leaves layer 2 to infer the join from symbol, side, volume and timing.
 *
 * That soundness costs a check, and the loss is worth being plain about.
 * `buildTrades` reconciles its joins against the position table's totals; on
 * this path those totals are sums of the very deals being checked, so the
 * check is true by construction and worth nothing. `reconcileBalance` below
 * is the replacement. It catches what this path can actually get wrong — a
 * page of history that never arrived — by insisting every deal ever booked
 * adds up to the balance the broker reports right now.
 */

import type {
  Account, Deal, DealEntry, DealId, Order, OrderId,
  PositionId, PositionRecord, Side, Statement, TradeDeal,
} from './ledger.ts'
import type { RawAccount, RawDeal, RawFeed, RawOrder } from './metaapi.ts'

/** Money and volumes are reported to two decimals, so compare at half a cent. */
const TOLERANCE = 0.005

const BROKER_TIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/

/**
 * Broker server time, read as UTC.
 *
 * Deliberately the same convention as the report parser: every timestamp in
 * the ledger is server time with no offset applied, and the real offset lives
 * in `Statement.serverUtcOffsetMinutes`. Using the API's true-UTC `time` here
 * instead would silently put the two sources three hours apart and make them
 * impossible to compare.
 */
function toServerDate(brokerTime: string, id: string): Date {
  const parts = BROKER_TIME.exec(brokerTime.trim())
  if (!parts) throw new Error(`${id}: unrecognised broker time "${brokerTime}"`)
  const [, year, month, day, hour, minute, second, millis] = parts
  return new Date(Date.UTC(
    +year!, +month! - 1, +day!, +hour!, +minute!, +second!, +(millis ?? 0)))
}

/**
 * How far ahead of UTC the broker's clock runs, from a deal that carries both.
 *
 * Taken from the most recent deal rather than an average: brokers shift with
 * daylight saving, so a history long enough to span a change has no single
 * offset, and the one in force now is the only honest answer for a feed that
 * is about to be polled again.
 */
function serverOffsetMinutes(deals: RawDeal[]): number | null {
  const latest = deals.reduce<RawDeal | null>(
    (newest, deal) => (newest === null || deal.time > newest.time ? deal : newest), null)
  if (latest === null) return null

  const utc = new Date(latest.time).getTime()
  const server = toServerDate(latest.brokerTime, latest.id).getTime()
  return Math.round((server - utc) / 60_000)
}

const DEAL_SIDES: Record<string, Side> = {
  DEAL_TYPE_BUY: 'buy',
  DEAL_TYPE_SELL: 'sell',
}

const DEAL_ENTRIES: Record<string, DealEntry> = {
  DEAL_ENTRY_IN: 'in',
  DEAL_ENTRY_OUT: 'out',
  DEAL_ENTRY_INOUT: 'inout',
}

/** Blank comments arrive as absent or as an empty string; both mean nothing. */
function toText(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text.trim()
}

/**
 * The comment as it stands now, which is the one a report shows.
 *
 * MT5 keeps a single comment per deal and overwrites it when a bracket fires,
 * so an order an EA tagged "RiskManager" reads "[tp 4381.29]" afterwards and
 * the tag is gone for good. MetaApi keeps both halves — `comment` as first
 * set, `brokerComment` as it stands — and taking the later one reproduces
 * what the report would have said. The original survives in the feed either
 * way, which is more than the report can offer.
 */
function currentComment(raw: { comment?: string; brokerComment?: string }): string | null {
  return toText(raw.brokerComment) ?? toText(raw.comment)
}

function toDeal(raw: RawDeal): Deal {
  const base = {
    id: raw.id as DealId,
    time: toServerDate(raw.brokerTime, `deal ${raw.id}`),
    // The API sends each deal's own figures but never the running balance
    // they rolled up into, and layer 1 does not invent one.
    balance: null,
    comment: currentComment(raw),
    sourceRow: null,
  }

  // Deposits, withdrawals and corrections carry no symbol, side or price, and
  // file their amount under profit — the same shape the report uses.
  if (raw.type === 'DEAL_TYPE_BALANCE') {
    return { ...base, kind: 'balance', amount: raw.profit }
  }

  const side = DEAL_SIDES[raw.type]
  if (side === undefined) {
    // Corrections, credits, dividends, commission adjustments and taxes all
    // land here. Each needs deciding on rather than defaulting into a trade.
    throw new Error(`deal ${raw.id}: unrecognised type "${raw.type}"`)
  }

  const entry = DEAL_ENTRIES[raw.entryType ?? '']
  if (entry === undefined) {
    // DEAL_ENTRY_OUT_BY closes one position against an opposing one. The
    // ledger has no shape for a fill that belongs to two round trips.
    throw new Error(`deal ${raw.id}: unrecognised entry type "${raw.entryType}"`)
  }

  if (raw.symbol === undefined || raw.volume === undefined || raw.price === undefined) {
    throw new Error(`deal ${raw.id}: a ${raw.type} deal is missing symbol, volume or price`)
  }

  return {
    ...base,
    kind: 'trade',
    symbol: raw.symbol,
    side,
    entry,
    volume: raw.volume,
    price: raw.price,
    orderId: (raw.orderId ?? '') as OrderId,
    positionId: raw.positionId === undefined ? null : raw.positionId as PositionId,
    commission: raw.commission,
    // MetaApi folds any separate fee into commission and reports no split.
    fee: null,
    swap: raw.swap,
    profit: raw.profit,
  } satisfies TradeDeal
}

function orderSide(raw: RawOrder): Side {
  // MT5 has eight order types; the direction is the word after the prefix,
  // and every one of them is a buy or a sell apart from close-by.
  if (raw.type.startsWith('ORDER_TYPE_BUY')) return 'buy'
  if (raw.type.startsWith('ORDER_TYPE_SELL')) return 'sell'
  throw new Error(`order ${raw.id}: unrecognised type "${raw.type}"`)
}

function toOrder(raw: RawOrder): Order {
  return {
    id: raw.id as OrderId,
    symbol: raw.symbol,
    side: orderSide(raw),
    placedAt: toServerDate(raw.brokerTime, `order ${raw.id}`),
    filledAt: raw.doneTime === undefined
      ? null
      : toServerDate(raw.doneBrokerTime ?? raw.brokerTime, `order ${raw.id}`),
    requestedVolume: raw.volume,
    filledVolume: raw.volume - raw.currentVolume,
    // Zero means MT5 stored no requested price, which is what a market order
    // is. The report spells the same thing "market".
    price: raw.openPrice === 0 ? null : raw.openPrice,
    stopLoss: raw.stopLoss ?? null,
    takeProfit: raw.takeProfit ?? null,
    state: raw.state,
    comment: currentComment(raw),
    sourceRow: null,
  }
}

/**
 * Rebuild the closed-position table the terminal would have drawn.
 *
 * Only round trips that are finished appear. A position still open, or one
 * whose opening deal falls outside the fetched window, is left out rather
 * than reported half-complete — layer 2 expects a spine of closed trades.
 */
function toPositions(raws: RawDeal[]): PositionRecord[] {
  const groups = new Map<string, RawDeal[]>()
  for (const raw of raws) {
    if (raw.positionId === undefined || raw.type === 'DEAL_TYPE_BALANCE') continue
    const group = groups.get(raw.positionId)
    if (group === undefined) groups.set(raw.positionId, [raw])
    else group.push(raw)
  }

  const positions: PositionRecord[] = []
  for (const [id, group] of groups) {
    const ordered = [...group].sort((a, b) => a.time.localeCompare(b.time))
    const entry = ordered.find((raw) => raw.entryType === 'DEAL_ENTRY_IN')
    const exits = ordered.filter((raw) => raw.entryType === 'DEAL_ENTRY_OUT')
    if (entry === undefined || exits.length === 0) continue

    const closed = exits.reduce((total, raw) => total + (raw.volume ?? 0), 0)
    const opened = entry.volume ?? 0
    if (Math.abs(closed - opened) >= TOLERANCE) continue

    const last = ordered[ordered.length - 1]!
    const sum = (pick: (raw: RawDeal) => number) =>
      ordered.reduce((total, raw) => total + pick(raw), 0)

    positions.push({
      id: id as PositionId,
      symbol: entry.symbol!,
      side: DEAL_SIDES[entry.type]!,
      volume: opened,
      openTime: toServerDate(entry.brokerTime, `deal ${entry.id}`),
      openPrice: entry.price!,
      // The levels in force at the close, which is what the report's position
      // table shows: MT5 stamps each deal with the position's current stop.
      stopLoss: last.stopLoss ?? null,
      takeProfit: last.takeProfit ?? null,
      closeTime: toServerDate(exits[exits.length - 1]!.brokerTime, `deal ${last.id}`),
      closePrice: exits.reduce((total, raw) => total + raw.price! * raw.volume!, 0) / closed,
      commission: sum((raw) => raw.commission),
      swap: sum((raw) => raw.swap),
      profit: sum((raw) => raw.profit),
      sourceRow: null,
    })
  }
  return positions
}

const MARGIN_MODES: Record<string, Account['marginMode']> = {
  ACCOUNT_MARGIN_MODE_RETAIL_HEDGING: 'hedge',
  ACCOUNT_MARGIN_MODE_RETAIL_NETTING: 'netting',
}

function toAccount(raw: RawAccount): Account {
  const marginMode = MARGIN_MODES[raw.marginMode]
  if (marginMode === undefined) {
    // ACCOUNT_MARGIN_MODE_EXCHANGE is neither, and every pairing rule in
    // layer 2 assumes one or the other.
    throw new Error(`unsupported margin mode "${raw.marginMode}"`)
  }
  return {
    id: String(raw.login),
    name: raw.name,
    currency: raw.currency,
    broker: raw.broker,
    marginMode,
  }
}

/**
 * Every deal ever booked, against the balance the broker reports now.
 *
 * This is the whole-history check that replaces a per-position one. A deal
 * lost to a dropped page, or counted twice by a paging slip, shows up here as
 * a discrepancy; nothing else on this path would notice either.
 */
export function reconcileBalance(statement: Statement): void {
  const reported = statement.reportedBalance
  if (reported === null) return

  const ours = statement.deals.reduce((total, deal) =>
    deal.kind === 'balance'
      ? total + deal.amount
      : total + deal.profit + deal.commission + deal.swap + (deal.fee ?? 0), 0)

  if (Math.abs(ours - reported) >= TOLERANCE) {
    throw new Error(
      `${statement.deals.length} deals add up to ${ours.toFixed(2)}, ` +
      `but the broker reports a balance of ${reported.toFixed(2)} — ` +
      `the history fetched is incomplete`)
  }
}

export function parseFeed(feed: RawFeed): Statement {
  const statement: Statement = {
    account: toAccount(feed.account),
    generatedAt: feed.fetchedAt,
    serverUtcOffsetMinutes: serverOffsetMinutes(feed.deals),
    reportedBalance: feed.account.balance,
    deals: feed.deals.map(toDeal),
    orders: feed.orders.map(toOrder),
    positions: toPositions(feed.deals),
  }
  reconcileBalance(statement)
  return statement
}
