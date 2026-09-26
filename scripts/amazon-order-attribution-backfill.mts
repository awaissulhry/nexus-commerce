/**
 * CX A5 — attribute historical Amazon orders to their one matching account. NOT EXECUTED by the lane
 * that wrote it; running it against any real database needs the Owner's approval.
 *
 *   npx tsx scripts/amazon-order-attribution-backfill.mts                    # describe: prints the plan, no connection
 *   DATABASE_URL=… npx tsx scripts/amazon-order-attribution-backfill.mts census --target-host H --database D
 *   DATABASE_URL=… npx tsx scripts/amazon-order-attribution-backfill.mts --execute-approved --target-host H --database D [--batch 500]
 *
 * The target is pinned on the command line: DATABASE_URL must name exactly that host and database, and
 * no .env file is read. `census` runs in a REPEATABLE READ, READ ONLY transaction and prints counts only.
 * `--execute-approved` attributes only orders with exactly one matching account, each by compare-and-set
 * on channelConnectionId IS NULL, in batches that each commit on their own. Rule and SQL:
 * apps/api/src/services/amazon-order-attribution.ts (tested against throwaway PostgreSQL only).
 */
import pg from 'pg'
import { ATTRIBUTION_CANDIDATES_SQL, ORDERS_BY_LINKED_ACCOUNT_SQL, assertPinnedTarget, executeAttribution, runAttributionCensus } from '../apps/api/src/services/amazon-order-attribution.js'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const mode = args.includes('--execute-approved') ? 'execute' : args[0] === 'census' ? 'census' : 'describe'

const plan = {
  action: 'amazon-order-attribution',
  mode,
  rule: 'Attribute an unattributed AMAZON order only when exactly one RUNTIME-USABLE Amazon account (active, identified, not disconnected/revoked/needs_reauth) of its own business matches its marketplace scope (or declares no marketplace scope). Zero or several usable matches: untouched. Inactive/unusable accounts are never targets; their matches are reported. Stored order payloads name no seller, so the seller is not part of the rule.',
  write: 'UPDATE "Order" SET "channelConnectionId" = <the one account> WHERE id = <order> AND "channelConnectionId" IS NULL — chosen and written in one statement per batch; never overwrites a link made first by an import.',
  untouched: 'FinancialTransaction rows, ambiguous orders, orders with no matching account, every non-Amazon order.',
  census: 'Counts and configuration ids only: readProof (the role must bypass row security, else the run refuses rather than report an empty measurement), amazonOrdersVisible, unattributedOrders, attributable, attributableAlsoMatchingInactive, ambiguous, inactiveOnly, noMatchingAccount, attributable and inactive matches per (business, account), and Amazon orders + finance rows by linked account with its usable/isActive state. No order ids, no amounts.',
  ordersByLinkedAccountSql: ORDERS_BY_LINKED_ACCOUNT_SQL.trim(),
  candidatesSql: ATTRIBUTION_CANDIDATES_SQL.trim(),
  target: { host: flag('--target-host') ?? null, database: flag('--database') ?? null },
}
console.log(JSON.stringify(plan, null, 2))
if (mode === 'describe') process.exit(0)

let client: pg.Client | undefined
try {
  const url = assertPinnedTarget(process.env.DATABASE_URL, flag('--target-host'), flag('--database'))
  client = new pg.Client({ connectionString: url.toString(), application_name: 'cx-amazon-order-attribution' })
  await client.connect()
  const result = mode === 'census'
    ? await runAttributionCensus(client)
    : await executeAttribution(client, { batch: flag('--batch') ? Number(flag('--batch')) : undefined })
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), mode, target: plan.target, result }, null, 2))
} catch (error) {
  // Never echo the connection string or driver detail: either can carry credentials.
  const message = error instanceof Error && /^(Pass --target-host|Set DATABASE_URL|Refusing |The batch limit|Role .* cannot read every business)/.test(error.message) ? error.message : 'attribution run failed'
  console.error(JSON.stringify({ error: message, code: (error as { code?: unknown })?.code ?? null }))
  process.exitCode = 1
} finally {
  await client?.end().catch(() => undefined)
}
