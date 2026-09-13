/**
 * LX.FIN item 3 (R-LX-23) — recompute every stored `SyncLogErrorGroup.fingerprint` for the delimiter
 * R-LX-19 changed (a literal NUL byte 0x00 -> the unit separator 0x1F), so existing groups do NOT split
 * on the first deploy and a RESOLVED suppression is not silently lost.
 *
 *   npx tsx apps/api/scripts/_lxfin-fingerprints.mts             rehearse (no write)
 *   npx tsx apps/api/scripts/_lxfin-fingerprints.mts --apply     write
 *   npx tsx apps/api/scripts/_lxfin-fingerprints.mts --restore    replay the captured BEFORE by value
 *
 * 🔴 THE FAITHFULNESS CONTROL, and why this is not a rename. A fingerprint is a hash: it cannot be
 * converted, only RECOMPUTED from the row's own stored components (`channel`, `operation`, `errorType`,
 * `errorCode`, `normaliseMessage(sampleMessage)`). Whether that recomputation reproduces the STORED
 * value under the OLD delimiter is a measurable fact, so this script measures it first and rewrites only
 * the rows where it does. A row that does not reproduce is reported and LEFT ALONE — its stored hash came
 * from a message the row no longer carries (`sampleMessage` is refreshed to the latest example on every
 * occurrence, and is truncated at 1,000 characters), and inventing a new hash for it would move a group
 * an operator may have RESOLVED without anyone being able to see that it happened.
 *
 * The normaliser is the SERVICE'S OWN (exported for this), not a copy: a backfill that normalises
 * differently from the writer is measuring a different function from the one that produced the value.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const { default: prisma } = await import('../src/db.js')
const { fingerprintError, normaliseMessage } = await import('../src/services/error-grouping.service.js')

const BEFORE = new URL('../../../docs/audits/2026-09-13-lx-fin/error-grouping-fingerprints-before.json', import.meta.url)
const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--restore') ? 'restore' : 'rehearse'

const db = (await prisma.$queryRawUnsafe<Array<{ current_database: string }>>('SELECT current_database()::text AS current_database'))[0]
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
console.log(`MODE ${mode} · DISCRIMINATOR current_database=${db.current_database} GALE-JACKET Product.version=${gale?.version}`)
if (db.current_database !== 'nexus_development' || gale?.version !== 59) {
  console.error('REFUSING — this is not the local Docker database')
  process.exit(2)
}

/** Verbatim from `git show HEAD:apps/api/src/services/error-grouping.service.ts` — a raw NUL byte. */
const OLD_DELIMITER = '\u0000'

function oldFingerprint(row: { channel: string; operation: string; errorType: string | null; errorCode: string | null; sampleMessage: string | null }): string {
  const parts = [
    row.channel,
    row.operation,
    row.errorType ?? '<no-type>',
    row.errorCode ?? '<no-code>',
    row.sampleMessage ? normaliseMessage(row.sampleMessage) : '<no-message>',
  ]
  return createHash('sha256').update(parts.join(OLD_DELIMITER)).digest('hex')
}

/**
 * 🔴 `fingerprintError` takes an `ErrorOccurrence`, whose message field is `message` — the STORED row
 * calls it `sampleMessage`. The first run of this script passed the row straight in, so every "new"
 * hash was computed over `<no-message>` and 74 groups projected to 50. The faithfulness control below
 * caught it and refused (`groupCountsIdentical: false`); without that control this script would have
 * MERGED 24 groups on the first deploy while reporting success. The adapter is one line and it is here,
 * once, so the two hashes are over the same five parts by construction.
 */
const newFingerprint = (row: { channel: string; operation: string; errorType: string | null; errorCode: string | null; sampleMessage: string | null }) =>
  fingerprintError({ channel: row.channel, operation: row.operation, errorType: row.errorType, errorCode: row.errorCode, message: row.sampleMessage })

const rows = await prisma.syncLogErrorGroup.findMany({ orderBy: { id: 'asc' } })
console.log(`rows ${rows.length}`)

if (mode === 'restore') {
  if (!existsSync(BEFORE)) { console.error('No BEFORE capture to restore from'); process.exit(3) }
  const before = JSON.parse(readFileSync(BEFORE, 'utf8')) as Array<{ id: string; fingerprint: string }>
  for (const row of before) await prisma.syncLogErrorGroup.update({ where: { id: row.id }, data: { fingerprint: row.fingerprint } })
  await new Promise((r) => setTimeout(r, 8500))
  const after = await prisma.syncLogErrorGroup.findMany({ select: { id: true, fingerprint: true }, orderBy: { id: 'asc' } })
  const exact = after.length === before.length && before.every((b) => after.find((a) => a.id === b.id)?.fingerprint === b.fingerprint)
  console.log(`restored ${before.length}; read back at ${new Date().toISOString()}; BY-VALUE EXACT: ${exact}`)
  await prisma.$disconnect()
  process.exit(exact ? 0 : 4)
}

if (!existsSync(BEFORE)) {
  writeFileSync(BEFORE, JSON.stringify(rows, null, 1))
  console.log(`BEFORE captured -> docs/audits/2026-09-13-lx-fin/error-grouping-fingerprints-before.json (${rows.length} rows)`)
}

const reproduced: typeof rows = []
const notReproduced: Array<{ id: string; stored: string; recomputedOld: string; channel: string; operation: string }> = []
let alreadyNew = 0
for (const row of rows) {
  if (row.fingerprint === newFingerprint(row)) { alreadyNew += 1; continue }
  if (oldFingerprint(row) === row.fingerprint) reproduced.push(row)
  else notReproduced.push({ id: row.id, stored: row.fingerprint.slice(0, 16), recomputedOld: oldFingerprint(row).slice(0, 16), channel: row.channel, operation: row.operation })
}

/* Before/after GROUP COUNTS must be identical: the whole point is that nothing splits or merges. */
const before = {
  rows: rows.length,
  distinctFingerprints: new Set(rows.map((r) => r.fingerprint)).size,
  byStatus: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.resolutionStatus]: (acc[r.resolutionStatus] ?? 0) + 1 }), {}),
  occurrences: rows.reduce((n, r) => n + r.count, 0),
}
const projected = new Set(rows.map((r) => (reproduced.some((x) => x.id === r.id) ? newFingerprint(r) : r.fingerprint)))
console.log(JSON.stringify({
  alreadyOnTheNewDelimiter: alreadyNew,
  reproducedUnderTheOldDelimiter: reproduced.length,
  notReproduced: notReproduced.length,
  before,
  projectedDistinctFingerprints: projected.size,
  groupCountsIdentical: projected.size === before.distinctFingerprints,
}, null, 1))
if (notReproduced.length) console.log('NOT REPRODUCED (left untouched):', JSON.stringify(notReproduced.slice(0, 10), null, 1))

if (mode === 'apply') {
  if (projected.size !== before.distinctFingerprints) { console.error('REFUSING to apply — the projected group count is not identical'); await prisma.$disconnect(); process.exit(5) }
  let written = 0
  for (const row of reproduced) { await prisma.syncLogErrorGroup.update({ where: { id: row.id }, data: { fingerprint: newFingerprint(row) } }); written += 1 }
  await new Promise((r) => setTimeout(r, 8500))
  const after = await prisma.syncLogErrorGroup.findMany({ orderBy: { id: 'asc' } })
  const stillOld = after.filter((r) => r.fingerprint !== newFingerprint(r)).length
  console.log(JSON.stringify({
    written,
    readBackAt: new Date().toISOString(),
    afterRows: after.length,
    afterDistinctFingerprints: new Set(after.map((r) => r.fingerprint)).size,
    afterByStatus: after.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.resolutionStatus]: (acc[r.resolutionStatus] ?? 0) + 1 }), {}),
    afterOccurrences: after.reduce((n, r) => n + r.count, 0),
    rowsStillNotMatchingTheWriter: stillOld,
    // 🔴 POSITIVE CONTROL: every rewritten row must now equal what the LIVE writer would produce for
    // the next occurrence of the same error — which is the only thing that stops a new group opening.
    everyRewrittenRowMatchesTheLiveWriter: reproduced.every((r) => after.find((a) => a.id === r.id)!.fingerprint === newFingerprint(r)),
  }, null, 1))
}
await prisma.$disconnect()
