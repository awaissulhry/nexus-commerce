/**
 * CX A5 — attribute historical Amazon orders to the one account they can only have come from.
 *
 * Orders imported before A0 carry no `channelConnectionId`, so per-account finance matching cannot see
 * them and an unattributed finance row blocks a cutover flip. An order is attributed ONLY when exactly
 * one RUNTIME-USABLE Amazon account of its own business matches its marketplace: the account holds that
 * marketplace scope, or declares no marketplace scope at all (unknown coverage counts as a match, which
 * can only make an order MORE ambiguous, never less). Runtime-usable is what `amazonAccount()` accepts:
 * active, identified, not disconnected/revoked/needs_reauth — an inactive legacy row is never a target
 * (review #3). The stored order payload names no seller (v0 and 2026 order shapes carry none), so the
 * seller is not part of the rule.
 * Zero or several usable matches leave the order untouched; matches with inactive accounts are reported.
 * Each write is a compare-and-set on `channelConnectionId IS NULL` inside the same statement that chose
 * it, so an import that linked the order first (A0) is never overwritten. Finance rows are not touched.
 *
 * Plain SQL over one client: the operator script runs it against a pinned target, and the real-PostgreSQL
 * suite against a throwaway database. Both modes first prove the role can read every business's rows
 * (review #8): under row security a role that cannot would see nothing and report "measured empty".
 * The census reads inside a READ ONLY transaction and reports counts and configuration ids only.
 */

export interface QueryClient {
  query<R = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>
}

/** The predicate `amazonAccount()` applies before it will use an account. */
const USABLE = `(c."isActive" AND c."externalAccountId" IS NOT NULL AND c."authStatus" NOT IN ('disconnected', 'revoked', 'needs_reauth'))`

/** Unattributed Amazon orders and the marketplace their stored payload names. */
const TARGETS_SQL = `
  SELECT o.id, o."workspaceId",
    NULLIF(COALESCE(o."amazonMetadata"->>'MarketplaceId', o."amazonMetadata"->'salesChannel'->>'marketplaceId'), '') AS marketplace_id
  FROM "Order" o
  WHERE o.channel = 'AMAZON' AND o."channelConnectionId" IS NULL`

/** An Amazon account `c` of the order's own business whose marketplace coverage includes target `t`. */
const MATCHES_SQL = `
  JOIN "ChannelConnection" c ON c."workspaceId" = t."workspaceId" AND c."channelType" = 'AMAZON'
  WHERE (t.marketplace_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM "ConnectionScope" s WHERE s."connectionId" = c.id AND s.kind = 'marketplace')
    OR EXISTS (SELECT 1 FROM "ConnectionScope" s WHERE s."connectionId" = c.id AND s.kind = 'marketplace' AND s."externalId" = t.marketplace_id))`

/** Every unattributed Amazon order with its usable and unusable matches and, if exactly one usable, which. */
export const ATTRIBUTION_CANDIDATES_SQL = `
WITH target AS (${TARGETS_SQL}
), candidate AS (
  SELECT t.id AS order_id, c.id AS connection_id, ${USABLE} AS usable
  FROM target t ${MATCHES_SQL}
)
SELECT t.id AS order_id, t."workspaceId" AS workspace_id,
  count(c.connection_id) FILTER (WHERE c.usable)::int AS matches,
  count(c.connection_id) FILTER (WHERE NOT c.usable)::int AS inactive_matches,
  min(c.connection_id) FILTER (WHERE c.usable) AS connection_id
FROM target t LEFT JOIN candidate c ON c.order_id = t.id
GROUP BY t.id, t."workspaceId"`

/** Amazon orders by the account they are linked to, and whether it is usable. Counts and config ids only. */
export const ORDERS_BY_LINKED_ACCOUNT_SQL = `
SELECT o."workspaceId" AS workspace_id, o."channelConnectionId" AS connection_id,
  CASE WHEN c.id IS NULL THEN NULL ELSE ${USABLE} END AS usable, c."isActive" AS is_active,
  count(DISTINCT o.id)::int AS orders, count(ft.id)::int AS finance_rows
FROM "Order" o
LEFT JOIN "ChannelConnection" c ON c.id = o."channelConnectionId"
LEFT JOIN "FinancialTransaction" ft ON ft."orderId" = o.id
WHERE o.channel = 'AMAZON'
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2 NULLS FIRST`

export interface AttributionCensus {
  /** The positive control: who read, and that the role can see every business's rows. */
  readProof: { role: string; bypassesRowSecurity: true }
  amazonOrdersVisible: number
  unattributedOrders: number
  attributable: number
  /** Attributable, but an inactive account matches too: attributed to the usable one, reported here. */
  attributableAlsoMatchingInactive: number
  ambiguous: number
  /** Only inactive accounts match: untouched. */
  inactiveOnly: number
  noMatchingAccount: number
  /** Attributable orders per (business, account): configuration ids only, never order ids. */
  attributableByAccount: Array<{ workspaceId: string; connectionId: string; orders: number }>
  /** Unattributed orders an inactive account matches, per account. */
  inactiveMatchesByAccount: Array<{ workspaceId: string; connectionId: string; orders: number }>
  ordersByLinkedAccount: Array<{ workspaceId: string; connectionId: string | null; usable: boolean | null; isActive: boolean | null; orders: number; financeRows: number }>
}

/**
 * Review #8 — refuse a role that cannot read every business's rows. Every business table forces row
 * security; such a role would read zero orders and the census would report "nothing to attribute".
 */
export async function assertReadsEveryBusiness(client: QueryClient): Promise<string> {
  const [row] = (await client.query<{ role: string; bypass: boolean }>(
    `SELECT current_user AS role, (r.rolsuper OR r.rolbypassrls) AS bypass FROM pg_roles r WHERE r.rolname = current_user`)).rows
  if (!row?.bypass) throw new Error(`Role ${row?.role ?? '(unknown)'} cannot read every business's rows (no BYPASSRLS); refusing to report counts it could not measure.`)
  return row.role
}

/** Read-only census. The caller owns the READ ONLY transaction (see `runAttributionCensus`). */
export async function attributionCensus(client: QueryClient): Promise<AttributionCensus> {
  const role = await assertReadsEveryBusiness(client)
  const visible = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Order" WHERE channel = 'AMAZON'`)).rows[0]!.n
  const totals = (await client.query<{ unattributed: number; attributable: number; also_inactive: number; ambiguous: number; inactive_only: number; none: number }>(`
    SELECT count(*)::int AS unattributed, count(*) FILTER (WHERE matches = 1)::int AS attributable,
      count(*) FILTER (WHERE matches = 1 AND inactive_matches > 0)::int AS also_inactive,
      count(*) FILTER (WHERE matches > 1)::int AS ambiguous,
      count(*) FILTER (WHERE matches = 0 AND inactive_matches > 0)::int AS inactive_only,
      count(*) FILTER (WHERE matches = 0 AND inactive_matches = 0)::int AS none
    FROM (${ATTRIBUTION_CANDIDATES_SQL}) m`)).rows[0]!
  const byAccount = (await client.query<{ workspace_id: string; connection_id: string; orders: number }>(`
    SELECT workspace_id, connection_id, count(*)::int AS orders FROM (${ATTRIBUTION_CANDIDATES_SQL}) m
    WHERE matches = 1 GROUP BY workspace_id, connection_id ORDER BY workspace_id, connection_id`)).rows
  const inactive = (await client.query<{ workspace_id: string; connection_id: string; orders: number }>(`
    WITH target AS (${TARGETS_SQL})
    SELECT t."workspaceId" AS workspace_id, c.id AS connection_id, count(*)::int AS orders
    FROM target t ${MATCHES_SQL} AND NOT ${USABLE}
    GROUP BY 1, 2 ORDER BY 1, 2`)).rows
  const linked = (await client.query<{ workspace_id: string; connection_id: string | null; usable: boolean | null; is_active: boolean | null; orders: number; finance_rows: number }>(ORDERS_BY_LINKED_ACCOUNT_SQL)).rows
  return {
    readProof: { role, bypassesRowSecurity: true }, amazonOrdersVisible: visible,
    unattributedOrders: totals.unattributed, attributable: totals.attributable, attributableAlsoMatchingInactive: totals.also_inactive,
    ambiguous: totals.ambiguous, inactiveOnly: totals.inactive_only, noMatchingAccount: totals.none,
    attributableByAccount: byAccount.map(row => ({ workspaceId: row.workspace_id, connectionId: row.connection_id, orders: row.orders })),
    inactiveMatchesByAccount: inactive.map(row => ({ workspaceId: row.workspace_id, connectionId: row.connection_id, orders: row.orders })),
    ordersByLinkedAccount: linked.map(row => ({ workspaceId: row.workspace_id, connectionId: row.connection_id, usable: row.usable, isActive: row.is_active, orders: row.orders, financeRows: row.finance_rows })),
  }
}

/** The census inside its own REPEATABLE READ, READ ONLY transaction, always rolled back. */
export async function runAttributionCensus(client: QueryClient): Promise<AttributionCensus> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await client.query(`SET LOCAL statement_timeout = '60s'`)
    return await attributionCensus(client)
  } finally {
    await client.query('ROLLBACK')
  }
}

/**
 * One batch: choose up to `limit` unambiguous orders and attribute them in the same statement, each
 * guarded by `channelConnectionId IS NULL` (re-checked on the latest row version under READ COMMITTED).
 * `picked - attributed` orders were linked by someone else first and were left as they are.
 */
export async function attributeBatch(client: QueryClient, limit: number): Promise<{ picked: number; attributed: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('The batch limit must be an integer between 1 and 1000.')
  const [row] = (await client.query<{ picked: number; attributed: number }>(`
    WITH picked AS (
      SELECT order_id, connection_id FROM (${ATTRIBUTION_CANDIDATES_SQL}) m WHERE matches = 1 ORDER BY order_id LIMIT $1
    ), attributed AS (
      UPDATE "Order" o SET "channelConnectionId" = p.connection_id
      FROM picked p
      WHERE o.id = p.order_id AND o."channelConnectionId" IS NULL AND o.channel = 'AMAZON'
      RETURNING o.id
    )
    SELECT (SELECT count(*) FROM picked)::int AS picked, (SELECT count(*) FROM attributed)::int AS attributed`, [limit])).rows
  return { picked: row!.picked, attributed: row!.attributed }
}

/** Attribute every unambiguous order, batch by batch, each batch its own transaction. */
export async function executeAttribution(client: QueryClient, options: { batch?: number; maxBatches?: number } = {}) {
  const batch = options.batch ?? 500, maxBatches = options.maxBatches ?? 200
  // A role that cannot see every business would update nothing and report "nothing to attribute".
  await assertReadsEveryBusiness(client)
  let picked = 0, attributed = 0, batches = 0
  while (batches < maxBatches) {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED')
    let result: { picked: number; attributed: number }
    try {
      await client.query(`SET LOCAL statement_timeout = '60s'`)
      result = await attributeBatch(client, batch)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    batches++
    picked += result.picked
    attributed += result.attributed
    if (result.picked === 0) break
  }
  return { batches, picked, attributed, lostToConcurrentLink: picked - attributed, complete: batches < maxBatches }
}

/**
 * The operator script's target pin: it runs only against the host and database named on its own
 * command line, never a default, never a .env file's.
 */
export function assertPinnedTarget(databaseUrl: string | undefined, targetHost: string | undefined, database: string | undefined): URL {
  if (!targetHost || !database) throw new Error('Pass --target-host and --database explicitly; there is no default target.')
  if (!databaseUrl) throw new Error('Set DATABASE_URL for this run explicitly; no .env file is read.')
  const url = new URL(databaseUrl)
  if (url.hostname !== targetHost || url.pathname !== `/${database}`) {
    throw new Error(`Refusing ${url.hostname}${url.pathname}: the pinned target is ${targetHost}/${database}.`)
  }
  return url
}
