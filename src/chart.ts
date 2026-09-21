/**
 * Draws the journal as one self-contained HTML file.
 *
 * No server, no dependencies — `update.ts` writes `equity.html` and a browser
 * opens it. The one outside request is for type (Newsreader and IBM Plex
 * Mono from Google Fonts); offline, Georgia and the system monospace stand in. The page is handed the facts of every closed trade and works the
 * figures out itself: win rate, profit factor, drawdown, the calendar. Nothing
 * is stored, so nothing can drift from the broker. When layer 3 exists those
 * sums move there; the page is where they are previewed.
 */

import type { Journal, Trade } from './journal.ts'

/** One step of the curve: the running net result after a trade closed. */
export interface EquityPoint {
  time: Date
  /** Net P&L of every trade closed so far. Deposits are not included. */
  equity: number
  trade: Trade | null
}

export function netOf(trade: Trade): number {
  return trade.grossProfit + trade.commission + trade.swap
}

function closedAt(trade: Trade): number {
  return Math.max(...trade.exits.map((exit) => exit.time.getTime()))
}

/**
 * Net P&L over time, one point per closed trade, starting at zero when the
 * first trade was opened so the line begins on the baseline.
 *
 * Trading results rather than balance, on purpose: the sample account took
 * four deposits totalling 32,000 against a few hundred of P&L, so a balance
 * curve is four steps with the trading invisible on top of them.
 */
export function equityCurve(trades: Trade[]): EquityPoint[] {
  if (trades.length === 0) return []
  const byClose = [...trades].sort((a, b) => closedAt(a) - closedAt(b))

  const opened = new Date(Math.min(...trades.map((trade) => trade.entry.time.getTime())))
  const points: EquityPoint[] = [{ time: opened, equity: 0, trade: null }]

  let equity = 0
  for (const trade of byClose) {
    equity += netOf(trade)
    points.push({ time: new Date(closedAt(trade)), equity, trade })
  }
  return points
}

/** How many decimals a price was quoted to, so an average is not printed to nine. */
function decimals(price: number): number {
  return String(price).split('.')[1]?.length ?? 0
}

/** The facts of one trade the page shows, as plain JSON. */
function rowOf(trade: Trade) {
  const volume = trade.exits.reduce((total, exit) => total + exit.volume, 0)
  const digits = Math.max(decimals(trade.entry.price), ...trade.exits.map((exit) => decimals(exit.price)))
  // A position closed in pieces has one reason per piece; the one that closed
  // the most of it is the one the trade is filed under.
  const largest = trade.exits.reduce((best, exit) => exit.volume > best.volume ? exit : best)
  return {
    symbol: trade.symbol,
    side: trade.side,
    tag: trade.tag,
    opened: trade.entry.time.getTime(),
    volume: trade.entry.volume,
    entry: trade.entry.price,
    exit: Number((trade.exits.reduce((total, exit) => total + exit.price * exit.volume, 0) / volume).toFixed(digits)),
    ended: largest.reason.kind,
    /** The stop in force at the close, else the one placed at entry; null if there was never one. */
    stop: trade.stop.final ?? trade.stop.initial,
    net: netOf(trade),
    costs: trade.commission + trade.swap,
  }
}

/** Everything the page needs, as plain JSON. */
function pageData({ account, balance, deposited, serverUtcOffsetMinutes, trades }: Journal) {
  return {
    account,
    deposited,
    balance,
    serverUtcOffsetMinutes,
    points: equityCurve(trades).map((point) => ({
      time: point.time.getTime(),
      equity: point.equity,
      trade: point.trade && rowOf(point.trade),
    })),
  }
}

export function renderPage(journal: Journal): string {
  // `<` in a JSON string would end the script tag early; escape it defensively.
  const json = JSON.stringify(pageData(journal)).replaceAll('<', '\\u003c')
  // A function, so a `$` in a tag is not read as a replacement pattern.
  return TEMPLATE.replace('__DATA__', () => json)
}

const TEMPLATE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Journal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,500;1,6..72,500&display=swap">
<style>
  /* One committed dark theme: warm near-black ground, hairlines, mono for
     every figure, serif for the one number the page leads with. Sage is the only
     accent; jade and coral mean profit and loss and nothing else. */
  :root {
    color-scheme: dark;
    --void: #0b0a09;
    --void-2: #080807;
    --surface: #121110;
    --surface-2: #1a1816;
    --ink: #f3efe8;
    --body: #cfc8bd;
    --dim: #9a938a;
    --faint: #6b655d;
    --hair: rgba(235, 220, 200, 0.12);
    --hair-2: rgba(235, 220, 200, 0.26);
    --gridline: rgba(235, 220, 200, 0.045);
    --accent: #bcd18f;
    --accent-hi: #dcecb2;
    --accent-ghost: rgba(188, 209, 143, 0.13);
    --accent-ink: #13160c;
    --series: var(--accent);
    --up: #45d68e;
    --up-ghost: rgba(69, 214, 142, 0.14);
    --down: #f56e5e;
    --down-ghost: rgba(245, 110, 94, 0.14);
    --warn: #f7b345;
    --cat-stop: #5b8def;
    --cat-target: #22c1c3;
    --serif: 'Newsreader', Georgia, 'Times New Roman', serif;
    --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--void); scrollbar-color: var(--surface-2) var(--void); }
  body {
    margin: 0;
    padding: 28px 24px 72px;
    min-height: 100vh;
    background: var(--void);
    color: var(--body);
    font: 400 13px/1.5 var(--mono);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  /* A faint grid behind everything, fading out down the page. */
  body::before {
    content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
    background-image:
      linear-gradient(var(--gridline) 1px, transparent 1px),
      linear-gradient(90deg, var(--gridline) 1px, transparent 1px);
    background-size: 44px 44px;
    -webkit-mask-image: radial-gradient(ellipse 120% 90% at 50% 0%, #000 30%, transparent 78%);
    mask-image: radial-gradient(ellipse 120% 90% at 50% 0%, #000 30%, transparent 78%);
  }
  main { max-width: 1120px; margin: 0 auto; }

  header {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap;
    padding-bottom: 14px; border-bottom: 1px solid var(--hair); margin-bottom: 28px;
    font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  }
  h1 { font: inherit; font-weight: 500; color: var(--ink); margin: 0; white-space: nowrap; }
  h1::before { content: ''; display: inline-block; width: 6px; height: 6px; background: var(--accent); margin-right: 10px; vertical-align: 1px; }
  .sub { color: var(--faint); margin: 0; }

  .tiles { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1px; background: var(--hair); border: 1px solid var(--hair); margin-bottom: 16px; }
  .tile { grid-column: span 6; background: var(--void); padding: 18px 20px; min-width: 0; transition: background 0.25s; }
  .tile:hover { background: var(--surface); }
  .tile.hero { grid-column: span 12; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 26px 26px 22px; }
  @media (min-width: 720px) { .tile { grid-column: span 4; } }
  @media (min-width: 1000px) { .tile { grid-column: span 2; } }
  .label { font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); }
  .value { font-size: 22px; font-weight: 500; color: var(--ink); margin-top: 10px; line-height: 1.1; letter-spacing: -0.01em; }
  .hero .value { font-family: var(--serif); font-size: 72px; letter-spacing: -0.02em; line-height: 1; margin-top: 14px; font-variant-numeric: proportional-nums; }
  .note { color: var(--dim); font-size: 11px; margin-top: 8px; line-height: 1.5; }
  .up { color: var(--up); }
  .down { color: var(--down); }
  .warn { color: var(--warn); }
  .delta { font-family: var(--serif); font-style: italic; font-weight: 500; font-size: 30px; line-height: 1.1; letter-spacing: -0.01em; margin-top: 8px; color: var(--accent); font-variant-numeric: proportional-nums; }
  .delta.down { color: var(--down); }
  .delta.flat { color: var(--dim); }
  .readout { display: grid; grid-template-columns: auto auto; gap: 7px 20px; margin: 0; font-size: 11.5px; }
  .readout dt { font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); align-self: baseline; }
  .readout dd { margin: 0; color: var(--body); text-align: right; }

  .card { background: var(--void); border: 1px solid var(--hair); padding: 20px 22px 18px; position: relative; }
  h2 { font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); font-weight: 400; margin: 0 0 16px; }
  h2::before { content: ''; display: inline-block; width: 5px; height: 5px; background: var(--accent); margin-right: 9px; vertical-align: 1px; }
  .card.chart { padding: 20px 18px 14px; overflow: hidden; }
  .card.chart h2 { margin-left: 6px; }
  svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; }
  .grid line { stroke: var(--hair); stroke-width: 1; }
  .baseline { stroke: var(--hair-2); stroke-width: 1; }
  .tick { fill: var(--faint); font-size: 10px; font-family: var(--mono); letter-spacing: 0.04em; }
  .line { fill: none; stroke: var(--accent); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }
  .end { fill: var(--accent); stroke: var(--void); stroke-width: 2; }
  .halo { fill: var(--accent); opacity: 0.18; }
  .end-label { fill: var(--ink); font-size: 11.5px; font-family: var(--mono); font-weight: 500; }
  .crosshair { stroke: var(--hair-2); stroke-width: 1; stroke-dasharray: 3 3; display: none; }
  .focus { fill: var(--accent); stroke: var(--void); stroke-width: 2; display: none; }
  @media (prefers-reduced-motion: no-preference) {
    .line.draw { stroke-dasharray: var(--length); stroke-dashoffset: var(--length); animation: draw 1.1s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
    .area.draw { opacity: 0; animation: fade 0.6s 0.7s ease-out forwards; }
    .end.draw, .halo.draw, .end-label.draw { opacity: 0; animation: fade 0.4s 1.0s ease-out forwards; }
  }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes fade { to { opacity: 1; } }
  .halo.draw { animation-name: fadeHalo; }
  @keyframes fadeHalo { to { opacity: 0.18; } }
  .empty { color: var(--faint); font-size: 11px; padding: 20px 0; }

  .tooltip {
    position: absolute; pointer-events: none; display: none; z-index: 2;
    background: var(--surface); border: 1px solid var(--hair-2);
    padding: 10px 12px; box-shadow: 0 16px 40px -14px rgba(0, 0, 0, 0.8); white-space: nowrap;
  }
  .tooltip b { display: block; font-size: 15px; font-weight: 500; color: var(--ink); }
  .tooltip span { color: var(--dim); font-size: 11px; }
  .tooltip .net { font-weight: 500; }

  .split { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 16px; align-items: start; }
  @media (min-width: 900px) { .split { grid-template-columns: 3fr 2fr; } }
  .habits { grid-template-columns: 1fr 1fr; margin: 0; }
  .habits .tile { grid-column: auto; }
  .habits .tile.wide { grid-column: span 2; }
  @media (max-width: 640px) { .habits { grid-template-columns: 1fr; } .habits .tile.wide { grid-column: auto; } }
  .pair { display: flex; gap: 28px; }
  .pair > div { min-width: 0; }
  .pair .note { margin-top: 4px; }

  .month { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin: 0 0 12px; }
  .month + .cal { margin-bottom: 22px; }
  .month h3 { font-family: var(--serif); font-weight: 500; font-size: 24px; color: var(--ink); margin: 0; letter-spacing: -0.01em; }
  .month span { color: var(--dim); font-size: 11px; }
  .cal { display: grid; grid-template-columns: repeat(7, 1fr) 1.2fr; gap: 1px; background: var(--hair); border: 1px solid var(--hair); }
  .cal-head { background: var(--void); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); text-align: center; padding: 8px 0; }
  .cal-cell { min-height: 64px; padding: 7px 9px; display: flex; flex-direction: column; justify-content: space-between; background: var(--void); font-size: 11.5px; line-height: 1.3; min-width: 0; }
  .cal-cell.blank { background: var(--void-2); }
  .cal-cell.up { background: var(--up-ghost); }
  .cal-cell.down { background: var(--down-ghost); }
  .cal-cell.week { background: var(--surface); }
  .cal-d { color: var(--faint); font-size: 10px; }
  .cal-n { font-weight: 500; color: var(--ink); white-space: nowrap; }
  .up .cal-n { color: var(--up); }
  .down .cal-n { color: var(--down); }
  .cal-c { color: var(--dim); font-size: 10px; white-space: nowrap; }
  @media (max-width: 640px) {
    .cal-c { display: none; }
    .cal-cell { min-height: 48px; padding: 5px 5px; }
    .cal-n { font-size: 10.5px; }
  }

  .bar { display: flex; gap: 2px; height: 8px; margin: 14px 0; }
  .seg { min-width: 3px; }
  .seg.manual { background: var(--accent); }
  .seg.stop { background: var(--cat-stop); }
  .seg.target { background: var(--cat-target); }
  .legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; font-size: 11px; color: var(--dim); }
  .legend li { display: flex; align-items: center; gap: 9px; }
  .legend i { width: 8px; height: 8px; flex: none; }
  .legend b { color: var(--ink); font-weight: 500; }
  .legend .net { margin-left: auto; font-weight: 500; }

  .table-card { margin-top: 16px; padding: 20px 0 0; }
  .table-card h2 { margin-left: 22px; }
  .scroll { overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 9px 14px; border-top: 1px solid var(--hair); white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 22px; }
  th:last-child, td:last-child { padding-right: 22px; }
  th { font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); font-weight: 400; background: var(--surface); }
  td { color: var(--body); }
  tbody tr:hover td { background: var(--surface); }
  td.num, th.num { text-align: right; }
  td.up { color: var(--up); font-weight: 500; }
  td.down { color: var(--down); font-weight: 500; }
  td.none { color: var(--warn); }
  .side { display: inline-block; padding: 3px 7px; font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase; border: 1px solid var(--hair-2); color: var(--dim); }
  .tag { display: inline-block; margin-left: 8px; padding: 2px 6px; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; background: var(--accent-ghost); color: var(--accent-hi); vertical-align: 1px; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Journal</h1>
      <p class="sub" id="sub"></p>
    </div>
  </header>
  <section class="tiles" id="tiles"></section>
  <section class="card chart">
    <h2>Net P&amp;L, cumulative by trade</h2>
    <svg id="chart" viewBox="0 0 880 320" role="img" aria-label="Net profit and loss over time"></svg>
    <div class="tooltip" id="tooltip"></div>
  </section>
  <section class="split">
    <div class="card">
      <h2>By day</h2>
      <div id="calendar"></div>
    </div>
    <div class="tiles habits" id="habits"></div>
  </section>
  <section class="card table-card">
    <h2>Every trade, newest first</h2>
    <div class="scroll"><table id="table"></table></div>
  </section>
</main>
<script>
const data = __DATA__

// Formatting.
const currency = data.account.currency
const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency })
const whole = new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: 0 })
const price = new Intl.NumberFormat('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 5 })
const signed = (n, format = money) => (n > 0 ? '+' : '') + format.format(n)
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat')
const fixed = (n) => (n === null ? '—' : n.toFixed(2))
const plural = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many)
const day = (ms) => new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const when = (ms) => new Date(ms).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const duration = (ms) => {
  const m = ms / 60000
  return m < 60 ? Math.round(m) + ' min' : m < 1440 ? (m / 60).toFixed(1) + ' h' : (m / 1440).toFixed(1) + ' d'
}
const utc = (m) => m === null ? '' : 'UTC' + (m < 0 ? '−' : '+') + Math.floor(Math.abs(m) / 60) +
  (Math.abs(m) % 60 ? ':' + String(Math.abs(m) % 60).padStart(2, '0') : '')

const h = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// The figures, all worked out from the trades on the page.
const points = data.points
const first = points[0], last = points[points.length - 1]
const trades = points.filter((p) => p.trade)
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0)
const netOf = (p) => p.trade.net
const ratio = (a, b) => (b === 0 ? null : a / b)
const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const winners = trades.filter((p) => p.trade.net > 0)
const losers = trades.filter((p) => p.trade.net < 0)
const net = sum(trades, netOf)
const costs = sum(trades, (p) => p.trade.costs)
const won = sum(winners, netOf), lost = -sum(losers, netOf)
const winRate = ratio(winners.length, trades.length)
const profitFactor = ratio(won, lost)
const avgWin = ratio(won, winners.length), avgLoss = ratio(lost, losers.length)
const payoff = avgWin !== null && avgLoss !== null ? ratio(avgWin, avgLoss) : null
const expectancy = ratio(net, trades.length)

const days = [...Map.groupBy(trades, (p) => dateOf(p.time))]
  .map(([date, list]) => ({ date, net: sum(list, netOf), count: list.length }))
  .sort((a, b) => a.date.localeCompare(b.date))
const greenDays = days.filter((d) => d.net > 0).length

// Deepest fall from a high on the curve, which starts at zero.
let peak = 0, peakAt = first ? first.time : 0
let drawdown = { amount: 0, from: peakAt, to: peakAt }
for (const p of points) {
  if (p.equity > peak) { peak = p.equity; peakAt = p.time }
  if (peak - p.equity > drawdown.amount) drawdown = { amount: peak - p.equity, from: peakAt, to: p.time }
}

let streak = null, longestWin = 0, longestLoss = 0
for (const p of trades) {
  const kind = p.trade.net > 0 ? 'win' : p.trade.net < 0 ? 'loss' : null
  if (kind === null) { streak = null; continue }
  streak = streak && streak.kind === kind ? { kind, length: streak.length + 1 } : { kind, length: 1 }
  if (kind === 'win') longestWin = Math.max(longestWin, streak.length)
  else longestLoss = Math.max(longestLoss, streak.length)
}

const hold = (p) => p.time - p.trade.opened

// Header.
document.getElementById('sub').textContent = [
  data.account.id, data.account.broker, currency,
  trades.length ? day(first.time) + ' – ' + day(last.time) + ' · server time ' + utc(data.serverUtcOffsetMinutes) : 'no closed trades yet',
].join(' · ')

// Hero: net P&L, with what gives it scale.
const tiles = document.getElementById('tiles')
const hero = h('div', 'tile hero')
const heroText = h('div')
heroText.append(h('div', 'label', 'Net P&L'), h('div', 'value', signed(net)))
if (data.deposited > 0) {
  const pct = 100 * net / data.deposited
  heroText.append(h('div', 'delta ' + tone(net), (pct > 0 ? '+' : '') + pct.toFixed(2) + '% on ' + whole.format(data.deposited) + ' deposited'))
}
hero.append(heroText)
const readout = h('dl', 'readout')
for (const [key, text] of [
  ['Trades', trades.length + ' over ' + plural(days.length, 'day')],
  ['Gross', signed(net - costs)],
  ['Costs', signed(costs)],
  ['Balance', money.format(data.balance)],
]) readout.append(h('dt', '', key), h('dd', '', text))
hero.append(readout)
tiles.append(hero)

// Six figures, each with the plain-words version underneath.
const tile = (label, value, valueTone, note) => {
  const node = h('div', 'tile')
  node.append(h('div', 'label', label), h('div', 'value ' + valueTone, value), h('div', 'note', note))
  return node
}
for (const [label, value, valueTone, note] of [
  ['Win rate',
    winRate === null ? '—' : Math.round(100 * winRate) + '%', 'flat',
    plural(winners.length, 'win') + ' of ' + plural(trades.length, 'trade') + ' · ' + greenDays + ' of ' + plural(days.length, 'day') + ' green'],
  ['Profit factor',
    fixed(profitFactor), profitFactor === null ? 'flat' : tone(profitFactor - 1),
    profitFactor === null ? 'needs a win and a loss' : whole.format(won) + ' won for ' + whole.format(lost) + ' lost'],
  ['Avg win / loss',
    fixed(payoff), payoff === null ? 'flat' : tone(payoff - 1),
    payoff === null ? 'needs a win and a loss' : signed(avgWin) + ' against ' + signed(-avgLoss)],
  ['Expectancy',
    expectancy === null ? '—' : signed(expectancy), expectancy === null ? 'flat' : tone(expectancy),
    'per trade, after costs'],
  ['Max drawdown',
    drawdown.amount ? '−' + money.format(drawdown.amount) : money.format(0), drawdown.amount ? 'down' : 'flat',
    drawdown.amount
      ? (data.deposited > 0 ? (100 * drawdown.amount / data.deposited).toFixed(2) + '% of deposits · ' : '') + day(drawdown.from) + ' – ' + day(drawdown.to)
      : 'no high given back yet'],
  ['Streak',
    streak ? plural(streak.length, streak.kind, streak.kind === 'win' ? 'wins' : 'losses') : '—',
    streak ? (streak.kind === 'win' ? 'up' : 'down') : 'flat',
    'longest run: ' + plural(longestWin, 'win') + ', ' + plural(longestLoss, 'loss', 'losses')],
]) tiles.append(tile(label, value, valueTone, note))

// The chart: cumulative net P&L against time, one point per closed trade.
const W = 880, H = 320, M = { top: 16, right: 96, bottom: 32, left: 64 }
const svg = document.getElementById('chart')
const NS = 'http://www.w3.org/2000/svg'
const el = (name, attrs = {}, parent = svg) => {
  const node = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  parent.append(node)
  return node
}

if (points.length > 1) {
  const t0 = first.time, t1 = last.time
  const lo = Math.min(0, ...points.map((p) => p.equity))
  const hi = Math.max(0, ...points.map((p) => p.equity))
  const step = niceStep((hi - lo) / 4)
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step
  const x = (t) => M.left + (t - t0) / (t1 - t0) * (W - M.left - M.right)
  const y = (v) => H - M.bottom - (v - yMin) / (yMax - yMin) * (H - M.top - M.bottom)

  // A wash under the line that fades to nothing at the baseline, in either direction.
  const defs = el('defs')
  const gradient = el('linearGradient', { id: 'wash', x1: 0, x2: 0, y1: y(yMax), y2: y(yMin), gradientUnits: 'userSpaceOnUse' }, defs)
  const at = (y(0) - y(yMax)) / (y(yMin) - y(yMax))
  el('stop', { offset: 0, 'stop-color': 'var(--series)', 'stop-opacity': 0.22 }, gradient)
  el('stop', { offset: at, 'stop-color': 'var(--series)', 'stop-opacity': 0.02 }, gradient)
  el('stop', { offset: 1, 'stop-color': 'var(--series)', 'stop-opacity': 0.14 }, gradient)

  const grid = el('g', { class: 'grid' })
  for (let v = yMin; v <= yMax + step / 2; v += step) {
    if (v !== 0) el('line', { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }, grid)
    el('text', { class: 'tick', x: M.left - 10, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = whole.format(v)
  }
  el('line', { class: 'baseline', x1: M.left, x2: W - M.right, y1: y(0), y2: y(0) })

  const dayCount = Math.max(1, Math.round((t1 - t0) / 86400000))
  const every = Math.ceil(dayCount / 6)
  for (let d = 0; d <= dayCount; d += every) {
    const t = t0 + d * 86400000
    el('text', { class: 'tick', x: x(t), y: H - M.bottom + 20, 'text-anchor': 'middle' }).textContent = day(t)
  }

  const path = points.map((p, i) => (i ? 'L' : 'M') + x(p.time).toFixed(1) + ' ' + y(p.equity).toFixed(1)).join(' ')
  el('path', { class: 'area draw', fill: 'url(#wash)', d: path + ' L' + x(t1).toFixed(1) + ' ' + y(0).toFixed(1) + ' L' + x(t0).toFixed(1) + ' ' + y(0).toFixed(1) + ' Z' })
  const line = el('path', { class: 'line draw', d: path })
  line.style.setProperty('--length', line.getTotalLength())
  el('circle', { class: 'halo draw', cx: x(t1), cy: y(last.equity), r: 9 })
  el('circle', { class: 'end draw', cx: x(t1), cy: y(last.equity), r: 4.5 })
  el('text', { class: 'end-label draw', x: x(t1) + 14, y: y(last.equity) + 4 }).textContent = signed(last.equity)

  // Hover: a crosshair that snaps to the nearest closed trade.
  const crosshair = el('line', { class: 'crosshair', y1: M.top, y2: H - M.bottom })
  const focus = el('circle', { class: 'focus', r: 4.5 })
  const tooltip = document.getElementById('tooltip')
  const card = svg.parentElement

  const show = (p) => {
    crosshair.setAttribute('x1', x(p.time)); crosshair.setAttribute('x2', x(p.time))
    focus.setAttribute('cx', x(p.time)); focus.setAttribute('cy', y(p.equity))
    crosshair.style.display = focus.style.display = 'block'

    tooltip.replaceChildren(h('b', '', signed(p.equity)))
    if (p.trade) {
      const detail = h('span', '', when(p.time) + ' · ' + p.trade.symbol + ' ' + p.trade.side + ' ')
      detail.append(h('span', 'net ' + tone(p.trade.net), signed(p.trade.net)))
      tooltip.append(detail)
    } else {
      tooltip.append(h('span', '', when(p.time) + ' · first trade opened'))
    }
    tooltip.style.display = 'block'

    // SVG elements have no offsetLeft/offsetTop, so place it from bounding rects.
    const rect = svg.getBoundingClientRect(), cardRect = card.getBoundingClientRect()
    const scale = rect.width / W
    const px = rect.left - cardRect.left + x(p.time) * scale
    const py = rect.top - cardRect.top + y(p.equity) * scale
    const flip = px > cardRect.width * 0.7
    tooltip.style.left = flip ? 'auto' : (px + 14) + 'px'
    tooltip.style.right = flip ? (cardRect.width - px + 14) + 'px' : 'auto'
    tooltip.style.top = (py - 12) + 'px'
  }
  const hide = () => {
    crosshair.style.display = focus.style.display = tooltip.style.display = 'none'
  }

  svg.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect()
    const t = t0 + ((event.clientX - rect.left) / rect.width * W - M.left) / (W - M.left - M.right) * (t1 - t0)
    let nearest = points[0]
    for (const p of points) if (Math.abs(p.time - t) < Math.abs(nearest.time - t)) nearest = p
    show(nearest)
  })
  svg.addEventListener('pointerleave', hide)
} else {
  svg.replaceWith(h('div', 'empty', 'The curve starts with the first closed trade.'))
}

function niceStep(rough) {
  if (rough <= 0) return 1
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const unit = rough / power
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power
}

// The calendar: one grid per month, Monday first, each week totalled on the right.
const calendar = document.getElementById('calendar')
if (days.length === 0) {
  calendar.append(h('div', 'empty', 'Days fill in as trades close.'))
} else {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const dayCell = (d) => {
    const cell = h('div', 'cal-cell ' + (d ? tone(d.net) : 'idle'))
    if (d) {
      cell.append(h('span', 'cal-n', signed(d.net, whole)), h('span', 'cal-c', plural(d.count, 'trade')))
    }
    return cell
  }
  const weekCell = (week) => {
    const cell = h('div', 'cal-cell week ' + (week.count ? tone(week.net) : 'idle'))
    if (week.count) cell.append(h('span', 'cal-n', signed(week.net, whole)), h('span', 'cal-c', plural(week.count, 'trade')))
    return cell
  }

  const start = new Date(days[0].date), end = new Date(days[days.length - 1].date)
  for (let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
       cursor <= end;
       cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth()
    const inMonth = days.filter((d) => d.date.startsWith(cursor.toISOString().slice(0, 7)))

    const heading = h('div', 'month')
    heading.append(h('h3', '', cursor.toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })))
    heading.append(h('span', '', signed(sum(inMonth, (d) => d.net)) + ' · ' + plural(sum(inMonth, (d) => d.count), 'trade') + ' · ' +
      inMonth.filter((d) => d.net > 0).length + ' of ' + plural(inMonth.length, 'day') + ' green'))
    calendar.append(heading)

    const grid = h('div', 'cal')
    for (const name of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Week']) grid.append(h('div', 'cal-head', name))

    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    let column = (cursor.getUTCDay() + 6) % 7
    let week = { net: 0, count: 0 }
    for (let i = 0; i < column; i++) grid.append(h('div', 'cal-cell blank'))
    for (let date = 1; date <= daysInMonth; date++) {
      const d = byDate.get(dateOf(Date.UTC(year, month, date)))
      const cell = dayCell(d)
      cell.prepend(h('span', 'cal-d', String(date)))
      grid.append(cell)
      if (d) { week.net += d.net; week.count += d.count }
      if (++column === 7) { grid.append(weekCell(week)); week = { net: 0, count: 0 }; column = 0 }
    }
    if (column > 0) {
      for (; column < 7; column++) grid.append(h('div', 'cal-cell blank'))
      grid.append(weekCell(week))
    }
    calendar.append(grid)
  }
}

// Habits: what the broker's own fields say about how the trades were run.
const habits = document.getElementById('habits')
const bucket = (list) => ({ count: list.length, net: sum(list, netOf), wins: list.filter((p) => p.trade.net > 0).length })
const pair = (label, a, b) => {
  const node = h('div', 'tile')
  node.append(h('div', 'label', label))
  const row = h('div', 'pair')
  for (const [value, valueTone, note] of [a, b]) {
    const cell = h('div')
    cell.append(h('div', 'value ' + valueTone, value), h('div', 'note', note))
    row.append(cell)
  }
  node.append(row)
  return node
}

const ended = { manual: 'By hand', stop: 'Stop', target: 'Target' }
const exits = h('div', 'tile wide')
exits.append(h('div', 'label', 'How trades ended'))
const bar = h('div', 'bar'), legend = h('ul', 'legend')
for (const kind of ['manual', 'stop', 'target']) {
  const b = bucket(trades.filter((p) => p.trade.ended === kind))
  if (b.count === 0) continue
  const seg = h('span', 'seg ' + kind)
  seg.style.flex = String(b.count)
  bar.append(seg)
  const item = h('li')
  item.append(h('i', 'seg ' + kind), h('b', '', ended[kind]), h('span', '', plural(b.count, 'trade') + ', ' + plural(b.wins, 'win')))
  item.append(h('span', 'net ' + tone(b.net), signed(b.net)))
  legend.append(item)
}
exits.append(bar, legend)
if (trades.length === 0) exits.append(h('div', 'note', 'Fills in as trades close.'))
habits.append(exits)

const naked = bucket(trades.filter((p) => p.trade.stop === null))
const covered = bucket(trades.filter((p) => p.trade.stop !== null))
habits.append(pair('Stop in place',
  [String(covered.count), 'flat', 'with a stop · ' + signed(covered.net)],
  [String(naked.count), naked.count ? 'warn' : 'flat', 'without · ' + signed(naked.net)]))

habits.append(pair('Hold time, median',
  [winners.length ? duration(median(winners.map(hold))) : '—', 'flat', 'winners'],
  [losers.length ? duration(median(losers.map(hold))) : '—', 'flat', 'losers']))

const longs = bucket(trades.filter((p) => p.trade.side === 'buy'))
const shorts = bucket(trades.filter((p) => p.trade.side === 'sell'))
const sides = pair('Long / short',
  [signed(longs.net, whole), tone(longs.net), plural(longs.count, 'long') + ', ' + plural(longs.wins, 'win')],
  [signed(shorts.net, whole), tone(shorts.net), plural(shorts.count, 'short') + ', ' + plural(shorts.wins, 'win')])
sides.classList.add('wide')
habits.append(sides)

// The table: every fact the page used, with no hovering required.
const table = document.getElementById('table')
const head = table.createTHead().insertRow()
for (const [text, num] of [['Closed', 0], ['Symbol', 0], ['Side', 0], ['Lots', 1], ['Entry', 1], ['Exit', 1], ['Held', 1], ['Ended', 0], ['Stop', 1], ['Net', 1]]) {
  head.append(h('th', num ? 'num' : '', text))
}
const body = table.createTBody()
for (const p of [...trades].reverse()) {
  const t = p.trade
  const row = body.insertRow()
  row.insertCell().textContent = when(p.time)
  const symbol = row.insertCell()
  symbol.textContent = t.symbol
  if (t.tag) symbol.append(h('span', 'tag', t.tag))
  row.insertCell().append(h('span', 'side', t.side))
  row.append(h('td', 'num', String(t.volume)))
  row.append(h('td', 'num', price.format(t.entry)))
  row.append(h('td', 'num', price.format(t.exit)))
  row.append(h('td', 'num', duration(hold(p))))
  row.insertCell().textContent = ended[t.ended]
  row.append(t.stop === null ? h('td', 'num none', 'none') : h('td', 'num', price.format(t.stop)))
  row.append(h('td', 'num ' + tone(t.net), signed(t.net)))
}
if (trades.length === 0) {
  body.insertRow().insertCell().textContent = 'No closed trades yet.'
}
</script>
</body>
</html>
`
