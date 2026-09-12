/** Read-only audit of every nondeleted product's Amazon/eBay listing coordinate. */
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.ts'
import { resolveBatch } from '../../../apps/api/src/services/pim/mapping/resolve-batch.service.ts'
const report: any = { checkedAt: new Date().toISOString(), listingWrites: 0, listings: [], failures: [] }
try {
  const rows = await prisma.channelListing.findMany({ where: { channel: { in: ['AMAZON', 'EBAY'] }, product: { deletedAt: null } },
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = JSON.stringify([row.channel, row.marketplace, row.channelConnectionId, row.aliasKey])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const group of groups.values()) {
    const first = group[0]
    if (!first.channelConnectionId || !first.marketplace) {
      report.failures.push({ ids: group.map(l => l.id), error: 'The listing has no exact account or marketplace' })
      continue
    }
    for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50)
      try {
        const result = await resolveBatch({ channel: first.channel, marketplace: first.marketplace!, channelConnectionId: first.channelConnectionId ?? undefined, aliasKey: first.aliasKey, productIds: batch.map(l => l.productId) })
        for (const product of result.products) {
          const listing = batch.find(l => l.productId === product.productId)!
          report.listings.push({ ...listing, sku: product.sku, category: product.category, readiness: product.readiness, counts: product.counts,
            issues: Object.values(product.cells).filter(c => c.errors.length || c.needsTranslation).map(c => ({ field: c.fieldKey, required: c.required, missing: c.value == null || c.value === '' || Array.isArray(c.value) && !c.value.length, source: c.rule?.source ?? null, errors: c.errors, translationPending: !!c.needsTranslation })) })
        }
      } catch (error: any) { report.failures.push({ channel: first.channel, marketplace: first.marketplace, ids: batch.map(l => l.id), error: String(error?.message ?? error) }) }
      await writeFile('/tmp/nexus-product-readiness.json', JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify({ audited: report.listings.length, total: rows.length, failures: report.failures.length }))
    }
  }
  const fields = new Map<string, number>()
  for (const listing of report.listings) for (const issue of listing.issues) fields.set(`${listing.channel}:${issue.field}`, (fields.get(`${listing.channel}:${issue.field}`) ?? 0) + 1)
  report.summary = { total: rows.length, audited: report.listings.length, blocked: report.listings.filter((l: any) => l.readiness?.state === 'blocked').length,
    unclassified: report.listings.filter((l: any) => !l.category.channelCategoryId).map((l: any) => ({ id: l.id, sku: l.sku, channel: l.channel, marketplace: l.marketplace })),
    issueFrequency: Object.fromEntries([...fields].sort((a,b) => b[1] - a[1])) }
  await writeFile('/tmp/nexus-product-readiness.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report.summary))
  if (report.failures.length) process.exitCode = 1
} catch (error: any) {
  console.error(error?.code ?? error?.name ?? 'audit_failed'); process.exitCode = 1
} finally { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) }
