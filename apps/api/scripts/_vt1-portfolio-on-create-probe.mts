/**
 * AX-VT.1 — settle the docs question empirically: does Amazon's SP v3
 * POST /sp/campaigns honour `portfolioId` at CREATE time?
 *
 * Amazon's public docs are unclear (portfolioId is documented optional on
 * Sponsored Brands create; the SP v3 create schema isn't published in a form
 * that says either way). So we ask Amazon directly instead of guessing.
 *
 * SAFETY: creates ONE campaign, state=PAUSED, budget €1, name prefixed
 * NEXUS-VT1-PROBE, then reads it back and ARCHIVES it in the same run. A paused
 * campaign with no ad group and no targets cannot serve or spend under any
 * circumstance. Set KEEP=1 to skip the archive.
 */
process.env.NEXUS_AMAZON_ADS_MODE = 'live'

const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)

const PORTFOLIO_ID = process.env.PF ?? '190601227863497' // IT AIREON
const MARKETPLACE = process.env.MKT ?? 'IT'

const { createCampaign, listCampaignsV3, updateCampaign, adsMode } = await import('../src/services/advertising/ads-api-client.js')
L(`ads mode: ${adsMode()}`)
if (adsMode() !== 'live') { L('ABORT: not in live mode'); process.exit(1) }

const conn = await p.amazonAdsConnection.findFirst({
  where: { marketplace: MARKETPLACE, isActive: true, mode: 'production' },
  select: { profileId: true, region: true },
})
if (!conn) { L(`ABORT: no production connection for ${MARKETPLACE}`); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region ?? 'EU') as 'EU' }
L(`profile ${ctx.profileId} region ${ctx.region}  portfolio ${PORTFOLIO_ID}`)

const name = `NEXUS-VT1-PROBE-${Date.now().toString(36)}`
L(`\n── CREATE (paused, €1) with portfolioId in the body ──`)
const created = await createCampaign(ctx, {
  name, targetingType: 'MANUAL', dailyBudget: 1, state: 'paused',
  biddingStrategy: 'legacyForSales', portfolioId: PORTFOLIO_ID,
})
L(`  externalId: ${created.externalId}`)
if (!created.externalId) {
  L(`  RAW: ${JSON.stringify(created.rawResponse).slice(0, 1200)}`)
  L('\n>>> VERDICT: create REJECTED. Amazon did not accept the campaign at all.')
  L('>>> If the error names portfolioId, the field is not creatable → use create-then-PATCH.')
  process.exit(0)
}

L(`\n── READ BACK ──`)
const back = await listCampaignsV3(ctx, { campaignIds: [created.externalId] })
const row = back.find((c) => c.campaignId === created.externalId)
L(`  found: ${!!row}`)
L(`  name:  ${row?.name}`)
L(`  state: ${row?.state}`)
L(`  portfolioId reported by Amazon: ${JSON.stringify(row?.portfolioId ?? null)}`)

const stuck = String(row?.portfolioId ?? '') === PORTFOLIO_ID
L(`\n>>> VERDICT: portfolioId on CREATE is ${stuck ? 'HONOURED ✓ — single-call path is correct' : 'IGNORED ✗ — create-then-PATCH fallback is required'}`)

if (!stuck) {
  L(`\n── FALLBACK CHECK: does PATCH set it? ──`)
  const pr = await updateCampaign(ctx, created.externalId, { portfolioId: PORTFOLIO_ID })
  L(`  patch ok=${pr.ok} error=${pr.error ?? 'none'}`)
  const back2 = await listCampaignsV3(ctx, { campaignIds: [created.externalId] })
  const pid2 = back2.find((c) => c.campaignId === created.externalId)?.portfolioId ?? null
  L(`  portfolioId after PATCH: ${JSON.stringify(pid2)}  → ${String(pid2 ?? '') === PORTFOLIO_ID ? 'PATCH WORKS ✓' : 'PATCH ALSO FAILED ✗'}`)
}

if (process.env.KEEP === '1') { L('\nKEEP=1 — leaving the probe campaign in place.') }
else {
  L(`\n── ARCHIVE the probe campaign ──`)
  const ar = await updateCampaign(ctx, created.externalId, { state: 'archived' })
  L(`  archived ok=${ar.ok} error=${ar.error ?? 'none'}`)
}
L(`\nprobe campaign: ${name} / ${created.externalId}`)
process.exit(0)
