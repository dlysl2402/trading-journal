/**
 * The smallest Supabase client that can keep the record.
 *
 * Supabase exposes every table over REST (PostgREST), so three verbs over
 * `fetch` are the whole client and no SDK is needed — the same choice as
 * `metaapi.ts`. Everything awkward about the API — the row cap per response,
 * the header that turns an insert into an upsert — is quarantined here.
 *
 * The key is the project's *secret* key, which bypasses row-level security.
 * That is what lets the import write broker tables the UI may only read, and
 * it is why the key lives in `.env` on the server and nowhere else.
 */

/** Supabase caps a response at 1000 rows by default, so reads are walked. */
const PAGE = 1000

export interface Store {
  /** The project URL, e.g. https://abcd.supabase.co */
  url: string
  /** The project's secret key (sb_secret_… or the legacy service_role JWT). */
  key: string
}

export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.SUPABASE_URL
  const key = env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('set SUPABASE_URL and SUPABASE_SECRET_KEY — see .env.example')
  return { url: url.replace(/\/$/, ''), key }
}

/**
 * Supabase's gateway mints a short-lived token from the secret key on every
 * request, and PostgREST now and then rejects that token as issued in the
 * future because its clock is a hair behind the gateway's (PGRST303). The
 * documented answer is one retry a second later, and only for that error.
 */
const CLOCK_SKEW = 'PGRST303'

async function request(
  store: Store, method: 'GET' | 'POST', table: string, query: string,
  body?: unknown, prefer?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    apikey: store.key,
    Authorization: `Bearer ${store.key}`,
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (prefer !== undefined) headers.Prefer = prefer
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  const url = `${store.url}/rest/v1/${table}${query}`

  let response = await fetch(url, init)
  if (response.status === 401 && (await response.clone().text()).includes(CLOCK_SKEW)) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    response = await fetch(url, init)
  }
  if (!response.ok) {
    // The body names the constraint or policy that refused; the status alone
    // cannot tell a bad key from a missing table.
    const text = (await response.text()).slice(0, 300)
    throw new Error(`Supabase ${response.status} on ${method} ${table}: ${text}`)
  }
  return response
}

/**
 * Every row matching a PostgREST filter such as `account_id=eq.X&select=raw`.
 * The response says how many rows exist in total, and that — not a short
 * page — is the signal to stop, so a lowered row cap cannot truncate a read.
 */
export async function selectAll<T>(store: Store, table: string, filter: string): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const query = `?${filter}&limit=${PAGE}&offset=${rows.length}`
    const response = await request(store, 'GET', table, query, undefined, 'count=exact')
    const page = await response.json() as T[]
    rows.push(...page)

    // "0-999/1234", or "*/0" when there is nothing.
    const total = Number(response.headers.get('content-range')?.split('/')[1])
    if (Number.isNaN(total)) throw new Error(`Supabase: no row count on GET ${table}`)
    if (rows.length >= total || page.length === 0) return rows
  }
}

/** Add rows. A row whose key already exists is an error, never an overwrite. */
export async function insert(store: Store, table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return
  await request(store, 'POST', table, '', rows, 'return=minimal')
}

/** Add or replace rows by primary key. Only for tables without the append-only trigger. */
export async function upsert(store: Store, table: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return
  await request(store, 'POST', table, '', rows, 'return=minimal,resolution=merge-duplicates')
}
