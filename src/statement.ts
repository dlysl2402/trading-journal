/**
 * Reads an MT5 "Trade History Report" into the layer 1 ledger.
 *
 * The parser's only job is transcription: find the three tables, put each cell
 * in the right field, and refuse anything it does not recognise. It computes
 * nothing.
 */

import type {
  Account, BalanceDeal, Deal, DealEntry, DealId, Order, OrderId,
  PositionId, PositionRecord, Side, Statement, TradeDeal,
} from './ledger.ts'
import { readSheet } from './xlsx.ts'

const TIMESTAMP = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * Timestamps are broker server time and the report never says which zone that
 * is. They are read as UTC so the same file parses identically on any machine;
 * `Statement.serverUtcOffsetMinutes` is where the real offset belongs once known.
 */
function toDate(text: string, row: number): Date {
  const parts = TIMESTAMP.exec(text.trim())
  if (!parts) throw new Error(`row ${row}: expected a timestamp, got "${text}"`)
  const [, year, month, day, hour, minute, second] = parts
  return new Date(Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +(second ?? 0)))
}

function toNumber(text: string, row: number): number {
  const value = Number(text.trim())
  if (text.trim() === '' || Number.isNaN(value)) {
    throw new Error(`row ${row}: expected a number, got "${text}"`)
  }
  return value
}

/** Blank cells are common and meaningful: an absent stop is not a stop of zero. */
function toOptionalNumber(text: string): number | null {
  return text.trim() === '' ? null : Number(text.trim())
}

function toText(text: string): string | null {
  return text.trim() === '' ? null : text.trim()
}

function toSide(text: string, row: number): Side {
  if (text === 'buy' || text === 'sell') return text
  throw new Error(`row ${row}: expected buy or sell, got "${text}"`)
}

/**
 * Rows of one table: everything between its title and the first row that no
 * longer starts with a timestamp, which is how each section ends.
 */
function section(rows: string[][], title: string): [row: string[], index: number][] {
  const start = rows.findIndex((row) => row[0]?.trim() === title)
  if (start === -1) throw new Error(`no "${title}" section in this report`)

  const found: [string[], number][] = []
  for (let i = start + 2; i < rows.length; i++) {
    const row = rows[i]!
    if (!TIMESTAMP.test(row[0]?.trim() ?? '')) break
    found.push([row, i + 1])
  }
  return found
}

/** Header values sit a few columns to the right of their label. */
function labelled(rows: string[][], label: string): string {
  const row = rows.find((cells) => cells[0]?.trim() === label)
  const value = row?.find((cell, index) => index > 0 && cell.trim() !== '')
  if (value === undefined) throw new Error(`no "${label}" line in this report`)
  return value.trim()
}

const ACCOUNT = /^(\d+) \(([A-Z]{3}), ([^,]+), ([^,]+), (\w+)\)$/

function parseAccount(rows: string[][]): Account {
  const summary = labelled(rows, 'Account:')
  const parts = ACCOUNT.exec(summary)
  if (!parts) throw new Error(`unrecognised account line: "${summary}"`)
  const [, id, currency, broker, , mode] = parts
  return {
    id: id!,
    name: labelled(rows, 'Name:'),
    currency: currency!,
    broker: broker!,
    marginMode: mode!.toLowerCase() === 'hedge' ? 'hedge' : 'netting',
  }
}

function parsePositions(rows: string[][]): PositionRecord[] {
  return section(rows, 'Positions').map(([cells, row]) => ({
    id: cells[1]! as PositionId,
    symbol: cells[2]!,
    side: toSide(cells[3]!, row),
    volume: toNumber(cells[4]!, row),
    openTime: toDate(cells[0]!, row),
    openPrice: toNumber(cells[5]!, row),
    stopLoss: toOptionalNumber(cells[6]!),
    takeProfit: toOptionalNumber(cells[7]!),
    closeTime: toDate(cells[8]!, row),
    closePrice: toNumber(cells[9]!, row),
    commission: toNumber(cells[10]!, row),
    swap: toNumber(cells[11]!, row),
    profit: toNumber(cells[12]!, row),
    sourceRow: row,
  }))
}

/** MT5 prints order volume as "filled / requested". */
function parseVolumes(text: string, row: number): [filled: number, requested: number] {
  const [filled, requested] = text.split('/')
  if (requested === undefined) throw new Error(`row ${row}: unrecognised volume "${text}"`)
  return [toNumber(filled!, row), toNumber(requested, row)]
}

function parseOrders(rows: string[][]): Order[] {
  return section(rows, 'Orders').map(([cells, row]) => {
    const [filled, requested] = parseVolumes(cells[4]!, row)
    return {
      id: cells[1]! as OrderId,
      symbol: cells[2]!,
      side: toSide(cells[3]!, row),
      placedAt: toDate(cells[0]!, row),
      filledAt: cells[8]!.trim() === '' ? null : toDate(cells[8]!, row),
      filledVolume: filled,
      requestedVolume: requested,
      // "market" means it was sent at whatever price was available.
      price: cells[5]!.trim() === 'market' ? null : toOptionalNumber(cells[5]!),
      stopLoss: toOptionalNumber(cells[6]!),
      takeProfit: toOptionalNumber(cells[7]!),
      state: cells[9]!.trim(),
      comment: toText(cells[11]!),
      sourceRow: row,
    }
  })
}

function parseDeals(rows: string[][]): Deal[] {
  return section(rows, 'Deals').map(([cells, row]): Deal => {
    const base = {
      id: cells[1]! as DealId,
      time: toDate(cells[0]!, row),
      balance: toNumber(cells[12]!, row),
      comment: toText(cells[13]!),
      sourceRow: row,
    }

    // Deposits and withdrawals have no symbol, side or price, and put their
    // amount in the profit column. Keeping them a separate shape is what stops
    // them being summed as trading results.
    if (cells[3]!.trim() === 'balance') {
      return { ...base, kind: 'balance', amount: toNumber(cells[11]!, row) } satisfies BalanceDeal
    }

    const entry = cells[4]!.trim()
    if (entry !== 'in' && entry !== 'out' && entry !== 'inout') {
      throw new Error(`row ${row}: unrecognised deal direction "${entry}"`)
    }

    return {
      ...base,
      kind: 'trade',
      symbol: cells[2]!,
      side: toSide(cells[3]!, row),
      entry: entry as DealEntry,
      volume: toNumber(cells[5]!, row),
      price: toNumber(cells[6]!, row),
      orderId: cells[7]! as OrderId,
      // The report never names the position a deal belongs to. See `feed.ts`
      // for the live API, which does.
      positionId: null,
      commission: toNumber(cells[8]!, row),
      fee: toNumber(cells[9]!, row),
      swap: toNumber(cells[10]!, row),
      profit: toNumber(cells[11]!, row),
    } satisfies TradeDeal
  })
}

export function parseStatement(rows: string[][]): Statement {
  return {
    account: parseAccount(rows),
    generatedAt: toDate(labelled(rows, 'Date:'), 0),
    serverUtcOffsetMinutes: null,
    // A history report states no account balance of its own; the running
    // balance on the last deal is the closest it comes.
    reportedBalance: null,
    positions: parsePositions(rows),
    orders: parseOrders(rows),
    deals: parseDeals(rows),
  }
}

export function readStatement(path: string): Statement {
  return parseStatement(readSheet(path))
}
