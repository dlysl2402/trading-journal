/**
 * The smallest MetaApi client that can re-read an account's history.
 *
 * MetaApi ships an SDK, but nearly all of it manages WebSocket streaming and
 * synchronisation state that a poll has no use for. Three GETs cover the whole
 * feed, so this module is three GETs. Everything awkward about their API —
 * the region buried in the hostname, the silent 1000-row page limit — is
 * quarantined here so that `journal.ts` works with plain objects.
 *
 * Nothing here interprets. The shapes below name only the fields the journal
 * reads; the snapshot written each run keeps everything MetaApi sent, with
 * one exception. MetaApi stamps every deal and order with the account
 * currency's exchange rate *as of the fetch*, so the field changes on every
 * pull and says nothing about the deal. It is dropped here, before the row
 * reaches the record, or every row would look amended fifteen minutes later.
 */

/** Fields that describe the fetch, not the history, so they are not recorded. */
const FETCH_TIME_FIELDS = ['accountCurrencyExchangeRate']

export function withoutFetchTimeFields<T extends object>(row: T): T {
  const copy = { ...row } as Record<string, unknown>
  for (const field of FETCH_TIME_FIELDS) delete copy[field]
  return copy as T
}

import { resolve4 } from 'node:dns/promises'
import { request } from 'node:https'

/** MetaApi pages at 1000 rows and reports no total, so pages are walked. */
const PAGE = 1000

/** Earlier than any retail account, so a fetch always covers all of history. */
const EPOCH = '2000-01-01T00:00:00.000Z'

export interface Credentials {
  accountId: string
  token: string
  /** Part of the hostname: an account only answers in the region it lives in. */
  region: string
}

/**
 * A deal as MetaApi sends it. Optional fields really are absent, not null:
 * a deposit carries no symbol, and a fill with no stop set carries no stop.
 */
export interface RawDeal {
  id: string
  /** DEAL_TYPE_BUY, DEAL_TYPE_SELL, DEAL_TYPE_BALANCE, or a kind the journal refuses. */
  type: string
  /** DEAL_ENTRY_IN or DEAL_ENTRY_OUT on a fill; absent on a deposit. */
  entryType?: string
  /** True UTC. */
  time: string
  /** The same instant on the broker's clock: "YYYY-MM-DD HH:mm:ss.SSS". */
  brokerTime: string
  symbol?: string
  volume?: number
  price?: number
  commission: number
  swap: number
  /** Gross, booked on the closing fill. A deposit puts its amount here too. */
  profit: number
  orderId?: string
  positionId?: string
  /** What fired the deal: DEAL_REASON_SL, _TP, _CLIENT, _MOBILE, _WEB, _EXPERT, _SO. */
  reason?: string
  /** The position's levels as they stood when this deal was booked. */
  stopLoss?: number
  takeProfit?: number
}

export interface RawOrder {
  id: string
  /**
   * The comment as MetaApi first saw it. MT5 overwrites a comment with the
   * bracket that fired, so this may read "[tp 4382.63]" rather than a tag.
   */
  comment?: string
  stopLoss?: number
  takeProfit?: number
}

export interface RawAccount {
  broker: string
  currency: string
  login: number
  balance: number
  /** True when MetaApi holds the investor password rather than the master one. */
  investorMode: boolean
}

export interface RawFeed {
  account: RawAccount
  deals: RawDeal[]
  orders: RawOrder[]
  /** When this fetch ran — what a staleness check reads. */
  fetchedAt: Date
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials {
  const accountId = env.METAAPI_ACCOUNT_ID
  const token = env.METAAPI_ACCESS_TOKEN
  const region = env.METAAPI_REGION
  if (!accountId || !token || !region) {
    throw new Error(
      'set METAAPI_ACCOUNT_ID, METAAPI_ACCESS_TOKEN and METAAPI_REGION — see .env.example')
  }
  return { accountId, token, region }
}

/** What one front server said. Returned, not thrown, so the caller decides per status. */
export interface Reply {
  status: number
  body: string
}

/** One GET to one address of a host, with the hostname kept for TLS and Host. */
export type Transport = (host: string, address: string, path: string, token: string) => Promise<Reply>

const httpsGet: Transport = (host, address, path, token) =>
  new Promise((resolve, reject) => {
    const req = request({
      host,
      path,
      headers: { 'auth-token': token, Accept: 'application/json' },
      // No connection pool. Node keys pooled sockets by hostname, not address,
      // so a request meant for one server could reuse a socket open to
      // another; three requests a run do not need reuse anyway.
      agent: false,
      // Node asks for every address at once when it may race them; either way,
      // the answer is the one address this call is for.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }])
        else callback(null, address, 4)
      },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('no answer within 20s')))
    req.on('error', reject)
    req.end()
  })

interface Source {
  credentials: Credentials
  /** The host's addresses, tried in this order. */
  addresses: string[]
  transport: Transport
}

const hostOf = (credentials: Credentials) => `mt-client-api-v1.${credentials.region}.agiliumtrade.ai`

/**
 * GET from the first front server that will answer.
 *
 * The hostname resolves to several servers, and on 2026-09-21 two of the four
 * behind the London name answered every request — good token or bad — with a
 * bare nginx 503 while the other two were fine. Which one a resolver lists
 * first decides whether a machine can reach MetaApi at all, so a 503 or a
 * refused connection from one address moves on to the next. Any other status
 * is an answer about the request itself, and is thrown at once.
 */
async function get<T>(source: Source, path: string, query = ''): Promise<T> {
  const host = hostOf(source.credentials)
  const fullPath = `/users/current/accounts/${source.credentials.accountId}${path}${query}`

  let unavailable: Error | undefined
  for (const address of source.addresses) {
    let reply: Reply
    try {
      reply = await source.transport(host, address, fullPath, source.credentials.token)
    } catch (error) {
      unavailable = new Error(`MetaApi ${address} on ${path}: ${(error as Error).message}`)
      continue
    }
    if (reply.status === 200) return JSON.parse(reply.body) as T

    // The body names the cause. From the status alone an expired token, a
    // wrong region and an undeployed account are indistinguishable.
    const error = new Error(`MetaApi ${reply.status} on ${path} via ${address}: ${reply.body.slice(0, 300)}`)
    if (reply.status !== 503) throw error
    unavailable = error
  }
  throw unavailable ?? new Error(`MetaApi: ${host} resolved to no address`)
}

/** Walk every page. A short page is the only signal that it was the last. */
async function paged<T>(source: Source, path: string): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await get<T[]>(source, path, `?offset=${offset}&limit=${PAGE}`)
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

/**
 * Read the whole account: information, every deal, every order.
 *
 * The full history is re-read each time rather than only what is new. At this
 * size it costs a few tens of kilobytes, and it is the only approach that
 * survives the two things an incremental sync gets wrong — a page lost to a
 * dropped connection, and a broker amending a deal that was already imported.
 */
export async function fetchFeed(
  credentials: Credentials,
  now: Date = new Date(),
  transport: Transport = httpsGet,
  resolve: (host: string) => Promise<string[]> = resolve4,
): Promise<RawFeed> {
  const source: Source = { credentials, addresses: await resolve(hostOf(credentials)), transport }
  const window = `/time/${EPOCH}/${now.toISOString()}`
  const [account, deals, orders] = await Promise.all([
    get<RawAccount>(source, '/accountInformation'),
    paged<RawDeal>(source, `/history-deals${window}`),
    paged<RawOrder>(source, `/history-orders${window}`),
  ])
  return {
    account,
    deals: deals.map(withoutFetchTimeFields),
    orders: orders.map(withoutFetchTimeFields),
    fetchedAt: now,
  }
}
