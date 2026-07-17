// READ-ONLY forensics: recent Amazon flat-file feed errors (esp. parent SKUs),
// eBay push jobs, and eBay image publish job failures.
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default

const trim = (s: unknown, n = 220) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

// ---- Amazon flat-file feed jobs ----
const amz = await prisma.amazonFlatFileFeedJob.findMany({
  orderBy: { submittedAt: 'desc' },
  take: 14,
})
console.log('=== AMAZON FLAT-FILE FEED JOBS (latest 14) ===')
for (const j of amz) {
  const rs = (j.resultSummary ?? {}) as Record<string, unknown>
  console.log(
    `\n[${j.submittedAt.toISOString().slice(0, 16)}] ${j.marketplace} ${j.productType ?? '-'} status=${j.status} skus=${j.skuCount} ` +
      `processed=${rs.messagesProcessed ?? '-'} ok=${rs.messagesSuccessful ?? '-'} warn=${rs.messagesWithWarning ?? '-'} err=${rs.messagesWithError ?? '-'}` +
      (j.errorMessage ? ` FATAL: ${trim(j.errorMessage)}` : ''),
  )
  const per = (j.perSkuResults ?? []) as Array<{ sku?: string; status?: string; code?: string; message?: string }>
  const errs = per.filter(r => r.status === 'error')
  const byCode = new Map<string, { count: number; skus: Set<string>; msg: string }>()
  for (const e of errs) {
    const k = e.code ?? 'NO_CODE'
    const b = byCode.get(k) ?? { count: 0, skus: new Set<string>(), msg: e.message ?? '' }
    b.count++
    if (e.sku) b.skus.add(e.sku)
    byCode.set(k, b)
  }
  for (const [code, b] of byCode) {
    console.log(`  ERR ${code} x${b.count} skus=[${[...b.skus].slice(0, 6).join(', ')}] msg="${trim(b.msg, 260)}"`)
  }
}

// ---- eBay push jobs ----
const ebay = await prisma.ebayPushJob.findMany({ orderBy: { submittedAt: 'desc' }, take: 12 })
console.log('\n\n=== EBAY PUSH JOBS (latest 12) ===')
for (const j of ebay) {
  console.log(
    `\n[${j.submittedAt.toISOString().slice(0, 16)}] mode=${j.mode} markets=${JSON.stringify(j.markets)} status=${j.status} pushed=${j.pushed} failed=${j.failed}` +
      (j.errorMessage ? ` TOP: ${trim(j.errorMessage)}` : ''),
  )
  const per = (j.perSkuResults ?? []) as Array<{ sku?: string; market?: string; status?: string; listingId?: string; message?: string }>
  for (const e of per.filter(r => r.status === 'error').slice(0, 6)) {
    console.log(`  ERR ${e.market ?? '-'} ${e.sku ?? '-'}: "${trim(e.message, 260)}"`)
  }
}

// ---- eBay image publish jobs ----
const img = await prisma.channelImagePublishJob.findMany({
  where: { channel: 'EBAY' },
  orderBy: { submittedAt: 'desc' },
  take: 12,
  select: {
    submittedAt: true, status: true, marketplace: true, errorMessage: true,
    vendorEntityId: true, productId: true, response: true,
  },
})
console.log('\n\n=== EBAY IMAGE PUBLISH JOBS (latest 12) ===')
for (const j of img) {
  console.log(
    `[${j.submittedAt.toISOString().slice(0, 16)}] mkt=${j.marketplace ?? '-'} status=${j.status} vendorId=${j.vendorEntityId ?? '-'} product=${j.productId}` +
      (j.errorMessage ? `\n   ERR: ${trim(j.errorMessage, 300)}` : ''),
  )
  if (j.status === 'FATAL' && j.response) console.log(`   RESP: ${trim(JSON.stringify(j.response), 300)}`)
}

// ---- shared listing memberships (images-modal substrate) ----
const mem = await prisma.sharedListingMembership.groupBy({ by: ['status', 'marketplace'], _count: { _all: true } })
console.log('\n\n=== SHARED LISTING MEMBERSHIPS ===')
console.log(JSON.stringify(mem))

process.exit(0)
