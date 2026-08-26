/**
 * AX3 — put the archived daily rows back. The reversal of `_ax3-archive-ams-daily.mts`.
 *
 * This exists so the archive is a MOVE and not a deletion. It is not expected to be run: the 659
 * rows it restores are duplicates of the report pipeline's own, every one with a report-run twin,
 * and restoring them re-inflates every unguarded aggregate exactly as before. It exists because
 * "we can put it back" is only true if the thing that puts it back has been written and typechecked
 * before the removal, not promised afterwards.
 *
 * Dry run unless `--apply`, same as the archive script, and the same in-transaction verification
 * in the opposite direction. The source's unique constraint is the real safety net here: if a row
 * with the same (profileId, adProduct, entityType, entityId, date) already exists, the INSERT
 * fails and the whole thing rolls back rather than creating a second duplicate.
 */
const { default: prisma } = await import('../src/db.js')

const APPLY = process.argv.includes('--apply')
const REASON = 'ams-daily-duplicate'
const SRC = '"AmazonAdsDailyPerformance"'
const ARC = '"AmazonAdsDailyPerformanceArchive"'

async function main() {
  const cols = (await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
    SELECT column_name::text AS column_name FROM information_schema.columns
    WHERE table_name = 'AmazonAdsDailyPerformance' ORDER BY ordinal_position`)).map((c) => c.column_name)
  const list = cols.map((c) => `"${c}"`).join(', ')

  const held = Number((await prisma.$queryRawUnsafe<Array<{ rows: number }>>(
    `SELECT COUNT(*)::int AS rows FROM ${ARC} WHERE "archivedReason" = '${REASON}'`))[0].rows)
  console.log(`archive holds ${held} row(s) for reason '${REASON}'`)
  if (held === 0) { console.log('nothing to restore.'); return }

  await prisma.$transaction(async (tx) => {
    const back = await tx.$executeRawUnsafe(`
      INSERT INTO ${SRC} (${list})
      SELECT ${list} FROM ${ARC} WHERE "archivedReason" = '${REASON}'`)
    if (back !== held) throw new Error(`restored ${back} of ${held} — rolling back`)

    const removed = await tx.$executeRawUnsafe(`DELETE FROM ${ARC} WHERE "archivedReason" = '${REASON}'`)
    if (removed !== held) throw new Error(`cleared ${removed} of ${held} from the archive — rolling back`)

    if (!APPLY) throw new Error('DRY RUN — everything above verified, rolling back. Re-run with --apply.')
  }, { timeout: 120_000 })

  console.log(`\nRESTORED ${held} row(s) to the live table.`)
}

main()
  .catch((e) => {
    const msg = (e as Error).message
    if (msg.startsWith('DRY RUN')) { console.log(`\n${msg}`); process.exitCode = 0; return }
    console.error(`\nFAILED (nothing changed): ${msg}`)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
