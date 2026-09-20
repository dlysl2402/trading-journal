/**
 * Layer 2 — the trade.
 *
 * One round trip, derived by joining deals to their orders. This layer holds
 * facts about the trade — what was done, at what price, why it ended. It holds
 * no metrics: net P&L, R-multiple, holding period and win/loss are all
 * functions of these fields, and deriving them on demand keeps them from
 * drifting out of step with the ledger.
 */

import type { DealId, PositionId, Side } from './ledger.ts'

/** A single execution. */
export interface Fill {
  dealId: DealId
  time: Date
  price: number
  volume: number
}

/**
 * A closing fill, carrying why that particular exit happened. The reason sits
 * here rather than on the trade because they genuinely differ: in the sample
 * statement one position was closed 0.26 by hand and the remaining 0.03 by its
 * take-profit, seconds apart. A single trade-level reason has to lie about one.
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
  /** From the position record: the last value before the close. */
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
  positionId: PositionId
  symbol: string
  side: Side
  entry: Fill
  exits: ExitFill[]
  stop: Level
  target: Level
  /** The entry order's comment — often the strategy or tool that placed it. */
  tag: string | null
  /**
   * Broker figures, kept apart rather than pre-summed. The statement's profit
   * is gross; net is profit + commission + swap, and one `pnl` field would
   * quietly hide the costs that make the difference.
   */
  grossProfit: number
  commission: number
  swap: number
}
