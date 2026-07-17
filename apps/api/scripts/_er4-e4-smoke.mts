/**
 * ER4 E4 smoke — PRI listing-attach. Sandbox launches (local = sandbox mode):
 * MANUAL → ads land in the first ad group; SMART → campaign-level ads;
 * CPS guards unchanged. Cleanup deletes the sandbox campaigns.
 */
import Fastify from 'fastify'
const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const writes = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-write.service.js')
const app = Fastify()
await app.register(routes, { prefix: '/api' })
let fails = 0
const check = (l: string, ok: boolean, d = '') => { console.log(`${ok ? '✓' : '✗ FAIL'} ${l}${d ? ` — ${d}` : ''}`); if (!ok) fails++ }

const idx = await prisma.ebayListingIndex.findMany({ where: { endedAt: null }, select: { itemId: true }, take: 2 })
const items = idx.map((l) => ({ listingId: l.itemId, resolution: 'include' }))
const madeCampaigns: string[] = []
try {
  // ── MANUAL PRI launch with ad groups + listings ─────────────────────────────
  const r1 = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'hero', name: '_er4e4 manual attach', marketplace: 'EBAY_IT', targetingType: 'MANUAL', dailyBudgetCents: 500,
    items,
    adGroups: [{ name: 'Group A', defaultBidCents: 30, keywords: [{ text: 'giacca moto', matchType: 'PHRASE', bidCents: 30 }] }],
  } })
  const j1 = r1.json() as { campaignId?: string; promoteResults?: Array<{ key: string; ok: boolean; error?: string }>; groupResults?: Array<{ name: string; adGroupId?: string }> }
  check('manual launch 200', r1.statusCode === 200 && !!j1.campaignId, JSON.stringify(j1).slice(0, 120))
  if (j1.campaignId) {
    madeCampaigns.push(j1.campaignId)
    const grp = await prisma.ebayAdGroup.findFirst({ where: { campaignId: j1.campaignId } })
    const ads = await prisma.ebayAd.findMany({ where: { campaignId: j1.campaignId } })
    check('ads created for staged listings', ads.length === items.length, `${ads.length}/${items.length}`)
    check('ads live INSIDE the first ad group', !!grp && ads.every((a) => a.adGroupId === grp.id), `group=${grp?.name}`)
    check('CPC ads carry no rate + sandbox status', ads.every((a) => a.bidPercentage == null && a.status === 'SANDBOX'))
    check('promoteResults returned ok', (j1.promoteResults ?? []).filter((r) => r.ok).length === items.length)
  }

  // ── SMART PRI launch: campaign-level ads ────────────────────────────────────
  const r2 = await app.inject({ method: 'POST', url: '/api/ebay-ads/builder/launch', payload: {
    goal: 'hero', name: '_er4e4 smart attach', marketplace: 'EBAY_IT', targetingType: 'SMART', dailyBudgetCents: 500, maxCpcCents: 40, items,
  } })
  const j2 = r2.json() as { campaignId?: string; promoteResults?: Array<{ ok: boolean }> }
  check('smart launch 200', r2.statusCode === 200 && !!j2.campaignId)
  if (j2.campaignId) {
    madeCampaigns.push(j2.campaignId)
    const ads2 = await prisma.ebayAd.findMany({ where: { campaignId: j2.campaignId } })
    check('smart ads at campaign level (no group)', ads2.length === items.length && ads2.every((a) => a.adGroupId == null), `${ads2.length} ads`)
  }

  // ── CPS guards unchanged ────────────────────────────────────────────────────
  const cps = await prisma.ebayCampaign.findFirst({ where: { fundingModel: 'COST_PER_SALE', status: 'RUNNING' }, select: { id: true } })
  if (cps) {
    let threw = ''
    try { await writes.promoteListings({ actorUserId: 'smoke' }, { campaignId: cps.id, items: [{ listingId: 'x' }], adGroupId: 'nope' }) } catch (e) { threw = (e as Error).message }
    check('CPS rejects adGroupId (guard intact)', threw.includes('Priority campaigns'), threw.slice(0, 60))
  } else check('CPS rejects adGroupId (guard intact)', true, 'no CPS campaign — vacuous')
  // MANUAL without group errors honestly
  let threw2 = ''
  if (madeCampaigns[0]) {
    try { await writes.promoteListings({ actorUserId: 'smoke' }, { campaignId: madeCampaigns[0], items: [{ listingId: 'zzz' }] }) } catch (e) { threw2 = (e as Error).message }
    check('MANUAL without adGroupId errors honestly', threw2.includes('ad group'), threw2.slice(0, 70))
  }
} finally {
  for (const id of madeCampaigns) {
    await prisma.ebayAd.deleteMany({ where: { campaignId: id } })
    await prisma.ebayKeyword.deleteMany({ where: { campaignId: id } })
    await prisma.ebayAdGroup.deleteMany({ where: { campaignId: id } })
    await prisma.ebayCampaign.delete({ where: { id } }).catch(() => {})
  }
  console.log(`cleanup: ${madeCampaigns.length} sandbox campaign(s) removed`)
}
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
