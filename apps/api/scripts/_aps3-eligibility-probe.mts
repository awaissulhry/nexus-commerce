/** APS.3 — READ-ONLY: does Amazon actually answer /eligibility/product/list?
 *
 *  The contract was reconstructed from a third-party doc mirror because
 *  advertising.amazon.com renders its API docs client-side. Before any UI is
 *  built on it, prove the path, the body shape, the response shape and the
 *  entitlement against the real IT profile with real ASINs.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const { listProductEligibility } = await import('../src/services/advertising/ads-api-client.js')
const { getProductEligibility } = await import('../src/services/advertising/ads-eligibility.service.js')

L('══ MODE ══════════════════════════════════════════════════════════')
const { adsMode } = await import('../src/services/advertising/ads-api-client.js')
L(`  adsMode = ${adsMode()}`)

const conn = await p.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true },
  select: { profileId: true, region: true, mode: true, accountLabel: true },
})
L(`  IT profile = ${conn?.profileId} (${conn?.mode}, ${conn?.accountLabel})`)
if (!conn) { L('  no IT connection — stopping'); await prisma.$disconnect(); process.exit(0) }

// Real child ASINs that are live on Amazon IT.
const rows = await p.productReadCache.findMany({
  where: { deletedAt: null, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] }, parentId: { not: null } },
  select: { sku: true, asin: true },
  take: 6,
  orderBy: { sku: 'asc' },
})
L(`\n══ PROBE ASINS (real, live on AMAZON_IT) ═════════════════════════`)
for (const r of rows) L(`  ${String(r.sku).padEnd(34)} ${r.asin}`)

L('\n══ RAW CALL — POST /eligibility/product/list (adType=sp) ═════════')
try {
  const res = await listProductEligibility(
    { profileId: conn.profileId, region: (conn.region ?? 'EU') as 'EU' },
    { products: rows.map((r: any) => ({ asin: r.asin })), adType: 'sp' },
  )
  L(`  returned ${res.length} record(s)`)
  L(`  RAW first record: ${JSON.stringify(res[0], null, 2)}`)
  for (const r of res) {
    const names = (r.eligibilityStatusList ?? []).map((s: any) => `${s.name}(${s.severity})`).join(', ')
    L(`    ${String(r.asin ?? '—').padEnd(12)} ${String(r.overallStatus).padEnd(22)} ${names || '—'}`)
  }
} catch (e) {
  L(`  ✗ FAILED: ${e instanceof Error ? e.message.slice(0, 400) : e}`)
}

L('\n══ OTHER AD TYPES ════════════════════════════════════════════════')
for (const adType of ['sb', 'sd', 'dsp'] as const) {
  try {
    const res = await listProductEligibility(
      { profileId: conn.profileId, region: (conn.region ?? 'EU') as 'EU' },
      { products: [{ asin: rows[0]?.asin }], adType },
    )
    L(`  ${adType.padEnd(4)} → ${res[0]?.overallStatus ?? 'no record'}  ${(res[0]?.eligibilityStatusList ?? []).map((s: any) => s.name).join(',') || ''}`)
  } catch (e) {
    L(`  ${adType.padEnd(4)} ✗ ${e instanceof Error ? e.message.slice(0, 160) : e}`)
  }
}

L('\n══ VARIATION PARENT — expect INELIGIBLE/VARIATION_PARENT ═════════')
const parent = await p.productReadCache.findFirst({
  where: { deletedAt: null, parentId: null, childCount: { gt: 0 }, asin: { not: null }, rollupChannelKeys: { hasSome: ['AMAZON_IT'] } },
  select: { sku: true, asin: true },
})
if (parent) {
  L(`  parent ${parent.sku} → ${parent.asin}`)
  try {
    const res = await listProductEligibility(
      { profileId: conn.profileId, region: (conn.region ?? 'EU') as 'EU' },
      { products: [{ asin: parent.asin }], adType: 'sp' },
    )
    L(`    ${res[0]?.overallStatus} — ${(res[0]?.eligibilityStatusList ?? []).map((s: any) => s.name).join(',') || '—'}`)
  } catch (e) { L(`    ✗ ${e instanceof Error ? e.message.slice(0, 200) : e}`) }
}

L('\n══ SERVICE WRAPPER (cache + degradation) ═════════════════════════')
const rep = await getProductEligibility({ marketplace: 'IT', asins: rows.map((r: any) => r.asin), adType: 'sp' })
L(`  degraded=${rep.degraded}${rep.degradedReason ? ` (${rep.degradedReason})` : ''}`)
for (const [asin, v] of Object.entries(rep.items)) {
  L(`    ${asin.padEnd(12)} ${String((v as any).status).padEnd(22)} ${(v as any).reasons.map((x: any) => x.name).join(',') || '—'}${(v as any).unknownReason ? ` [${(v as any).unknownReason}]` : ''}`)
}
const t0 = Date.now()
await getProductEligibility({ marketplace: 'IT', asins: rows.map((r: any) => r.asin), adType: 'sp' })
L(`  second call (cached): ${Date.now() - t0}ms`)

await prisma.$disconnect()
