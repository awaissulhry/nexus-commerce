/**
 * NEG.1 — is `AdTarget.expressionType` being rewritten right now? READ-ONLY.
 *
 * Three reads of the same column inside one day disagree:
 *   study, 2026-08-11        EXACT 1,393 · PHRASE 579 · _EXACT 32 · _PHRASE 30
 *   _neg-page-audit, 00:47   EXACT 1,184 · PHRASE 491 · _EXACT 241 · _PHRASE 118
 *   _neg1-baseline,  00:52   EXACT   915 · PHRASE 413 · _EXACT 510 · _PHRASE 196
 *
 * Either the column is churning, or one of the three scripts is lying. This decides it, and if it
 * is churning it says how fast and which rows move — because a page that FILTERS on this column
 * would return a different row set every few minutes.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const sample = async () => {
  const rows = await prisma.adTarget.groupBy({
    by: ['expressionType'],
    where: { isNegative: true },
    _count: { _all: true },
  })
  return rows
    .map((r) => [String(r.expressionType), r._count._all] as const)
    .sort((a, b) => b[1] - a[1])
}

const t0 = Date.now()
const a = await sample()
console.log(`\nt=0s   ${a.map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

// Two more reads, 45s apart. If the totals move, the column is live.
for (const wait of [45, 45]) {
  await new Promise((r) => setTimeout(r, wait * 1000))
  const s = await sample()
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s  ${s.map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
}

// Which rows carry the underscore form — and do they share a recent lastSyncedAt?
const under = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionType: { startsWith: '_' } },
  select: { expressionType: true, lastSyncedAt: true, updatedAt: true, externalTargetId: true, negativeLevel: true },
})
const plain = await prisma.adTarget.findMany({
  where: { isNegative: true, expressionType: { in: ['EXACT', 'PHRASE'] } },
  select: { expressionType: true, lastSyncedAt: true, updatedAt: true, externalTargetId: true, negativeLevel: true },
})
const newest = (xs: { lastSyncedAt: Date | null }[]) =>
  xs.map((x) => x.lastSyncedAt?.toISOString() ?? 'null').sort().slice(-1)[0]
const oldest = (xs: { lastSyncedAt: Date | null }[]) =>
  xs.map((x) => x.lastSyncedAt?.toISOString() ?? 'null').sort()[0]

console.log(`\nunderscored rows: ${int(under.length)}  lastSyncedAt ${oldest(under)} → ${newest(under)}`)
console.log(`plain rows:       ${int(plain.length)}  lastSyncedAt ${oldest(plain)} → ${newest(plain)}`)

// The decisive question for the page: does a filter written against one spelling lose rows?
const exactOnly = await prisma.adTarget.count({ where: { isNegative: true, expressionType: 'EXACT' } })
const exactBoth = await prisma.adTarget.count({ where: { isNegative: true, expressionType: { in: ['EXACT', '_EXACT', 'NEGATIVE_EXACT'] } } })
console.log(`\nWHERE expressionType = 'EXACT'                          → ${int(exactOnly)} rows`)
console.log(`WHERE expressionType IN (EXACT, _EXACT, NEGATIVE_EXACT) → ${int(exactBoth)} rows`)
console.log(`a single-spelling filter loses ${int(exactBoth - exactOnly)} rows, and the number moves.`)

await prisma.$disconnect()
