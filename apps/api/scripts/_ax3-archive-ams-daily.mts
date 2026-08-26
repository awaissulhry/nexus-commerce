/**
 * AX3 — move the stream-written DAILY duplicates out of the live table.
 *
 * ── What this is fixing ───────────────────────────────────────────────────────
 *
 * AX2.3 stopped Amazon Marketing Stream writing daily rows and marked the 659 already written
 * with `reportRunId = 'ams-stream'`, so aggregates could exclude them. That works wherever the
 * guard is applied. Measured 2026-08-26 by `_ams-reader-audit.mts`: 21 reads carry it, 66 cannot
 * see the rows anyway (wrong grain, or joined on `localEntityId`, which is NULL on all 659), and
 * **36 are genuinely exposed** — including `ads-budget-enforce.service.ts:74`, the month-to-date
 * spend per market that drives auto-pacing and stop-overspend. That one is not a display defect:
 * an inflated spend figure there moves real budgets on Amazon.
 *
 * Thirty-six guards is thirty-six chances to forget the thirty-seventh. Removing the rows makes
 * the question unaskable. The guards STAY — they cost nothing and they are the defence if a
 * future ingest path ever writes to this grain again.
 *
 * ── Why this is safe, measured rather than assumed ───────────────────────────
 *
 * All 659 rows are IT / CAMPAIGN / 2026-05-21..2026-07-27, and every one of them has a report-run
 * twin for the same (marketplace, date, entityType, entityId). The "would deleting this lose a
 * campaign-day nothing else covers?" query returns zero rows. Nothing unique is being removed —
 * and it is copied first regardless.
 *
 * ── How it refuses to be wrong ───────────────────────────────────────────────
 *
 *  · Dry run unless `--apply`. The dry run does the INSERT and the checks, then rolls back.
 *  · Columns come from `information_schema`, never a hand-written list, so a column added to the
 *    source since the migration ran is carried rather than silently dropped.
 *  · The copy is verified INSIDE the transaction — row count and the sum of `costMicros`,
 *    `impressions`, `clicks` and `sales7dCents` — and any mismatch throws, which rolls back the
 *    INSERT and the DELETE together. There is no state where the rows are gone and unarchived.
 *  · Idempotent: a second run finds nothing marked and exits having done nothing.
 *
 * Restore: `_ax3-restore-ams-daily.mts`.
 */
const { default: prisma } = await import('../src/db.js')

const APPLY = process.argv.includes('--apply')
const MARKER = 'ams-stream'
const REASON = 'ams-daily-duplicate'
const SRC = '"AmazonAdsDailyPerformance"'
const ARC = '"AmazonAdsDailyPerformanceArchive"'

const n = (v: unknown) => Number(v ?? 0)
type Tally = { rows: number; cost: number; impressions: number; clicks: number; sales: number }

async function main() {
  // Every column the SOURCE has. `::text` on the catalog columns — information_schema exposes
  // them as `name`, which has no implicit cast to text and makes the comparison fail at runtime.
  const cols = (await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name::text AS column_name FROM information_schema.columns
    WHERE table_name = 'AmazonAdsDailyPerformance' ORDER BY ordinal_position`)).map((c) => c.column_name)
  if (cols.length === 0) throw new Error('source table has no columns — wrong database?')

  // Any column the source has that the archive does not: the archive was created with LIKE, so
  // this can only happen if the source gained one afterwards. Refuse rather than drop it.
  const arcCols = new Set((await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name::text AS column_name FROM information_schema.columns
    WHERE table_name = 'AmazonAdsDailyPerformanceArchive'`)).map((c) => c.column_name))
  if (arcCols.size === 0) throw new Error('archive table does not exist — run the migration first')
  const missing = cols.filter((c) => !arcCols.has(c))
  if (missing.length) throw new Error(`archive is missing columns the source has: ${missing.join(', ')}`)

  const list = cols.map((c) => `"${c}"`).join(', ')

  const tally = async (tx: typeof prisma, table: string, where: string): Promise<Tally> => {
    const r = (await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`
      SELECT COUNT(*)::int AS rows, COALESCE(SUM("costMicros"), 0)::text AS cost,
             COALESCE(SUM("impressions"), 0)::int AS impressions,
             COALESCE(SUM("clicks"), 0)::int AS clicks,
             COALESCE(SUM("sales7dCents"), 0)::int AS sales
      FROM ${table} WHERE ${where}`))[0]
    return { rows: n(r.rows), cost: Number(r.cost), impressions: n(r.impressions), clicks: n(r.clicks), sales: n(r.sales) }
  }

  const before = await tally(prisma, SRC, `"reportRunId" = '${MARKER}'`)
  console.log(`marked in the live table: ${JSON.stringify(before)}`)
  if (before.rows === 0) {
    const already = await tally(prisma, ARC, `"archivedReason" = '${REASON}'`)
    console.log(`nothing to move. archive already holds: ${JSON.stringify(already)}`)
    return
  }

  await prisma.$transaction(async (tx) => {
    const moved = await tx.$executeRawUnsafe(`
      INSERT INTO ${ARC} (${list}, "archivedAt", "archivedReason")
      SELECT ${list}, NOW(), '${REASON}' FROM ${SRC} WHERE "reportRunId" = '${MARKER}'`)
    if (moved !== before.rows) throw new Error(`copied ${moved} of ${before.rows} — refusing to delete`)

    const copied = await tally(tx as typeof prisma, ARC, `"archivedReason" = '${REASON}'`)
    // Every additive measure must agree. A count alone would pass on 659 rows of zeroes.
    for (const k of ['rows', 'cost', 'impressions', 'clicks', 'sales'] as const) {
      if (copied[k] !== before[k]) throw new Error(`${k}: archive ${copied[k]} vs source ${before[k]} — refusing to delete`)
    }
    console.log(`verified in-transaction: ${JSON.stringify(copied)}`)

    const deleted = await tx.$executeRawUnsafe(`DELETE FROM ${SRC} WHERE "reportRunId" = '${MARKER}'`)
    if (deleted !== before.rows) throw new Error(`deleted ${deleted} of ${before.rows} — rolling back`)

    const left = await tally(tx as typeof prisma, SRC, `"reportRunId" = '${MARKER}'`)
    if (left.rows !== 0) throw new Error(`${left.rows} marked rows still in the live table — rolling back`)

    if (!APPLY) throw new Error('DRY RUN — everything above verified, rolling back. Re-run with --apply.')
  }, { timeout: 120_000 })

  const after = await tally(prisma, SRC, `"reportRunId" = '${MARKER}'`)
  const arc = await tally(prisma, ARC, `"archivedReason" = '${REASON}'`)
  console.log(`\nAPPLIED. live table marked rows: ${after.rows}. archive: ${JSON.stringify(arc)}`)
}

main()
  .catch((e) => {
    const msg = (e as Error).message
    if (msg.startsWith('DRY RUN')) { console.log(`\n${msg}`); process.exitCode = 0; return }
    console.error(`\nFAILED (nothing changed): ${msg}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
