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
 * reads; the snapshot written each run keeps everything MetaApi sent.
 */

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

async function get<T>(credentials: Credentials, path: string, query = ''): Promise<T> {
  const host = `https://mt-client-api-v1.${credentials.region}.agiliumtrade.ai`
  const url = `${host}/users/current/accounts/${credentials.accountId}${path}${query}`

  const response = await fetch(url, {
    headers: { 'auth-token': credentials.token, Accept: 'application/json' },
  })
  if (!response.ok) {
    // The body names the cause. From the status alone an expired token, a
    // wrong region and an undeployed account are indistinguishable.
    const body = (await response.text()).slice(0, 300)
    throw new Error(`MetaApi ${response.status} on ${path}: ${body}`)
  }
  return await response.json() as T
}

/** Walk every page. A short page is the only signal that it was the last. */
async function paged<T>(credentials: Credentials, path: string): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await get<T[]>(credentials, path, `?offset=${offset}&limit=${PAGE}`)
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
): Promise<RawFeed> {
  const window = `/time/${EPOCH}/${now.toISOString()}`
  const [account, deals, orders] = await Promise.all([
    get<RawAccount>(credentials, '/accountInformation'),
    paged<RawDeal>(credentials, `/history-deals${window}`),
    paged<RawOrder>(credentials, `/history-orders${window}`),
  ])
  return { account, deals, orders, fetchedAt: now }
}
