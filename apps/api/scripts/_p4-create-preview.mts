/**
 * Part 4 create-path verification against the PROD database — PREVIEW ONLY.
 *
 * Deliberately stops before apply: applying a create would make a real keyword /
 * product ad on the live Amazon account, which is not something to do as a test.
 * Preview writes nothing to any ad table.
 */
const { default: prisma } = await import('../src/db.js')
const { buildPreview } = await import('../src/services/advertising/bulksheet/preview.js')

const jobId = `p4-create-${process.pid}`
const ag = await prisma.adGroup.findFirst({
  where: { externalAdGroupId: { not: null } },
  select: { id: true, externalAdGroupId: true, name: true, campaign: { select: { externalCampaignId: true } } },
})
if (!ag) { console.log('no ad group with an external id — cannot verify'); process.exit(0) }
console.log(`parent ad group: ${ag.name} (${ag.externalAdGroupId})  campaign=${ag.campaign?.externalCampaignId}`)

const rows = [
  { entity: 'Keyword', values: { 'Ad group ID': ag.externalAdGroupId!, 'Keyword text': 'giacca moto estiva', 'Match type': 'Exact', Bid: '0,85', State: 'enabled' } },
  { entity: 'Negative keyword', values: { 'Ad group ID': ag.externalAdGroupId!, 'Keyword text': 'bambino', 'Match type': 'Negative exact' } },
  { entity: 'Product ad', values: { 'Ad group ID': ag.externalAdGroupId!, SKU: 'XV-TEST-001' } },
  { entity: 'Product targeting', values: { 'Ad group ID': ag.externalAdGroupId!, 'Product targeting expression': 'B07D5GGF8Y', Bid: '0,60' } },
  { entity: 'Campaign negative keyword', values: { 'Campaign ID': ag.campaign?.externalCampaignId ?? '', 'Keyword text': 'usato', 'Match type': 'Negative phrase' } },
  { entity: 'Keyword', values: { 'Ad group ID': '000000000000000', 'Keyword text': 'orphan', 'Match type': 'Exact', Bid: '1,00' } },
]

await prisma.importJob.create({
  data: { id: jobId, jobName: 'p4-create', fileKind: 'xlsx', targetEntity: 'adsBulksheet', status: 'PENDING_PREVIEW', totalRows: rows.length },
})
await prisma.importJobRow.createMany({
  data: rows.map((r, i) => ({
    jobId, rowIndex: i, status: 'PENDING',
    parsedValues: { entity: r.entity, operation: 'Create', rowKey: '', baseline: '', values: { Product: 'Sponsored Products', Entity: r.entity, Operation: 'Create', ...r.values } } as object,
  })),
})

try {
  const p = await buildPreview(prisma, jobId)
  console.log('\ncounts:', JSON.stringify(p.counts), '\n')
  for (const r of p.rows) {
    const d = r.diffs.map((x) => `${x.field}=${x.next}`).join(' ') || '-'
    console.log(`${r.entity.padEnd(28)} ${r.status.padEnd(11)} parent=${(r.parentId ?? 'NULL').padEnd(28)} ${d}${r.note ? '  // ' + r.note : ''}`)
  }
  const created = p.rows.filter((r) => r.status === 'CREATE')
  const ok = created.length === 5 && created.every((r) => r.parentId) && p.counts.unresolved === 1
  console.log(`\n5 CREATE with a parent + 1 UNRESOLVED orphan -> ${ok ? 'PASS' : 'FAIL'}`)
} finally {
  await prisma.importJobRow.deleteMany({ where: { jobId } })
  await prisma.importJob.delete({ where: { id: jobId } })
  console.log('\nstaging job removed — nothing was created')
}
