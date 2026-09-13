/**
 * R-LX-23 — ONE-SHOT production backfill of `SyncLogErrorGroup.fingerprint`.
 *
 * WHY IT IS NEEDED. R-LX-19 changed the part delimiter inside `fingerprintError`
 * (`apps/api/src/services/error-grouping.service.ts`) from a literal NUL byte 0x00 to the unit
 * separator 0x1F, because the NUL blinded `ugrep` — and therefore every `grep`-based gate — to that
 * whole file. The hash of every existing group was computed with the old delimiter, so on the first
 * deploy each recurring error would open a NEW group beside the old one: the occurrence counts reset,
 * `firstSeen` resets, and any group an operator had marked RESOLVED stops suppressing (a resolved
 * group flips back to ACTIVE only when its OWN fingerprint recurs, and its fingerprint never will).
 *
 * WHAT IT DOES. For every row it recomputes the hash from the row's own stored components — `channel`,
 * `operation`, `errorType`, `errorCode` and `normaliseMessage(sampleMessage)` — first with the OLD
 * delimiter and then with the new one, and rewrites `fingerprint` only where the OLD recomputation
 * REPRODUCES THE STORED VALUE. That comparison is the whole safety argument: it proves the recomputed
 * parts are the parts the stored hash was made from. A row that does not reproduce is reported and left
 * untouched — its `sampleMessage` has been refreshed (the writer replaces it with the latest raw message
 * on every occurrence) or truncated at 1,000 characters, so its hash cannot be reconstructed, and
 * inventing one would move a group with nobody able to see it happen.
 *
 * It also REFUSES to write at all unless the projected number of distinct fingerprints equals the
 * current number — nothing may merge or split. That refusal already earned its place: the first
 * rehearsal of this script passed the stored row into `fingerprintError` directly, whose message field
 * is named `message` and not `sampleMessage`, so every "new" hash was computed over `<no-message>` and
 * 74 groups projected down to 50. The control caught it; without it the script would have merged 24
 * groups and reported success.
 *
 * It writes ONLY the `fingerprint` column. No count, no status, no timestamp, no other table.
 *
 * ── REHEARSED ON LOCAL 2026-09-13 (`nexus_development`, GALE-JACKET `Product.version` 59) ───────────
 *   74 rows · 74 distinct fingerprints · 2,284 occurrences · 74 ACTIVE / 0 RESOLVED
 *   73 reproduced under the old delimiter and were rewritten · 1 did not and was left alone
 *     (`cmt14dsy20001s4a38var7ybg`, AMAZON `ads POST /reporting/reports`: stored d9ed22a81f37b70f…,
 *      recomputed-old 3c9a4817e186689e…)
 *   AFTER, read back 8.5 s later: 74 rows · 74 distinct · 2,284 occurrences · 74 ACTIVE
 *     → before/after group counts IDENTICAL, and every rewritten row now equals what the LIVE writer
 *       produces for the next occurrence of the same error (the property that stops a new group opening)
 *   The whole BEFORE state is in `error-grouping-fingerprints-before.json` beside this file; `--restore`
 *   replays it by value.
 *
 * ── HOW TO RUN IT ON PRODUCTION (the Owner's word only; nothing here has been run on prod) ──────────
 *   1. Rehearse first — it writes nothing and prints the same report:
 *        railway run --service "/api" env -u REDIS_URL npx tsx docs/audits/2026-09-13-lx-fin/20260913_lxfin_error_grouping_fingerprint_backfill.mts
 *   2. If, and only if, the report says `groupCountsIdentical: true`, apply:
 *        railway run --service "/api" env -u REDIS_URL npx tsx docs/audits/2026-09-13-lx-fin/20260913_lxfin_error_grouping_fingerprint_backfill.mts --apply
 *   3. Verify with SQL (no script needed):
 *        SELECT count(*) AS rows, count(DISTINCT fingerprint) AS groups,
 *               sum("count") AS occurrences,
 *               count(*) FILTER (WHERE "resolutionStatus" = 'RESOLVED') AS resolved
 *          FROM "SyncLogErrorGroup";
 *      `rows`, `groups`, `occurrences` and `resolved` must all be unchanged from the pre-run reading.
 *
 * 🔴 ORDER MATTERS: run this BEFORE the deploy that ships the new delimiter, or immediately after and
 * before the next sync error arrives. Between the deploy and this backfill, a recurring error opens a
 * duplicate group; running the backfill afterwards does not merge the duplicate back.
 *
 * 🔴 If the Owner prefers NOT to run anything: the alternative is to keep the NUL byte in this one file
 * behind a one-entry baseline in `scripts/check-no-nul-bytes.mjs`, which R-LX-19 deliberately removed.
 * The cost of doing nothing is bounded and visible: each recurring error opens one new group once, and
 * on LOCAL there were 0 RESOLVED groups to lose. Production's own RESOLVED count (the SQL above) is the
 * number that decides it.
 *
 * It prints a report and exits non-zero rather than writing anything it cannot justify.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const prisma = (await import('../../../apps/api/src/db.js')).default
const { fingerprintError, normaliseMessage } = await import('../../../apps/api/src/services/error-grouping.service.js')

const BEFORE = new URL('./error-grouping-fingerprints-before.json', import.meta.url)
const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--restore') ? 'restore' : 'rehearse'

/** The database is NAMED, never inferred — printed so the operator sees which one answered. */
const db = (await prisma.$queryRawUnsafe<Array<{ current_database: string }>>('SELECT current_database()::text AS current_database'))[0]
console.log(`MODE ${mode} · current_database = ${db.current_database}`)

/** Verbatim from `git show <pre-R-LX-19>:apps/api/src/services/error-grouping.service.ts`. */
const OLD_DELIMITER = '\u0000'

type Row = { id: string; fingerprint: string; channel: string; operation: string; errorType: string | null; errorCode: string | null; sampleMessage: string | null; count: number; resolutionStatus: string }

const parts = (row: Row) => [row.channel, row.operation, row.errorType ?? '<no-type>', row.errorCode ?? '<no-code>', row.sampleMessage ? normaliseMessage(row.sampleMessage) : '<no-message>']
const oldFingerprint = (row: Row) => createHash('sha256').update(parts(row).join(OLD_DELIMITER)).digest('hex')
/** The LIVE writer's own function — `message`, not `sampleMessage`; see the header. */
const newFingerprint = (row: Row) => fingerprintError({ channel: row.channel, operation: row.operation, errorType: row.errorType, errorCode: row.errorCode, message: row.sampleMessage })

const rows = (await prisma.syncLogErrorGroup.findMany({ orderBy: { id: 'asc' } })) as unknown as Row[]

if (mode === 'restore') {
  if (!existsSync(BEFORE)) { console.error('No BEFORE capture beside this file — nothing to restore'); process.exit(3) }
  const before = JSON.parse(readFileSync(BEFORE, 'utf8')) as Row[]
  for (const row of before) await prisma.syncLogErrorGroup.update({ where: { id: row.id }, data: { fingerprint: row.fingerprint } })
  await new Promise((r) => setTimeout(r, 8500))
  const after = (await prisma.syncLogErrorGroup.findMany({ select: { id: true, fingerprint: true }, orderBy: { id: 'asc' } })) as Array<{ id: string; fingerprint: string }>
  const exact = after.length === before.length && before.every((b) => after.find((a) => a.id === b.id)?.fingerprint === b.fingerprint)
  console.log(`restored ${before.length}; read back ${new Date().toISOString()}; BY-VALUE EXACT: ${exact}`)
  await prisma.$disconnect()
  process.exit(exact ? 0 : 4)
}

if (!existsSync(BEFORE)) {
  writeFileSync(BEFORE, JSON.stringify(rows, null, 1))
  console.log(`BEFORE captured -> ${BEFORE.pathname} (${rows.length} rows)`)
}

const reproduced: Row[] = []
const notReproduced: Array<Record<string, string>> = []
let alreadyNew = 0
for (const row of rows) {
  if (row.fingerprint === newFingerprint(row)) { alreadyNew += 1; continue }
  if (oldFingerprint(row) === row.fingerprint) reproduced.push(row)
  else notReproduced.push({ id: row.id, stored: row.fingerprint.slice(0, 16), recomputedOld: oldFingerprint(row).slice(0, 16), channel: row.channel, operation: row.operation })
}
const before = {
  rows: rows.length,
  distinctFingerprints: new Set(rows.map((r) => r.fingerprint)).size,
  occurrences: rows.reduce((n, r) => n + r.count, 0),
  byStatus: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.resolutionStatus]: (acc[r.resolutionStatus] ?? 0) + 1 }), {}),
}
const projected = new Set(rows.map((r) => (reproduced.some((x) => x.id === r.id) ? newFingerprint(r) : r.fingerprint)))
console.log(JSON.stringify({ alreadyOnTheNewDelimiter: alreadyNew, reproducedUnderTheOldDelimiter: reproduced.length, notReproduced: notReproduced.length, before, projectedDistinctFingerprints: projected.size, groupCountsIdentical: projected.size === before.distinctFingerprints }, null, 1))
if (notReproduced.length) console.log('NOT REPRODUCED (left untouched):', JSON.stringify(notReproduced, null, 1))

if (mode === 'apply') {
  if (projected.size !== before.distinctFingerprints) { console.error('REFUSING to apply — the projected group count is not identical'); await prisma.$disconnect(); process.exit(5) }
  for (const row of reproduced) await prisma.syncLogErrorGroup.update({ where: { id: row.id }, data: { fingerprint: newFingerprint(row) } })
  await new Promise((r) => setTimeout(r, 8500))
  const after = (await prisma.syncLogErrorGroup.findMany({ orderBy: { id: 'asc' } })) as unknown as Row[]
  console.log(JSON.stringify({
    written: reproduced.length,
    readBackAt: new Date().toISOString(),
    afterRows: after.length,
    afterDistinctFingerprints: new Set(after.map((r) => r.fingerprint)).size,
    afterOccurrences: after.reduce((n, r) => n + r.count, 0),
    afterByStatus: after.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.resolutionStatus]: (acc[r.resolutionStatus] ?? 0) + 1 }), {}),
    rowsStillNotMatchingTheWriter: after.filter((r) => r.fingerprint !== newFingerprint(r)).length,
    everyRewrittenRowMatchesTheLiveWriter: reproduced.every((r) => after.find((a) => a.id === r.id)!.fingerprint === newFingerprint(r)),
  }, null, 1))
}
await prisma.$disconnect()
