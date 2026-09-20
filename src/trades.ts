/**
 * Builds layer 2 trades from the layer 1 ledger.
 *
 * The report never says which position a deal belongs to, so the link has to
 * be reconstructed: entry deals name the order whose id is the position's,
 * and exits are matched by symbol, side, volume and the window between open
 * and close. A guess like that is only safe if it is checked, so every trade
 * is reconciled against the broker's own totals before it is returned.
 */

import type { Deal, Order, OrderId, PositionRecord, Statement, TradeDeal } from './ledger.ts'
import type { ExitFill, ExitReason, Fill, Level, Trade } from './trade.ts'

/** Money and volumes are printed to two decimals, so compare at half a cent. */
const TOLERANCE = 0.005

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < TOLERANCE
}

const TRIGGERED = /^\[(sl|tp) ([\d.]+)]$/

/**
 * Why an exit happened, read from the deal's comment. MT5 stamps a closing
 * deal with the level that fired; anything else was closed by hand.
 */
function exitReason(comment: string | null): ExitReason {
  const parts = TRIGGERED.exec(comment ?? '')
  if (!parts) return { kind: 'manual' }
  return { kind: parts[1] === 'sl' ? 'stop' : 'target', price: Number(parts[2]) }
}

function fill(deal: TradeDeal): Fill {
  return { dealId: deal.id, time: deal.time, price: deal.price, volume: deal.volume }
}

/** A bracket comment records a triggered level, not a strategy name. */
function tagOf(order: Order | undefined): string | null {
  const comment = order?.comment ?? null
  return comment === null || TRIGGERED.test(comment) ? null : comment
}

function isTradeDeal(deal: Deal): deal is TradeDeal {
  return deal.kind === 'trade'
}

/**
 * Claim the closing deals for one position.
 *
 * Positions are processed in the order they closed, so an earlier round trip
 * always takes its own exits before a later one can see them. That is what
 * keeps two identical positions opened in the same second from stealing each
 * other's fills.
 */
function claimExits(position: PositionRecord, available: Set<TradeDeal>): TradeDeal[] {
  const opposite = position.side === 'buy' ? 'sell' : 'buy'
  const candidates = [...available]
    .filter((deal) =>
      deal.symbol === position.symbol &&
      deal.side === opposite &&
      deal.time > position.openTime &&
      deal.time <= position.closeTime)
    .sort((a, b) => a.time.getTime() - b.time.getTime())

  const claimed: TradeDeal[] = []
  let volume = 0
  for (const deal of candidates) {
    if (near(volume, position.volume)) break
    claimed.push(deal)
    volume += deal.volume
  }

  if (!near(volume, position.volume)) {
    throw new Error(
      `position ${position.id}: closed ${volume} of ${position.volume} lots — ` +
      `found ${claimed.length} exit deals, expected the full size`)
  }
  for (const deal of claimed) available.delete(deal)
  return claimed
}

/**
 * Check the reconstructed trade against the broker's own figures. If these
 * disagree the join is wrong, and a wrong join is worse than no journal.
 */
function reconcile(position: PositionRecord, entry: TradeDeal, exits: TradeDeal[]): void {
  const sum = (pick: (deal: TradeDeal) => number) =>
    exits.reduce((total, deal) => total + pick(deal), pick(entry))

  const checks: [name: string, ours: number, theirs: number][] = [
    ['profit', sum((deal) => deal.profit), position.profit],
    ['commission', sum((deal) => deal.commission), position.commission],
    ['swap', sum((deal) => deal.swap), position.swap],
  ]

  for (const [name, ours, theirs] of checks) {
    if (!near(ours, theirs)) {
      throw new Error(
        `position ${position.id}: ${name} from deals is ${ours.toFixed(2)}, ` +
        `statement says ${theirs.toFixed(2)}`)
    }
  }
}

export function buildTrades(statement: Statement): Trade[] {
  const orders = new Map<OrderId, Order>(statement.orders.map((order) => [order.id, order]))
  const deals = statement.deals.filter(isTradeDeal)

  // An entry deal's order carries the id that the statement calls the position.
  const entries = new Map(
    deals.filter((deal) => deal.entry === 'in').map((deal) => [String(deal.orderId), deal]))
  const unclaimed = new Set(deals.filter((deal) => deal.entry === 'out'))

  const byCloseTime = [...statement.positions]
    .sort((a, b) => a.closeTime.getTime() - b.closeTime.getTime())

  const trades = byCloseTime.map((position): Trade => {
    const entry = entries.get(String(position.id))
    if (!entry) throw new Error(`position ${position.id}: no opening deal`)

    const exits = claimExits(position, unclaimed)
    reconcile(position, entry, exits)

    const entryOrder = orders.get(entry.orderId)
    const level = (initial: number | null, final: number | null): Level => ({ initial, final })

    return {
      positionId: position.id,
      symbol: position.symbol,
      side: position.side,
      entry: fill(entry),
      exits: exits.map((deal): ExitFill => ({ ...fill(deal), reason: exitReason(deal.comment) })),
      stop: level(entryOrder?.stopLoss ?? null, position.stopLoss),
      target: level(entryOrder?.takeProfit ?? null, position.takeProfit),
      tag: tagOf(entryOrder),
      grossProfit: position.profit,
      commission: position.commission,
      swap: position.swap,
    }
  })

  if (unclaimed.size > 0) {
    throw new Error(`${unclaimed.size} closing deals belong to no position`)
  }
  return trades
}
