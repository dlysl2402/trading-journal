/**
 * Layer 1 — the ledger.
 *
 * A verbatim mirror of the broker statement. Nothing here is computed,
 * corrected or interpreted: if the import needs a fudge, the fudge belongs
 * in the parser or in layer 2, never in these types. That way a re-import
 * always reproduces the same ledger, and any disagreement with the broker
 * is a parser bug rather than a modelling one.
 */

declare const brand: unique symbol
type Brand<T, B> = T & { readonly [brand]: B }

/** MT5 hands out three different 9-digit ids. They are not interchangeable. */
export type DealId = Brand<string, 'DealId'>
export type OrderId = Brand<string, 'OrderId'>
export type PositionId = Brand<string, 'PositionId'>

export type Side = 'buy' | 'sell'

/** Whether a deal opened exposure, closed it, or reversed through flat. */
export type DealEntry = 'in' | 'out' | 'inout'

interface DealBase {
  id: DealId
  time: Date
  /**
   * Running account balance after this deal, straight from the statement.
   * `null` from sources that do not report one: the live API sends a deal's
   * own figures but never the balance they rolled up into.
   */
  balance: number | null
  comment: string | null
  /** Row in the source sheet — `null` when the source was not a sheet. */
  sourceRow: number | null
}

/** A fill: exposure changed hands. */
export interface TradeDeal extends DealBase {
  kind: 'trade'
  symbol: string
  side: Side
  entry: DealEntry
  volume: number
  price: number
  orderId: OrderId
  /**
   * The round trip this fill belongs to, when the source says so. A statement
   * never does — that is the gap layer 2 exists to close — but the live API
   * states it outright, and a stated link beats a reconstructed one.
   */
  positionId: PositionId | null
  commission: number
  /** `null` where the source does not break fees out from commission. */
  fee: number | null
  swap: number
  /** Gross, and zero on entry deals — MT5 books the whole result on the exit. */
  profit: number
}

/** A deposit, withdrawal, credit or correction. No symbol, no side, no price. */
export interface BalanceDeal extends DealBase {
  kind: 'balance'
  /** Signed cash movement. MT5 files this under the Profit column. */
  amount: number
}

export type Deal = TradeDeal | BalanceDeal

/**
 * The order that produced a deal. Kept raw alongside deals because it is the
 * only place the *initial* stop and target survive — the position table holds
 * whatever the levels were changed to before the close.
 *
 * Note what is absent: neither this table nor the deals table names a position.
 * Nothing in the report links an order to the round trip it belongs to, so
 * layer 2 has to reconstruct that link and check its work.
 */
export interface Order {
  id: OrderId
  symbol: string
  side: Side
  placedAt: Date
  filledAt: Date | null
  requestedVolume: number
  filledVolume: number
  /** `null` for a market order; a number for a pending, stop or limit order. */
  price: number | null
  stopLoss: number | null
  takeProfit: number | null
  state: string
  comment: string | null
  sourceRow: number | null
}

export interface Account {
  id: string
  name: string
  currency: string
  broker: string
  /** Hedging allows opposed positions in one symbol; netting does not. */
  marginMode: 'hedge' | 'netting'
}

export interface Statement {
  account: Account
  generatedAt: Date
  /**
   * Every timestamp above is broker server time. Until this is known, any
   * session or hour-of-day grouping is a guess — so it is explicitly nullable
   * rather than quietly defaulted to UTC.
   */
  serverUtcOffsetMinutes: number | null
  /**
   * The balance the broker reports right now, when the source states one.
   * Every deal ever booked has to add up to it, which is the only check the
   * live feed has that it fetched the whole history.
   */
  reportedBalance: number | null
  deals: Deal[]
  orders: Order[]
  positions: PositionRecord[]
}

/**
 * A closed round trip exactly as the statement reports it.
 *
 * Kept raw alongside deals and orders because MT5 has already done the
 * entry/exit pairing, and its pairing is authoritative. Layer 2 uses this as
 * the spine and checks its own joins against these totals.
 */
export interface PositionRecord {
  id: PositionId
  symbol: string
  side: Side
  volume: number
  openTime: Date
  openPrice: number
  /** Last value before the close, not necessarily the one set at entry. */
  stopLoss: number | null
  takeProfit: number | null
  closeTime: Date
  /** Volume-weighted when the position was closed in more than one piece. */
  closePrice: number
  commission: number
  swap: number
  /** Gross: net is profit + commission + swap. */
  profit: number
  sourceRow: number | null
}
