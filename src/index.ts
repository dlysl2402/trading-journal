import { readStatement } from './statement.ts'
import { buildTrades } from './trades.ts'

/** Print what a statement contains, as a check that it imported cleanly. */
export function summarise(path: string): string {
  const statement = readStatement(path)
  const trades = buildTrades(statement)

  const net = trades.reduce((total, t) => total + t.grossProfit + t.commission + t.swap, 0)
  const deposits = statement.deals
    .filter((deal) => deal.kind === 'balance')
    .reduce((total, deal) => total + deal.amount, 0)
  const withoutInitialStop = trades.filter((trade) => trade.stop.initial === null).length

  const { account } = statement
  return [
    `${account.id} · ${account.broker} · ${account.currency} · ${account.marginMode}`,
    `${trades.length} trades, ${trades.reduce((n, t) => n + t.exits.length, 0)} closing fills`,
    `net ${net.toFixed(2)} ${account.currency} on ${deposits.toFixed(2)} deposited`,
    `${withoutInitialStop} trades have no recorded stop at entry`,
  ].join('\n')
}

export function main(argv: string[] = []): void {
  const [path] = argv
  if (!path) {
    console.log('usage: node src/index.ts <ReportHistory.xlsx>')
    return
  }
  console.log(summarise(path))
}

if (import.meta.main) main(process.argv.slice(2))
