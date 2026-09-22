/**
 * PLAN 15.11 (b) — the MEASUREMENT half of the scale fixture.
 *
 * Times the three things the plan's `Cost when` lines make claims about, against the catalogue
 * `seed-scale-fixture.ts` seeded. Every number here is one machine on one day; what the fixture
 * buys is that the number EXISTS and can be re-taken after a change.
 *
 *   DATABASE_URL=…/nexus_scale npx tsx apps/api/src/scripts/measure-scale-fixture.ts
 *   … --readiness-families 5       # how many family roots to reconcile (default 3)
 *
 * 🔴 EVERY RUN CARRIES ITS OWN CONTROLS, because a timing that has never been shown able to move
 * is not a measurement:
 *   · INSTRUMENT control — `pg_sleep(0.25)` through the same client and the same `timed()`. It
 *     must report ≈250 ms. If it does not, nothing below is a time.
 *   · LAYER control — the un-narrowed `ChannelListing.groupBy` the column build makes, timed
 *     beside the same query WITH a `where`. This is [15.4](PLAN.md)'s *"record the query time
 *     before and after"*, and the two must separate as the catalogue grows.
 *   · SCALE control — run the fixture at 1,000 and at 10,000. A harness whose numbers do not move
 *     with the catalogue is not measuring the catalogue.
 *
 * 🟠 A control that was tried and DOES NOT WORK, recorded so nobody rebuilds it: patching
 * `prisma.channelListing.groupBy` to sleep. The app's client is a Proxy (`db.ts` →
 * `contextualDatabase`), so the assignment is silently discarded — `prisma.channelListing.groupBy
 * === patched` is **false** and the patched function is never called. It reported a 3 ms change on
 * a 250 ms injection and read exactly like "this query is not the cost".
 */
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { clearSheetColumnCache, getSheetColumns } from '../services/pim/sheet-columns.service.js'
import { getSheetRows } from '../services/pim/sheet-rows.service.js'
import { reconcileFamilyReadiness } from '../services/pim/readiness-index.service.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const READINESS_FAMILIES = Number(flag('readiness-families') ?? 3)
const MARKET = (flag('market') ?? 'DE').toUpperCase()
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID

const ms = (n: number) => `${n.toFixed(0)} ms`
async function timed<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now()
  const value = await work()
  return { value, ms: performance.now() - t0 }
}

const results: Array<{ what: string; n: string; ms: number; note: string }> = []
/**
 * 🔴 This is the step's gate. A measurement tool's gate cannot be a push hook — nothing pushes it.
 * It is the tool REFUSING to hand over a number it cannot stand behind. Every entry here is a
 * condition under which the numbers below would be wrong in a way that reads like good news.
 */
const refusals: string[] = []

// Wrapped rather than top-level: `tsconfig.json` does not allow a top-level await here.
async function main() {
/**
 * The shape check runs on a PLAIN client, before anything touches the app's. On a database with no
 * policies the app's role has no grants either, so an app query dies with `permission denied for
 * table Product` — a true failure, but one that names the symptom instead of the cause.
 */
{
  const pg = await import('pg')
  const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const { rows } = await client.query(`select count(*)::int as policies from pg_policies`)
  await client.end()
  if (Number(rows[0].policies) === 0) {
    console.error('\n❌ REFUSED: this database has 0 row-level-security policies; production has 444.')
    console.error('   Every query here would skip a per-row filter production pays, so the numbers')
    console.error('   would be cheaper than production in a way that reads like good news.')
    console.error('   Run: npx tsx apps/api/src/scripts/seed-scale-fixture.ts --prepare\n')
    process.exit(1)
  }
}

await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
  const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>
  const products = await prisma.product.count()
  const roots = await prisma.product.count({ where: { parentId: null } })
  const listings = await prisma.channelListing.count()
  const [{ policies }] = (await prisma.$queryRawUnsafe(`select count(*)::int as policies from pg_policies`)) as Array<{ policies: number }>
  console.log(`database ${database} · ${products} products (${roots} roots) · ${listings} listings · ${policies} policies · market ${MARKET}`)
  if (!products) refusals.push('0 products visible — seed the fixture, and check the workspace context. A count with no context reads as 0.')
  if (!policies) refusals.push('0 row-level-security policies — every query here would skip a per-row filter production pays.')
  if (refusals.length) { report(); process.exit(1) }

  // ── control 1: the INSTRUMENT. A known 250 ms must read as 250 ms. ──
  // `pg_sleep` returns void, which Prisma cannot deserialize — cast it.
  const sleep = await timed(() => prisma.$queryRawUnsafe(`select pg_sleep(0.25)::text as slept`))
  const timerHonest = sleep.ms > 200 && sleep.ms < 400
  results.push({ what: 'CONTROL · instrument (pg_sleep 0.25)', n: 'must be ≈250', ms: sleep.ms, note: timerHonest ? '🟢 the timer and the round trip are real' : '🔴 THE TIMER IS NOT MEASURING' })
  if (!timerHonest) refusals.push(`the instrument control read ${sleep.ms.toFixed(0)} ms for a 250 ms sleep — these are not times.`)

  // ── control 2: the LAYER. 15.4's before/after on the un-narrowed groupBy. ──
  const pageIds = (await prisma.product.findMany({ where: { parentId: null }, select: { id: true }, take: 25 })).map((p) => p.id)
  const groupByAll = await timed(() => prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: { _all: true } }))
  const groupByPage = await timed(() => prisma.channelListing.groupBy({ by: ['channel', 'marketplace'], _count: { _all: true }, where: { productId: { in: pageIds } } }))
  results.push({ what: 'CONTROL · groupBy, NO where (today)', n: `${listings} listings`, ms: groupByAll.ms, note: 'sheet-columns.service.ts — runs on every cache miss' })
  results.push({ what: 'CONTROL · groupBy, narrowed to a page', n: `${pageIds.length} roots`, ms: groupByPage.ms, note: "Step 2.4's stopgap, timed before it is built" })

  // ── 1. the column build (Step 2.4: the un-narrowed groupBy over ChannelListing) ──
  clearSheetColumnCache()
  const masterCold = await timed(() => getSheetColumns({ market: MARKET, scopeKind: 'master' } as never))
  const masterWarm = await timed(() => getSheetColumns({ market: MARKET, scopeKind: 'master' } as never))
  results.push({ what: 'column build · master · COLD', n: `${(masterCold.value as { columns: unknown[] }).columns.length} cols`, ms: masterCold.ms, note: 'includes the full-table ChannelListing groupBy' })
  results.push({ what: 'column build · master · warm', n: 'cache hit', ms: masterWarm.ms, note: '5-minute TTL' })

  const family = await prisma.product.findFirst({ where: { parentId: null }, select: { id: true, familyId: true } })
  if (family?.familyId) {
    clearSheetColumnCache()
    const withFamily = await timed(() => getSheetColumns({ market: MARKET, scopeKind: 'master', familyIds: [family.familyId!] } as never))
    results.push({ what: 'column build · master + family · COLD', n: `${(withFamily.value as { columns: unknown[] }).columns.length} cols`, ms: withFamily.ms, note: 'the entry the cache key is per-family on' })
  }

  for (const channel of ['AMAZON', 'EBAY']) {
    clearSheetColumnCache()
    const built = await timed(() => getSheetColumns({ market: MARKET, onlyChannels: [channel], scopeKind: 'channel' } as never))
    results.push({ what: `column build · channel ${channel} · COLD`, n: `${(built.value as { columns: unknown[] }).columns.length} cols`, ms: built.ms, note: '' })
  }

  // ── 2. the sheet row read, one page ──────────────────────────────
  for (const limit of [25, 100, 200]) {
    const page = await timed(() => getSheetRows({ market: MARKET, page: 1, limit } as never))
    const rows = (page.value as { rows?: unknown[] }).rows?.length ?? 0
    results.push({ what: `sheet row read · limit ${limit}`, n: `${rows} rows`, ms: page.ms, note: 'families never split across a page' })
  }

  // ── 3. the readiness reconcile, per family root (Step 2.7 / 15.1) ──
  const familyRoots = await prisma.product.findMany({ where: { parentId: null }, select: { id: true }, take: READINESS_FAMILIES })
  const perFamily: number[] = []
  let rowsWritten = 0
  for (const root of familyRoots) {
    const run = await timed(() => reconcileFamilyReadiness(root.id))
    perFamily.push(run.ms)
    rowsWritten += run.value
  }
  if (perFamily.length) {
    const mean = perFamily.reduce((a, b) => a + b, 0) / perFamily.length
    results.push({ what: 'readiness reconcile · ONE family', n: `${perFamily.length} sampled`, ms: mean, note: `${Math.round(rowsWritten / perFamily.length)} index rows per family` })
    // 🔴 The projection is the number Step 2.7 is judged on, and it is arithmetic, not a measurement.
    const whole = (mean * roots) / 1000
    console.log(`\nprojected whole-catalogue reconcile at ${roots} roots: ${(whole / 60).toFixed(1)} min  (mean × roots — arithmetic, not measured)`)
  }

  /**
   * 🔴 Scoped to the families THIS RUN reconciled. Counting the whole table instead lets rows an
   * earlier run wrote answer for this one — a stale measurement that reads exactly like a good one.
   * (Measured: with the connections deactivated, the table-wide count stayed healthy and the
   * refusal never fired.)
   */
  const sampled = familyRoots.map((r) => r.id)
  const touched = (await prisma.product.findMany({ where: { OR: [{ id: { in: sampled } }, { parentId: { in: sampled } }] }, select: { id: true } })).map((p) => p.id)
  const scope = { productId: { in: touched } }
  const readinessRows = await prisma.readinessIndex.count({ where: scope })
  const absent = await prisma.readinessIndex.count({ where: { ...scope, state: 'absent' } })
  const channelRows = await prisma.readinessIndex.count({ where: { ...scope, NOT: { channel: null } } })
  console.log(`readiness index: ${readinessRows} rows · ${channelRows} on a channel coordinate · ${absent} 'absent'`)
  if (channelRows === 0) refusals.push('the reconcile wrote NO channel rows — it swept only the shared scope, so its time is not the sweep\'s time.')
  else if (channelRows === absent) refusals.push('every channel row is `absent` — the sweep never checked a channel. Seed an ACTIVE ChannelConnection per channel (readiness-index.service.ts:78).')
})

function report() {
  console.log('')
  console.log('| what | n | time | note |')
  console.log('|---|---|---|---|')
  for (const r of results) console.log(`| ${r.what} | ${r.n} | ${ms(r.ms)} | ${r.note} |`)
  if (refusals.length) {
    console.error('\n❌ REFUSED — these numbers would be wrong in the direction of good news:')
    for (const r of refusals) console.error(`   · ${r}`)
    console.error('')
  }
}

report()
process.exit(refusals.length ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
