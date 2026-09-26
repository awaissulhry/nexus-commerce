/**
 * P0 baseline — times TODAY's attribute code paths on the private copy `nexus_attributes_test` (never
 * nexus_development, never production) and counts every SQL statement they send.
 *
 * The functions are the ones the routes call:
 *   bulk      : PATCH /products/bulk → applyProductBulkEdits (routes/products.routes.ts:1012)
 *   readiness : reconcileFamilyReadiness (services/pim/readiness-index.service.ts:24), the producer bulk edits wait for
 *   columns   : getSheetColumns (services/pim/sheet-columns.service.ts:1229), cold then warm
 *
 * Usage (cwd apps/api):
 *   REDIS_URL=redis://127.0.0.1:6389/9 NEXUS_AMAZON_ENV_TOKEN=off NEXUS_DISABLE_BACKGROUND_JOBS=1 \
 *     node --import tsx ../../docs/attributes/tools/p0-measure.mts '{"scenario":"bulk","n":100,"spread":"dense"}'
 *   spread: dense  = N products packed into families of 21 (the clone families, children + parent)
 *           sparse = N clone PARENTS, so N different families
 */
import pg from 'pg'

const API = new URL('../../../apps/api/src/', import.meta.url).pathname
const args = JSON.parse(process.argv[2] ?? '{}') as { scenario: string; n?: number; spread?: 'dense' | 'sparse'; field?: string; list?: boolean }

// ── the database guard, before any import that builds a pool ──
const url = process.env.DATABASE_URL ?? ''
// 55439 = the dev container's copy; 55481 = the P7/P8 lane's throwaway copy of it (trust auth, 2026-09-26).
if (url && !/@127\.0\.0\.1:(55439|55481)\/nexus_attributes_test$/.test(url)) throw new Error(`refusing: DATABASE_URL is not the private copy`)

// ── count every statement any pg client sends (the Prisma adapter and raw SQL alike) ──
let statements = 0
let dbMs = 0
const byText = new Map<string, number>()
const origQuery = pg.Client.prototype.query
pg.Client.prototype.query = function (this: unknown, ...a: unknown[]) {
  statements++
  const first = a[0] as { text?: string } | string | undefined
  const text = (typeof first === 'string' ? first : first?.text ?? '').replace(/\s+/g, ' ').replace(/\$\d+/g, '$').slice(0, 140)
  byText.set(text, (byText.get(text) ?? 0) + 1)
  const result = (origQuery as (...x: unknown[]) => unknown).apply(this, a)
  // Wall time spent waiting on the database (statements can overlap, so this is an upper bound of DB time).
  if (result && typeof (result as Promise<unknown>).then === 'function') {
    const t0 = performance.now()
    ;(result as Promise<unknown>).then(() => { dbMs += performance.now() - t0 }, () => { dbMs += performance.now() - t0 })
  }
  return result
} as typeof pg.Client.prototype.query

const { default: prisma } = await import(`${API}/db.ts`)
const [{ name }] = await prisma.$queryRawUnsafe<{ name: string }[]>('select current_database()::text as name')
if (name !== 'nexus_attributes_test') throw new Error(`refusing: connected to ${name}`)
// Positive control for the counter: a known query must move it.
const before = statements
await prisma.$queryRawUnsafe('select 1')
if (statements <= before) throw new Error('statement counter did not move — the pg patch is not on the client Prisma uses')

const { withWorkspace } = await import(`${API}/lib/workspace-context.ts`)
const out: Record<string, unknown> = { args, db: name, at: new Date().toISOString() }

async function measure<T>(label: string, work: () => Promise<T>): Promise<T> {
  const s0 = statements
  const t0 = performance.now()
  try {
    const result = await work()
    out[label] = { ms: Math.round(performance.now() - t0), statements: statements - s0 }
    return result
  } catch (error) {
    // A failure is a measurement too: record how long it ran and why it stopped.
    out[label] = { ms: Math.round(performance.now() - t0), statements: statements - s0, failed: String((error as Error)?.message ?? error).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300) }
    return undefined as T
  }
}

await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }, async () => {
  if (args.scenario === 'bulk') {
    const n = args.n ?? 100
    const field = args.field ?? 'attr_collar_style'
    const rows = args.spread === 'sparse'
      ? await prisma.$queryRawUnsafe<{ id: string; parentId: string | null }[]>(
          `select id, "parentId" from "Product" where sku like 'GALE-JACKET-P0-%' and "parentId" is null order by id limit $1`, n)
      : await prisma.$queryRawUnsafe<{ id: string; parentId: string | null }[]>(
          `select id, "parentId" from "Product" where sku like '%-P0-%' and (id like 'cmokmy3a40078pm0p1fvnu523%' or "parentId" like 'cmokmy3a40078pm0p1fvnu523%') order by coalesce("parentId", id), id limit $1`, n)
    out.products = rows.length
    out.families = new Set(rows.map(r => r.parentId ?? r.id)).size
    const value = `P0 ${Date.now()}`
    const { applyProductBulkEdits } = await import(`${API}/services/products/bulk-edit.service.ts`)
    const result = await measure('bulk', () => applyProductBulkEdits(
      { changes: rows.map(r => ({ id: r.id, field, value: args.list === false ? value : [value] })), marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT' }] } as never,
      { formulaCascade: false, contentPerRow: true, logger: console },
    )) as { errors?: unknown[]; updated?: number }
    out.readinessPendingFamilies = (result as { readinessPendingFamilies?: number })?.readinessPendingFamilies ?? 0
    const pendingRows = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from "ReadinessIndex" r join "Product" p on p.id = r."productId" where r."pendingSince" is not null and (p.id = any($1::text[]) or p."parentId" = any($1::text[]))`,
      rows.map(r => r.parentId ?? r.id))
    out.pendingRows = pendingRows[0].n
    out.errors = (result?.errors ?? []).length
    out.firstErrors = (result?.errors ?? []).slice(0, 3)
    // Read-back: the value must be on every row (a write that did nothing must not look fast).
    const stored = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `select count(*)::int as n from "Product" where id = any($1::text[]) and "categoryAttributes"->'${field.replace(/^attr_/, '')}' = $2::jsonb`,
      rows.map(r => r.id), JSON.stringify(args.list === false ? value : [value]))
    out.readBack = stored[0].n
  } else if (args.scenario === 'readiness') {
    const { reconcileFamilyReadiness } = await import(`${API}/services/pim/readiness-index.service.ts`)
    const roots = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `select id from "Product" where sku like 'GALE-JACKET-P0-%' and "parentId" is null order by id limit $1`, args.n ?? 3)
    const each: number[] = []
    for (const r of roots) {
      const t0 = performance.now()
      const s0 = statements
      const d0 = dbMs
      const rowsWritten = await reconcileFamilyReadiness(r.id)
      each.push(Math.round(performance.now() - t0))
      out[`family ${r.id}`] = { ms: each.at(-1), dbMs: Math.round(dbMs - d0), statements: statements - s0, rows: rowsWritten }
    }
  } else if (args.scenario === 'drain') {
    const { drainPendingReadiness, countPendingReadinessFamilies } = await import(`${API}/services/pim/readiness-index.service.ts`)
    out.pendingBefore = await countPendingReadinessFamilies()
    const report = await measure('drain', () => drainPendingReadiness({ budgetMs: args.n ?? 45_000 }))
    out.report = report
    out.pendingAfter = await countPendingReadinessFamilies()
  } else if (args.scenario === 'columns') {
    const { getSheetColumns } = await import(`${API}/services/pim/sheet-columns.service.ts`)
    const input = { market: 'IT', productTypes: ['OUTERWEAR'], onlyChannels: ['AMAZON'], scopeKind: 'channel' } as never
    const cold = await measure('columns cold', () => getSheetColumns(input)) as { columns?: unknown[] }
    await measure('columns warm', () => getSheetColumns(input))
    out.columnCount = cold?.columns?.length
  } else throw new Error(`unknown scenario ${args.scenario}`)
})

// The statements that ran most often — a per-product statement shows up here with a count near the product count.
out.topStatements = [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([text, n]) => `${n} × ${text}`)
console.log(JSON.stringify(out, null, 1))
await prisma.$disconnect()
process.exit(0)
