/** APS.3 — READ-ONLY probe of Amazon's /eligibility/product/list.
 *
 *  Imports ONLY ads-api-client: pulling in ads-eligibility.service drags in
 *  ads-cache → queue → Redis, which is unreachable from a laptop and floods
 *  reconnects. Run with NEXUS_AMAZON_ADS_MODE=live to hit the real API — this
 *  is a lookup, it creates nothing.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const { listProductEligibility, adsMode } = await import('../src/services/advertising/ads-api-client.js')
L(`adsMode = ${adsMode()}`)

const conn = await p.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true },
  select: { profileId: true, region: true, mode: true, accountLabel: true },
})
L(`IT profile = ${conn?.profileId} (${conn?.mode}, ${conn?.accountLabel})\n`)

const kids = await p.productReadCache.findMany({
  where: { deletedAt: null, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] }, parentId: { not: null } },
  select: { sku: true, asin: true }, take: 5, orderBy: { sku: 'asc' },
})
const parent = await p.productReadCache.findFirst({
  where: { deletedAt: null, parentId: null, childCount: { gt: 0 }, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] } },
  select: { sku: true, asin: true },
})

const ctx = { profileId: conn.profileId, region: (conn.region ?? 'EU') as 'EU' }

L('══ CHILD ASINS (adType=sp) ═══════════════════════════════════════')
try {
  const res = await listProductEligibility(ctx, { products: kids.map((k: any) => ({ asin: k.asin })), adType: 'sp' })
  L(`  ${res.length} record(s)`)
  L(`  RAW[0] = ${JSON.stringify(res[0])}`)
  for (const r of res) {
    const names = (r.eligibilityStatusList ?? []).map((s: any) => `${s.name}(${s.severity})`).join(', ')
    L(`    ${String(r.asin ?? '—').padEnd(12)} ${String(r.overallStatus).padEnd(22)} ${names || '—'}`)
  }
} catch (e) { L(`  ✗ ${e instanceof Error ? e.message.slice(0, 500) : e}`) }

L('\n══ VARIATION PARENT (expect INELIGIBLE / VARIATION_PARENT) ═══════')
if (parent) {
  L(`  ${parent.sku} → ${parent.asin}`)
  try {
    const res = await listProductEligibility(ctx, { products: [{ asin: parent.asin }], adType: 'sp' })
    L(`    ${res[0]?.overallStatus} — ${(res[0]?.eligibilityStatusList ?? []).map((s: any) => `${s.name}(${s.severity})`).join(', ') || '—'}`)
    L(`    RAW = ${JSON.stringify(res[0])}`)
  } catch (e) { L(`    ✗ ${e instanceof Error ? e.message.slice(0, 300) : e}`) }
}

L('\n══ OTHER AD TYPES ════════════════════════════════════════════════')
for (const adType of ['sb', 'sd', 'dsp'] as const) {
  try {
    const res = await listProductEligibility(ctx, { products: [{ asin: kids[0]?.asin }], adType })
    L(`  ${adType.padEnd(4)} → ${res[0]?.overallStatus ?? 'no record'}  ${(res[0]?.eligibilityStatusList ?? []).map((s: any) => s.name).join(',') || ''}`)
  } catch (e) { L(`  ${adType.padEnd(4)} ✗ ${e instanceof Error ? e.message.slice(0, 220) : e}`) }
}

await prisma.$disconnect()
process.exit(0)
