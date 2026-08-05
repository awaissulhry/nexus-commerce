/**
 * ACR.4 — re-run the true-profit roll-up so the interim cost estimate populates history.
 *
 * The roll-up upserts by (productId, marketplace, date), so re-running a past day REPAIRS the
 * row rather than duplicating it — the same property the SQP repair relied on. Every component
 * is recomputed from source, so this is idempotent and safe to re-run when real costs land.
 *
 * Usage: npx tsx scripts/_acr4-rollup-backfill.mts [days=45]
 */
import '../src/env.js'
const DAYS = Math.max(1, Math.min(120, Number(process.argv[2] ?? 45)))
const { default: prisma } = await import('../src/db.js')
const { runTrueProfitRollupOnce } = await import('../src/services/advertising/true-profit-rollup.service.js')

const today = new Date(); today.setUTCHours(0, 0, 0, 0)
const from = new Date(today.getTime() - DAYS * 86_400_000)
const to = new Date(today.getTime() - 1)

const before = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE "trueProfitCents" IS NOT NULL)::int AS with_profit,
         COUNT(*) FILTER (WHERE ("coverage"->>'costEstimated')::boolean IS TRUE)::int AS estimated
  FROM "ProductProfitDaily"`)
console.log('\nbefore:', before[0])
console.log(`rolling up ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}\n`)

const r = await runTrueProfitRollupOnce({ fromDate: from, toDate: to })
console.log(`dates=${r.datesProcessed.length} markets=${r.marketplacesProcessed.join(',')} rows=${r.rowsUpserted} adSpend=${r.adSpendProductsUpdated} errors=${r.errors.length}`)
for (const e of r.errors.slice(0, 5)) console.log(`  ! ${e}`)

const after = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
  SELECT COUNT(*)::int AS rows,
         COUNT(*) FILTER (WHERE "trueProfitCents" IS NOT NULL)::int AS with_profit,
         COUNT(*) FILTER (WHERE ("coverage"->>'costEstimated')::boolean IS TRUE)::int AS estimated,
         COUNT(*) FILTER (WHERE ("coverage"->>'hasCostPrice')::boolean IS TRUE)::int AS real_cost,
         ROUND((SUM("trueProfitCents")/100.0)::numeric,2) AS total_profit_eur
  FROM "ProductProfitDaily"`)
console.log('\nafter :', after[0])
await prisma.$disconnect()
