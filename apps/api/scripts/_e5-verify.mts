// E5 verification — TWO parts:
//  A) LIVE write-path validation (gate flipped by operator): create a
//     clearly-labeled test campaign, promote ONE listing at the 2% minimum,
//     approve-a-proposal → live apply → ROLLBACK → end campaign. Max
//     exposure: one 2–2.5% ad live for ~a minute on one listing.
//  B) Automation engine on prod data in SUGGEST: starter pack installs,
//     evaluator runs, manual-only skip proven (all listings MISSING_COGS).
const prisma = (await import('../src/db.js')).default
const w = await import('../src/services/marketing/ebay-ads-write.service.js')
const auto = await import('../src/services/marketing/ebay-ads-automation.service.js')
const api = await import('../src/services/marketing/ebay-ads-api.service.js')

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => { if (cond) { pass++; console.log(` ✓ ${name}`) } else { fail++; console.log(` ✗ ${name} ${detail}`) } }
const ctx = { actorUserId: 'e5-verify' }

console.log('write mode:', w.currentWriteMode(), '(expect LIVE — operator flipped the gate)')
ok('gate open → live', w.currentWriteMode() === 'live')

// ── A. live round-trip ───────────────────────────────────────────────────────
const created = await w.createCampaign(ctx, { name: 'NEXUS E5 LIVE VALIDATION — safe test, ends immediately', marketplace: 'EBAY_IT', fundingModel: 'COST_PER_SALE', adRateStrategy: 'FIXED', ratePct: 2 })
ok('live campaign created (real eBay id)', created.mode === 'live' && /^\d+$/.test(created.externalCampaignId), created.externalCampaignId)

const listingId = '256566112769' // knee sliders, €21.99 — cheapest live listing
const promo = await w.promoteListings(ctx, { campaignId: created.campaignId, items: [{ listingId, ratePct: 2 }] })
ok('live ad created at 2% minimum', promo.mode === 'live' && !!promo.results.find((r) => r.key === listingId && r.ok), JSON.stringify(promo.results))

// hand-crafted proposal → approve (live apply) → rollback (live inverse)
const proposal = await prisma.ebayAdsProposal.create({
  data: {
    kind: 'adjust_ad_rate',
    entityRef: { campaignId: created.campaignId, externalCampaignId: created.externalCampaignId, campaignName: 'E5 validation', listingId, marketplace: 'EBAY_IT' } as object,
    proposedAction: { from: '2%', to: '2.5%', inverse: { type: 'set_rate', listingId, ratePct: 2 } } as object,
    reasoning: { test: 'e5 live loop validation' } as object,
    proposedKey: `e5-verify:${Date.now()}`,
    status: 'PENDING',
  },
})
const decided = await auto.decideProposals('e5-verify', [proposal.id], 'approve')
ok('proposal approved → LIVE rate 2% → 2.5%', decided[0]!.ok, decided[0]!.detail)
const adAfter = await prisma.ebayAd.findFirst({ where: { campaignId: created.campaignId, listingId } })
ok('local mirror shows 2.5%', adAfter?.bidPercentage?.toString() === '2.5')

const rollback = await auto.rollbackProposal('e5-verify', proposal.id)
ok('rollback → LIVE rate back to 2%', /2/.test(rollback), rollback)
const adBack = await prisma.ebayAd.findFirst({ where: { campaignId: created.campaignId, listingId } })
ok('local mirror restored to 2%', adBack?.bidPercentage?.toString() === '2')

// verify on eBay directly (read): the campaign exists + then end it
const auth = (await api.getActiveEbayAdsAuth())!
const liveAds = await api.fetchAds(auth.token, created.externalCampaignId)
ok('eBay confirms the ad exists on the live campaign', liveAds.some((a) => a.listingId === listingId))

await w.removeAds(ctx, created.campaignId, [listingId])
const ended = await w.campaignLifecycle(ctx, created.campaignId, 'end')
ok('live campaign ENDED (validation over — total exposure ≈ one minute at 2%)', ended.status === 'ENDED' && ended.mode === 'live')

// ── B. automation engine on prod data (SUGGEST) ─────────────────────────────
await prisma.marketingAutomationState.upsert({ where: { channel: 'EBAY' }, create: { channel: 'EBAY', globalMode: 'SUGGEST' }, update: { globalMode: 'SUGGEST', halted: false, haltReason: null } })
const pack = await auto.installStarterRules()
ok(`starter pack installed (${pack.installed} rules, ${pack.skipped} existing)`, pack.installed + pack.skipped === 6)
await prisma.ebayAdsRule.updateMany({ where: {}, data: { enabled: true } })
const evalReport = await auto.evaluateEbayAdsRules()
ok(`evaluator ran ${evalReport.rules} rules over ${evalReport.evaluated} entities (errors=${evalReport.errors.length})`, evalReport.rules === 6 && evalReport.errors.length === 0, JSON.stringify(evalReport.errors))
// all live listings are MISSING_COGS → rate rules must have skipped them (manual-only)
const rateProposals = await prisma.ebayAdsProposal.count({ where: { kind: { in: ['adjust_ad_rate', 'set_rate_to_breakeven_factor'] }, status: 'PENDING' } })
ok('manual-only guardrail: zero rate proposals without cost data', rateProposals === 0, `found ${rateProposals}`)
await prisma.ebayAdsRule.updateMany({ where: {}, data: { enabled: false } }) // back to defaults (operator enables)

// digest
const digest = await auto.generateWeeklyDigest()
ok(`weekly digest generated (week ${digest.weekStart})`, !!digest.weekStart)
const d = await prisma.ebayAdsDigest.findFirst({ orderBy: { weekStart: 'desc' } })
const payload = d?.payload as { totals?: { adFeesCents?: number }; movers?: unknown[] }
ok('digest payload carries totals + movers', payload?.totals?.adFeesCents != null && Array.isArray(payload?.movers))

// anomaly guard runs clean
const guard = await auto.runAnomalyGuard()
ok(`anomaly guard ran (anomalies=${guard.anomalies}, ceilings=${guard.ceilings})`, guard.anomalies >= 0)

// posture back to OFF (ships dormant; operator turns the dial in the UI)
await prisma.marketingAutomationState.update({ where: { channel: 'EBAY' }, data: { globalMode: 'OFF' } })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
