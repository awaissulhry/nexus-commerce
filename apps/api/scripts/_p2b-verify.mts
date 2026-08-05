/**
 * Part 2a/2b verification against the PROD database.
 *
 * Writes only to the ImportJob / ImportJobRow staging tables — never to a
 * campaign, ad group, target or product ad — and deletes the job at the end.
 * buildPreview is read-only with respect to the ad tables by construction.
 *
 * Proves, on real rows:
 *   Part 2a — Campaign negative keyword / Product targeting / Negative product
 *             targeting resolve and diff instead of reporting UNSUPPORTED.
 *   Part 2b — Product ad resolves, diffs on State, and reports UNCHANGED when
 *             the file matches the DB.
 */
const { default: prisma } = await import('../src/db.js')
const { buildPreview } = await import('../src/services/advertising/bulksheet/preview.js')
const { buildRowKey } = await import('@nexus/shared/ads-bulksheet')

const jobId = `p2b-verify-${process.pid}`

const pa = await prisma.adProductAd.findFirst({
  where: { externalAdId: { not: null } },
  select: { id: true, externalAdId: true, sku: true, status: true },
})
// All 20 campaign-level negatives in this account have a NULL externalTargetId —
// they were never synced out. So this one can only resolve through _row_key,
// which makes it the fixture that actually exercises the AX-ZD.9 join path.
const negCamp = await prisma.adTarget.findFirst({
  where: { isNegative: true, kind: 'KEYWORD', negativeLevel: 'CAMPAIGN' },
  select: { id: true, externalTargetId: true, expressionValue: true, status: true, bidCents: true },
})
const prodTgt = await prisma.adTarget.findFirst({
  where: { externalTargetId: { not: null }, isNegative: false, kind: 'PRODUCT' },
  select: { id: true, externalTargetId: true, expressionValue: true, status: true, bidCents: true },
})
const negProd = await prisma.adTarget.findFirst({
  where: { externalTargetId: { not: null }, isNegative: true, kind: 'PRODUCT' },
  select: { id: true, externalTargetId: true, expressionValue: true, status: true, bidCents: true },
})

console.log('fixtures:',
  'productAd=', pa?.externalAdId ?? 'NONE',
  '| campNeg=', negCamp?.externalTargetId ?? 'NONE',
  '| prodTgt=', prodTgt?.externalTargetId ?? 'NONE',
  '| negProd=', negProd?.externalTargetId ?? 'NONE')

const flip = (s: string | null): string => (s === 'ENABLED' ? 'paused' : 'enabled')
const eur = (c: number): string => (c / 100).toFixed(2)

type Row = { rowIndex: number; entity: string; rowKey?: string; values: Record<string, string> }
const rows: Row[] = []
let i = 0
if (pa) {
  // Edited: State flipped. Expect UPDATE with a State diff.
  rows.push({ rowIndex: i++, entity: 'Product ad', values: { Product: 'Sponsored Products', Entity: 'Product ad', Operation: 'Update', 'Ad ID': pa.externalAdId!, State: flip(pa.status) } })
  // Untouched: State as the DB holds it. Expect UNCHANGED, not UNSUPPORTED.
  rows.push({ rowIndex: i++, entity: 'Product ad (unchanged)', values: { Product: 'Sponsored Products', Entity: 'Product ad', Operation: 'Update', 'Ad ID': pa.externalAdId!, State: (pa.status ?? '').toLowerCase() } })
}
for (const [label, t, idCol] of [
  ['Campaign negative keyword', negCamp, 'Keyword ID'],
  ['Product targeting', prodTgt, 'Product Targeting ID'],
  ['Negative product targeting', negProd, 'Product Targeting ID'],
] as const) {
  if (!t) continue
  rows.push({
    rowIndex: i++, entity: label + (t.externalTargetId ? '' : ' (via _row_key)'),
    rowKey: buildRowKey({ entity: label, externalId: t.externalTargetId, localId: t.id }),
    values: { Product: 'Sponsored Products', Entity: label, Operation: 'Update', [idCol]: t.externalTargetId ?? '', State: flip(t.status), Bid: eur(t.bidCents) },
  })
}

await prisma.importJob.create({
  data: {
    id: jobId, jobName: 'p2b-verify', fileKind: 'xlsx', targetEntity: 'ADS_BULKSHEET',
    filename: 'p2b-verify.xlsx', status: 'VALIDATED', totalRows: rows.length,
  },
})
await prisma.importJobRow.createMany({
  data: rows.map((r) => ({
    jobId, rowIndex: r.rowIndex, status: 'PENDING',
    parsedValues: { entity: r.values.Entity, operation: 'Update', rowKey: r.rowKey ?? '', baseline: '', values: r.values } as object,
  })),
})

try {
  const preview = await buildPreview(prisma, jobId)
  console.log('\ncounts:', JSON.stringify(preview.counts))
  console.log('')
  for (const r of preview.rows) {
    const label = rows.find((x) => x.rowIndex === r.rowIndex)?.entity ?? r.entity
    const diffs = r.diffs.map((d) => `${d.field}: ${d.current} -> ${d.next}`).join(', ') || '-'
    console.log(`${label.padEnd(30)} status=${r.status.padEnd(11)} target=${r.targetId ? 'resolved' : 'NULL'} label=${(r.label || '-').slice(0, 22).padEnd(22)} diffs=[${diffs}] ${r.note ?? ''}`)
  }
  const unsupported = preview.rows.filter((r) => r.status === 'UNSUPPORTED')
  console.log(`\nUNSUPPORTED rows: ${unsupported.length} (expected 0)`)
  console.log(unsupported.length === 0 ? 'PASS' : 'FAIL')
} finally {
  await prisma.importJobRow.deleteMany({ where: { jobId } })
  await prisma.importJob.delete({ where: { id: jobId } })
  console.log('\nstaging job removed')
}
