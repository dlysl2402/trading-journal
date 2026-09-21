/**
 * Temporary: draws the account's growth as one self-contained HTML file.
 *
 * Reads a statement, writes `equity.html` beside this project, done. No
 * server, no dependencies, nothing to install — open the file in a browser.
 * The running total here is a preview of layer 3 and will move there; the
 * page itself is a placeholder until there is a real UI.
 */

import { writeFileSync } from 'node:fs'
import { readStatement } from './statement.ts'
import type { Statement } from './ledger.ts'
import type { Trade } from './trade.ts'
import { buildTrades } from './trades.ts'

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

/** Everything the page needs, as plain JSON. */
function pageData(statement: Statement, trades: Trade[]) {
  const deposits = statement.deals
    .filter((deal) => deal.kind === 'balance')
    .reduce((total, deal) => total + deal.amount, 0)
  const latest = [...statement.deals].sort((a, b) => b.time.getTime() - a.time.getTime())[0]

  return {
    account: statement.account,
    deposited: deposits,
    balance: latest?.balance ?? 0,
    wins: trades.filter((trade) => netOf(trade) > 0).length,
    points: equityCurve(trades).map((point) => ({
      time: point.time.getTime(),
      equity: point.equity,
      trade: point.trade && {
        symbol: point.trade.symbol,
        side: point.trade.side,
        net: netOf(point.trade),
      },
    })),
  }
}

export function renderPage(statement: Statement, trades: Trade[]): string {
  // `<` in a JSON string would end the script tag early; escape it defensively.
  const json = JSON.stringify(pageData(statement, trades)).replaceAll('<', '\\u003c')
  return TEMPLATE.replace('__DATA__', json)
}

const TEMPLATE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Account growth</title>
<style>
  :root {
    color-scheme: light;
    --page: #f4f5f7;
    --surface: #ffffff;
    --surface-2: #f7f8fa;
    --ink: #0f1115;
    --ink-2: #5b606b;
    --muted: #8b909b;
    --grid: #eceef2;
    --axis: #d3d6dc;
    --border: rgba(15, 17, 21, 0.07);
    --shadow: 0 1px 2px rgba(15, 17, 21, 0.04), 0 12px 32px -16px rgba(15, 17, 21, 0.18);
    --series: #2a78d6;
    --series-soft: rgba(42, 120, 214, 0.10);
    --up: #0c8a3f;
    --up-soft: rgba(12, 138, 63, 0.10);
    --down: #d13b3b;
    --down-soft: rgba(209, 59, 59, 0.10);
    --glass: rgba(255, 255, 255, 0.82);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --page: #0b0c0f;
      --surface: #15171b;
      --surface-2: #1b1e23;
      --ink: #f3f4f6;
      --ink-2: #a7acb6;
      --muted: #737882;
      --grid: #23262c;
      --axis: #34383f;
      --border: rgba(255, 255, 255, 0.07);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 16px 40px -20px rgba(0, 0, 0, 0.6);
      --series: #4f95ec;
      --series-soft: rgba(79, 149, 236, 0.14);
      --up: #3ccf6d;
      --up-soft: rgba(60, 207, 109, 0.12);
      --down: #f06565;
      --down-soft: rgba(240, 101, 101, 0.12);
      --glass: rgba(21, 23, 27, 0.82);
    }
  }
  * { box-sizing: border-box; }
  html { background: var(--page); }
  body {
    margin: 0;
    padding: 40px 20px 64px;
    background:
      radial-gradient(900px 420px at 15% -10%, var(--series-soft), transparent 70%),
      var(--page);
    color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 980px; margin: 0 auto; }

  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin: 0; }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--border); vertical-align: middle; margin-left: 10px; }
  .sub { color: var(--ink-2); margin: 0; font-size: 13px; }

  .tiles { display: grid; grid-template-columns: repeat(12, 1fr); gap: 14px; margin-bottom: 14px; }
  .tile { grid-column: span 4; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 18px 20px; box-shadow: var(--shadow); min-width: 0; }
  .tile.hero { grid-column: span 12; display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  @media (min-width: 720px) {
    .tile.hero { grid-column: span 6; }
    .tile { grid-column: span 2; }
  }
  .tile .label { color: var(--ink-2); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; }
  .tile .value { font-size: 22px; font-weight: 650; letter-spacing: -0.02em; margin-top: 6px; line-height: 1.1; }
  .tile.hero .value { font-size: 44px; }
  .tile .note { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .delta { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .delta.up { background: var(--up-soft); color: var(--up); }
  .delta.down { background: var(--down-soft); color: var(--down); }
  .delta.flat { background: var(--surface-2); color: var(--ink-2); }
  .value.up { color: var(--up); }
  .value.down { color: var(--down); }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px 16px 12px; position: relative; box-shadow: var(--shadow); overflow: hidden; }
  .card h2 { font-size: 13px; font-weight: 600; margin: 0 0 12px 8px; color: var(--ink-2); }
  svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; }
  .grid line { stroke: var(--grid); stroke-width: 1; }
  .baseline { stroke: var(--axis); stroke-width: 1; }
  .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .line { fill: none; stroke: var(--series); stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; }
  .end { fill: var(--series); stroke: var(--surface); stroke-width: 2.5; }
  .halo { fill: var(--series); opacity: 0.18; }
  .end-label { fill: var(--ink); font-size: 12px; font-weight: 650; }
  .crosshair { stroke: var(--axis); stroke-width: 1; display: none; }
  .focus { fill: var(--series); stroke: var(--surface); stroke-width: 2.5; display: none; }
  @media (prefers-reduced-motion: no-preference) {
    .line.draw { stroke-dasharray: var(--length); stroke-dashoffset: var(--length); animation: draw 1.1s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
    .area.draw { opacity: 0; animation: fade 0.6s 0.7s ease-out forwards; }
    .end.draw, .halo.draw, .end-label.draw { opacity: 0; animation: fade 0.4s 1.0s ease-out forwards; }
  }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes fade { to { opacity: 1; } }
  .halo.draw { animation-name: fadeHalo; }
  @keyframes fadeHalo { to { opacity: 0.18; } }

  .tooltip {
    position: absolute; pointer-events: none; display: none; z-index: 2;
    background: var(--glass); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--border); border-radius: 12px;
    padding: 10px 12px; box-shadow: var(--shadow); white-space: nowrap;
  }
  .tooltip b { display: block; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
  .tooltip span { color: var(--ink-2); font-size: 12px; }
  .tooltip .net { font-weight: 600; }
  .tooltip .net.up { color: var(--up); }
  .tooltip .net.down { color: var(--down); }

  details { margin-top: 14px; }
  summary { cursor: pointer; color: var(--ink-2); font-size: 13px; font-weight: 500; list-style: none; display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: ''; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 0.15s; }
  details[open] summary::before { transform: rotate(45deg); }
  .table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow); overflow: auto; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  th { color: var(--ink-2); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; background: var(--surface-2); }
  td.num, th.num { text-align: right; }
  td.up { color: var(--up); font-weight: 600; }
  td.down { color: var(--down); font-weight: 600; }
  .side { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--surface-2); border: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.04em; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Account growth<span class="pill">preview</span></h1>
    <p class="sub" id="sub"></p>
  </header>
  <div class="tiles" id="tiles"></div>
  <div class="card">
    <h2>Net P&amp;L, cumulative by trade</h2>
    <svg id="chart" viewBox="0 0 880 320" role="img" aria-label="Net profit and loss over time"></svg>
    <div class="tooltip" id="tooltip"></div>
  </div>
  <details>
    <summary>Every trade, as a table</summary>
    <div class="table-card"><table id="table"></table></div>
  </details>
</main>
<script>
const data = __DATA__

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: data.account.currency })
const whole = new Intl.NumberFormat('en-AU', { style: 'currency', currency: data.account.currency, maximumFractionDigits: 0 })
const signed = (n) => (n > 0 ? '+' : '') + money.format(n)
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat')
const day = (ms) => new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const when = (ms) => new Date(ms).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })

const points = data.points
const trades = points.filter((p) => p.trade)
const net = points.length ? points[points.length - 1].equity : 0
const first = points[0], last = points[points.length - 1]

document.getElementById('sub').textContent =
  data.account.id + ' · ' + data.account.broker + ' · ' + data.account.currency +
  (points.length ? ' · ' + day(first.time) + ' – ' + day(last.time) + ' (server time)' : '')

// Stat tiles: the hero number is net P&L, the rest give it scale.
const h = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const tiles = document.getElementById('tiles')

const hero = h('div', 'tile hero')
const heroText = h('div')
heroText.append(h('div', 'label', 'Net P&L'), h('div', 'value ' + tone(net), signed(net)))
hero.append(heroText)
if (data.deposited > 0) {
  const pct = 100 * net / data.deposited
  hero.append(h('div', 'delta ' + tone(net), (pct > 0 ? '+' : '') + pct.toFixed(2) + '% on deposits'))
}
tiles.append(hero)

for (const [label, value, note] of [
  ['Deposited', money.format(data.deposited), null],
  ['Balance', money.format(data.balance), null],
  ['Trades', String(trades.length), trades.length ? Math.round(100 * data.wins / trades.length) + '% won' : null],
]) {
  const tile = h('div', 'tile')
  tile.append(h('div', 'label', label), h('div', 'value', value))
  if (note) tile.append(h('div', 'note', note))
  tiles.append(tile)
}

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

  const days = Math.max(1, Math.round((t1 - t0) / 86400000))
  const every = Math.ceil(days / 6)
  for (let d = 0; d <= days; d += every) {
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
}

function niceStep(rough) {
  if (rough <= 0) return 1
  const power = Math.pow(10, Math.floor(Math.log10(rough)))
  const unit = rough / power
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power
}

// The table: the same numbers with no hovering required.
const table = document.getElementById('table')
const head = table.createTHead().insertRow()
for (const [text, num] of [['Closed', 0], ['Symbol', 0], ['Side', 0], ['Net', 1], ['Running', 1]]) {
  head.append(h('th', num ? 'num' : '', text))
}
const body = table.createTBody()
for (const p of trades) {
  const row = body.insertRow()
  row.insertCell().textContent = when(p.time)
  row.insertCell().textContent = p.trade.symbol
  row.insertCell().append(h('span', 'side', p.trade.side))
  row.append(h('td', 'num ' + tone(p.trade.net), signed(p.trade.net)))
  row.append(h('td', 'num', signed(p.equity)))
}
</script>
</body>
</html>
`

export function main(argv: string[] = []): void {
  const [path, out = 'equity.html'] = argv
  if (!path) {
    console.log('usage: node src/chart.ts <ReportHistory.xlsx> [equity.html]')
    return
  }
  const statement = readStatement(path)
  writeFileSync(out, renderPage(statement, buildTrades(statement)))
  console.log(`wrote ${out}`)
}

if (import.meta.main) main(process.argv.slice(2))
