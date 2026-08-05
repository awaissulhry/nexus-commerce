/**
 * ACR Stage 5 — SB/SD state audit, AMAZON SIDE. READ-ONLY (list calls only, no writes).
 *
 * The companion to _acr5-sbsd-state.mts. Local DB says all 19 SB/SD campaigns are PAUSED;
 * this asks Amazon the same question through the RIGHT endpoint family, because asking
 * /sp/* about SD returns nothing and reads as "deleted" (the trap that cost two wrong
 * diagnoses — see reference_ads_portfolio_membership_truth).
 *
 *   SD: GET  /sd/campaigns?campaignIdFilter=…   plain JSON
 *   SB: POST /sb/v4/campaigns/list              v4 mime
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sbsd-amazon.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { listSdCampaigns, listSbCampaigns } = await import('../src/services/advertising/ads-api-client.js')

const locals = await prisma.campaign.findMany({
  where: { adProduct: { in: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] } },
  select: { id: true, name: true, status: true, marketplace: true, adProduct: true, externalCampaignId: true, dailyBudget: true },
  orderBy: [{ adProduct: 'asc' }, { marketplace: 'asc' }],
})

const byMarket = new Map<string, typeof locals>()
for (const c of locals) {
  if (!byMarket.has(c.marketplace)) byMarket.set(c.marketplace, [] as unknown as typeof locals)
  byMarket.get(c.marketplace)!.push(c)
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
let agree = 0, disagree = 0, missing = 0, errors = 0

for (const [marketplace, rows] of byMarket) {
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true }, select: { profileId: true, region: true },
  })
  if (!conn) { console.log(`\n${marketplace}: no active ads connection — SKIP (${rows.length} local campaigns unverifiable)`); continue }
  const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }

  for (const product of ['SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] as const) {
    const mine = rows.filter(r => r.adProduct === product)
    if (!mine.length) continue
    const ids = mine.map(r => r.externalCampaignId).filter((x): x is string => !!x)
    console.log(`\n── ${marketplace} · ${product} · ${mine.length} local, asking Amazon for ${ids.length} ──`)
    let remote: Array<{ campaignId: string; name?: string; state?: string; budget?: { budget?: number } }> = []
    try {
      remote = product === 'SPONSORED_DISPLAY'
        ? await listSdCampaigns(ctx, { externalCampaignIds: ids })
        : await listSbCampaigns(ctx, { externalCampaignIds: ids })
    } catch (e: any) {
      errors++; console.log(`  ✖ read FAILED: ${e?.message ?? e}`); continue
    }
    const remoteById = new Map(remote.map(r => [String(r.campaignId), r]))
    console.log('  ' + pad('CAMPAIGN', 34) + pad('LOCAL', 10) + pad('AMAZON', 12) + pad('BUDGET l/a', 16) + 'VERDICT')
    for (const l of mine) {
      const r = l.externalCampaignId ? remoteById.get(l.externalCampaignId) : undefined
      const amazonState = r?.state ?? '(absent)'
      const localState = String(l.status)
      let verdict: string
      if (!r) { verdict = 'NOT RETURNED BY AMAZON'; missing++ }
      else if (amazonState.toUpperCase() === localState.toUpperCase()) { verdict = 'agree'; agree++ }
      else { verdict = `DISAGREE  local=${localState} amazon=${amazonState}`; disagree++ }
      const lb = l.dailyBudget == null ? '—' : String(l.dailyBudget)
      const rb = r?.budget?.budget == null ? '—' : String(r.budget.budget)
      console.log('  ' + pad(l.name, 34) + pad(localState, 10) + pad(amazonState, 12) + pad(`${lb}/${rb}`, 16) + verdict)
    }
    const extra = remote.filter(r => !ids.includes(String(r.campaignId)))
    if (extra.length) console.log(`  ⚠ Amazon returned ${extra.length} campaign(s) we did not ask about`)
  }
}

console.log(`\n═══ VERDICT ═══  agree=${agree}  disagree=${disagree}  notReturned=${missing}  readErrors=${errors}`)
console.log(missing === 0 && errors === 0
  ? 'Every local SB/SD campaign exists on Amazon. Local state is not a phantom.'
  : 'Some campaigns could not be confirmed on Amazon — investigate before any revival.')
await prisma.$disconnect(); process.exit(0)
