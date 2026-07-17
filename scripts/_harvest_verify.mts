/**
 * H.6 — End-to-end verification of the harvest lifecycle (H.1 idempotency, H.2 cross-campaign
 * promotion, H.3 isolation-negate). Runs the REAL services against the DB on an ISOLATED fake
 * marketplace (ZZTEST — no Amazon connection ⇒ no live push possible; adsMode=sandbox ⇒ negatives
 * short-circuit) with namespaced rows that are fully cleaned up at start + end. Never touches Xavia
 * data (different marketplace + name prefix). Run: npx tsx scripts/_harvest_verify.ts
 */
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
delete process.env.NEXUS_AMAZON_ADS_MODE // force sandbox — never push to Amazon during verification

const prisma = (await import('../apps/api/src/db.js')).default
const { createCampaignLocal, createAdGroupLocal } = await import('../apps/api/src/services/advertising/ads-create.service.js')
const { previewHarvest, applyHarvest } = await import('../apps/api/src/services/advertising/ads-harvest.service.js')
// Register ACTION_HANDLERS (side-effect import) — production does this at server boot (index.ts:1177).
await import('../apps/api/src/services/advertising/automation-action-handlers.js')

const MKT = 'ZZTEST'
const PFX = '__htest__'
const AUTO_C = '__htest_auto_c', AUTO_AG = '__htest_auto_ag'
const EXACT_C = '__htest_exact_c', EXACT_AG = '__htest_exact_ag'
const WINNER = 'htest red helmet', WASTER = 'htest blue sticker'

let pass = 0, fail = 0
const assert = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`) }
}

async function cleanup() {
  const ags = await prisma.adGroup.findMany({ where: { campaign: { marketplace: MKT } }, select: { id: true } })
  const agIds = ags.map((a: { id: string }) => a.id)
  if (agIds.length) await prisma.adTarget.deleteMany({ where: { adGroupId: { in: agIds } } })
  await prisma.adGroup.deleteMany({ where: { campaign: { marketplace: MKT } } })
  await prisma.campaign.deleteMany({ where: { marketplace: MKT } })
  await prisma.amazonAdsSearchTerm.deleteMany({ where: { marketplace: MKT } })
  // test automation rule + its suggestions/executions
  const rules = await prisma.automationRule.findMany({ where: { name: { startsWith: PFX } }, select: { id: true } })
  const ruleIds = rules.map((r: { id: string }) => r.id)
  if (ruleIds.length) {
    await prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: { in: ruleIds } } })
    await prisma.automationRuleExecution.deleteMany({ where: { ruleId: { in: ruleIds } } })
    await prisma.automationRule.deleteMany({ where: { id: { in: ruleIds } } })
  }
}

const posKw = (adGroupId: string, text: string, mt = 'EXACT') => prisma.adTarget.count({
  where: { adGroupId, kind: 'KEYWORD', isNegative: false, expressionType: mt, expressionValue: { equals: text, mode: 'insensitive' } },
})
const campNeg = (campaignId: string, text: string, mt = 'NEGATIVE_EXACT') => prisma.adTarget.count({
  where: { adGroup: { campaignId }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionType: mt, expressionValue: text },
})
const posProd = (adGroupId: string, asin: string) => prisma.adTarget.count({ where: { adGroupId, kind: 'PRODUCT', isNegative: false, expressionValue: asin } })
const negProd = (adGroupId: string, asin: string) => prisma.adTarget.count({ where: { adGroupId, kind: 'PRODUCT', isNegative: true, expressionValue: asin } })

try {
  console.log('\n[H.6] cleaning any prior test rows…')
  await cleanup()

  console.log('[H.6] seeding isolated test campaigns (marketplace ZZTEST)…')
  const srcCamp = await createCampaignLocal({ name: `${PFX} Auto`, type: 'SP', marketplace: MKT, targetingType: 'AUTO', dailyBudgetEur: 10, biddingStrategy: 'legacyForSales', userId: 'htest' } as never)
  const srcAg = await createAdGroupLocal({ campaignId: srcCamp.id, name: `${PFX} Auto AG`, defaultBidEur: 0.5, userId: 'htest' } as never)
  const dstCamp = await createCampaignLocal({ name: `${PFX} Exact`, type: 'SP', marketplace: MKT, targetingType: 'MANUAL', dailyBudgetEur: 10, biddingStrategy: 'legacyForSales', userId: 'htest' } as never)
  const dstAg = await createAdGroupLocal({ campaignId: dstCamp.id, name: `${PFX} Exact AG`, defaultBidEur: 0.5, userId: 'htest' } as never)
  const patCamp = await createCampaignLocal({ name: `${PFX} PAT`, type: 'SP', marketplace: MKT, targetingType: 'MANUAL', dailyBudgetEur: 10, biddingStrategy: 'legacyForSales', userId: 'htest' } as never)
  const patAg = await createAdGroupLocal({ campaignId: patCamp.id, name: `${PFX} PAT AG`, defaultBidEur: 0.5, userId: 'htest' } as never)
  // Set the external ids harvest resolves by (gated local create leaves them null).
  await prisma.campaign.update({ where: { id: srcCamp.id }, data: { externalCampaignId: AUTO_C } })
  await prisma.adGroup.update({ where: { id: srcAg.id }, data: { externalAdGroupId: AUTO_AG } })
  await prisma.campaign.update({ where: { id: dstCamp.id }, data: { externalCampaignId: EXACT_C } })
  await prisma.adGroup.update({ where: { id: dstAg.id }, data: { externalAdGroupId: EXACT_AG } })
  await prisma.campaign.update({ where: { id: patCamp.id }, data: { externalCampaignId: '__htest_pat_c' } })
  await prisma.adGroup.update({ where: { id: patAg.id }, data: { externalAdGroupId: '__htest_pat_ag' } })

  // Seed search terms in the SOURCE (auto) ad group: keyword winner+waster AND ASIN winner+waster (H.5).
  const today = new Date()
  const ASIN_WIN = 'B0WINNER01', ASIN_WASTE = 'B0WASTER02'
  await prisma.amazonAdsSearchTerm.createMany({
    data: [
      { profileId: 'htest', marketplace: MKT, adProduct: 'sp', date: today, campaignId: AUTO_C, adGroupId: AUTO_AG, query: WINNER, impressions: 400, clicks: 30, costMicros: 3_000_000n, orders7d: 5, sales7dCents: 9000, currencyCode: 'EUR' },
      { profileId: 'htest', marketplace: MKT, adProduct: 'sp', date: today, campaignId: AUTO_C, adGroupId: AUTO_AG, query: WASTER, impressions: 900, clicks: 40, costMicros: 20_000_000n, orders7d: 0, sales7dCents: 0, currencyCode: 'EUR' },
      { profileId: 'htest', marketplace: MKT, adProduct: 'sp', date: today, campaignId: AUTO_C, adGroupId: AUTO_AG, query: ASIN_WIN, impressions: 300, clicks: 20, costMicros: 2_000_000n, orders7d: 4, sales7dCents: 8000, currencyCode: 'EUR' },
      { profileId: 'htest', marketplace: MKT, adProduct: 'sp', date: today, campaignId: AUTO_C, adGroupId: AUTO_AG, query: ASIN_WASTE, impressions: 700, clicks: 25, costMicros: 18_000_000n, orders7d: 0, sales7dCents: 0, currencyCode: 'EUR' },
    ],
  })

  // ── previewHarvest — winner is a graduation, waster is a negative ──────────────────
  console.log('\n[H.6] previewHarvest (scoped to the test source ad group):')
  const preview = await previewHarvest({ windowDays: 7, minSpendCents: 1000, minOrders: 2, adGroupExternalIds: [AUTO_AG] })
  assert(preview.graduations.some((g) => g.query === WINNER), 'winner detected as graduation', preview.graduations.map((g) => g.query))
  assert(preview.negatives.some((n) => n.query === WASTER), 'waster detected as negative', preview.negatives.map((n) => n.query))
  assert(!preview.graduations.some((g) => g.query === WASTER) && !preview.negatives.some((n) => n.query === WINNER), 'no cross-contamination (winner≠negative, waster≠graduation)')

  // H.5 — ASIN queries split into PRODUCT candidates, not keyword candidates
  assert(preview.productGraduations.some((g) => g.query === ASIN_WIN), 'H.5: ASIN winner detected as product graduation', preview.productGraduations.map((g) => g.query))
  assert(preview.productNegatives.some((n) => n.query === ASIN_WASTE), 'H.5: ASIN waster detected as product negative', preview.productNegatives.map((n) => n.query))
  assert(!preview.graduations.some((g) => g.query === ASIN_WIN) && !preview.negatives.some((n) => n.query === ASIN_WASTE), 'H.5: ASINs NOT mixed into keyword candidates')

  // ── applyHarvest with destination routing + isolation plan (keywords + products) ────
  console.log('\n[H.6] applyHarvest (destinations EXACT→Exact, PRODUCT→PAT; plan negate EXACT + product flags):')
  const destinations = { EXACT: dstAg.id, PRODUCT: patAg.id }
  const plan = { [AUTO_AG]: { graduate: ['EXACT'], negate: ['EXACT'], graduateProduct: true, negateProduct: true } }
  const res = await applyHarvest({ negatives: preview.negatives, graduations: preview.graduations.map((g) => ({ ...g })), productNegatives: preview.productNegatives, productGraduations: preview.productGraduations.map((g) => ({ ...g })), plan, destinations, userId: 'htest' })
  assert(res.keywordsGraduated === 1, 'keywordsGraduated === 1', res)
  assert(res.negativesAdded === 1, 'negativesAdded === 1 (waster)', res)
  assert(res.isolationNegativesAdded === 1, 'isolationNegativesAdded === 1 (H.3 fired for promoted winner)', res)

  // H.2 — the graduated keyword landed in the DESTINATION (Exact) ad group, not the source
  assert((await posKw(dstAg.id, WINNER)) === 1, 'H.2: winner promoted INTO Exact (destination) ad group')
  assert((await posKw(srcAg.id, WINNER)) === 0, 'H.2: winner NOT created in source ad group (it was routed away)')

  // H.7 — negatives now persist as local mirror rows (campaign-scoped) on the SOURCE campaign
  assert((await campNeg(srcCamp.id, WASTER)) === 1, 'H.7: waster negative persisted locally on source campaign')
  assert((await campNeg(srcCamp.id, WINNER)) === 1, 'H.7: isolation negative (promoted winner) persisted locally on source campaign')

  // H.5 — product harvesting: ASIN winner → PRODUCT target in PAT destination + negated in source; ASIN waster → negated in source
  assert(res.productsGraduated === 1, 'H.5: productsGraduated === 1', res)
  assert(res.productNegativesAdded === 2, 'H.5: productNegativesAdded === 2 (promoted-ASIN isolation + wasteful ASIN)', res)
  assert((await posProd(patAg.id, ASIN_WIN)) === 1, 'H.5: ASIN winner promoted INTO PAT (destination) ad group')
  assert((await posProd(srcAg.id, ASIN_WIN)) === 0, 'H.5: ASIN winner NOT created in source ad group')
  assert((await negProd(srcAg.id, ASIN_WIN)) === 1, 'H.5: promoted ASIN negated (product) in source ad group')
  assert((await negProd(srcAg.id, ASIN_WASTE)) === 1, 'H.5: wasteful ASIN negated (product) in source ad group')

  // ── re-run — idempotent (H.1 + H.5 + H.7): no duplicate rows of any kind ─────────────
  console.log('\n[H.6] re-running applyHarvest (idempotency):')
  await applyHarvest({ negatives: preview.negatives, graduations: preview.graduations.map((g) => ({ ...g })), productNegatives: preview.productNegatives, productGraduations: preview.productGraduations.map((g) => ({ ...g })), plan, destinations, userId: 'htest' })
  assert((await posKw(dstAg.id, WINNER)) === 1, 'H.1: still exactly 1 winner keyword in destination after re-run (no duplicate)')
  assert((await campNeg(srcCamp.id, WASTER)) === 1, 'H.7: still exactly 1 waster negative after re-run (no duplicate)')
  assert((await campNeg(srcCamp.id, WINNER)) === 1, 'H.7: still exactly 1 isolation negative after re-run (no duplicate)')
  assert((await posProd(patAg.id, ASIN_WIN)) === 1, 'H.5: still exactly 1 ASIN product target after re-run (no duplicate)')
  assert((await negProd(srcAg.id, ASIN_WASTE)) === 1, 'H.5: still exactly 1 wasteful-ASIN negative after re-run (no duplicate)')

  // ── H.4 propose-first — a control:'manual' harvest rule generates a pending Suggestion ─────────
  console.log('\n[H.6] propose-first: control:manual rule → AdsRuleSuggestion:')
  const rule = await prisma.automationRule.create({
    data: {
      name: `${PFX} harvest`, description: 'htest', domain: 'advertising', trigger: 'SCHEDULE',
      conditions: [] as never,
      actions: [{ type: 'harvest_and_negate', control: 'manual', windowDays: 7, minSpendCents: 1000, minOrders: 2, sources: [{ adGroupId: srcAg.id, campaignId: srcCamp.id, harvestFrom: true, graduate: ['EXACT'], negate: ['EXACT'] }], destinations: { EXACT: dstAg.id }, mode: 'harvest' }] as never,
      enabled: true, dryRun: true, scopeMarketplace: MKT, maxExecutionsPerDay: 3, createdBy: 'htest',
    },
  })
  const { evaluateRule } = await import('../apps/api/src/services/automation-rule.service.js')
  await evaluateRule({ ruleId: rule.id, context: { trigger: 'SCHEDULE', marketplace: MKT, budget: { monthlySpendCents: 0 } } } as never)
  // Suggestion generation is fire-and-forget inside evaluateRule (engine line 640) — give it a beat to land.
  await new Promise((r) => setTimeout(r, 1500))
  const sug = await prisma.adsRuleSuggestion.findFirst({ where: { ruleId: rule.id, status: 'pending' } })
  const pa = (sug?.proposedAction ?? {}) as { type?: string; wouldGraduate?: number; wouldNegate?: number }
  assert(!!sug, 'H.4: a pending Suggestion was generated for the manual harvest rule')
  assert(pa.type === 'harvest_and_negate', 'H.4: suggestion is a harvest_and_negate proposal', pa)
  assert((pa.wouldGraduate ?? 0) >= 1, 'H.4: suggestion carries wouldGraduate ≥ 1 (the promotable winner)', pa)

  // ── H.8 / H.9 — inbound campaign-negative mirror: reconcile + deletion ──────────────
  console.log('\n[H.6] H.8/H.9 inbound campaign-negative mirror:')
  const { upsertCampaignNegativeRows, archiveAllowed } = await import('../apps/api/src/services/advertising/ads-keyword-list-sync.service.js')

  // H.7 created the WASTER campaign-negative locally with no external id yet (gated-local).
  const wasterBefore = await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: srcCamp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionType: 'NEGATIVE_EXACT', expressionValue: WASTER }, select: { externalTargetId: true } })
  assert(wasterBefore != null && wasterBefore.externalTargetId == null, 'H.7 row starts gated-local (no external id)', wasterBefore)

  // H.8 — Amazon returns the SAME negative (with its id) + a NEW Amazon-native one → stamp + create, no dup
  await upsertCampaignNegativeRows([
    { campaignNegativeKeywordId: 'amzn-neg-waster', campaignId: AUTO_C, keywordText: WASTER, matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
    { campaignNegativeKeywordId: 'amzn-neg-native', campaignId: AUTO_C, keywordText: 'htest amazon native', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
  ])
  assert((await campNeg(srcCamp.id, WASTER)) === 1, 'H.8: reconciled — no duplicate for the locally-created negative')
  const wasterAfter = await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: srcCamp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionValue: WASTER }, select: { externalTargetId: true } })
  assert(wasterAfter?.externalTargetId === 'amzn-neg-waster', 'H.8: Amazon id STAMPED onto the local row', wasterAfter)
  assert((await campNeg(srcCamp.id, 'htest amazon native')) === 1, 'H.8: Amazon-native campaign negative created locally')

  // H.9 — Amazon now returns ONLY the native one (waster removed on Amazon) + archiveScope → waster archived
  await upsertCampaignNegativeRows(
    [{ campaignNegativeKeywordId: 'amzn-neg-native', campaignId: AUTO_C, keywordText: 'htest amazon native', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }],
    { archiveScopeCampaignExtIds: [AUTO_C] },
  )
  const wasterArchived = await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: srcCamp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionValue: WASTER }, select: { status: true } })
  assert(wasterArchived?.status === 'ARCHIVED', 'H.9: a negative removed on Amazon is archived locally', wasterArchived)
  const nativeStill = await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: srcCamp.id }, isNegative: true, negativeLevel: 'CAMPAIGN', expressionValue: 'htest amazon native' }, select: { status: true } })
  assert(nativeStill?.status === 'ENABLED', 'H.9: the still-present native negative is untouched')

  // H.9 — circuit-breaker math (guards against a partial fetch wiping the mirror)
  assert(archiveAllowed(3, 3) === true, 'H.9 breaker: small real deletion allowed (≤ floor of 20)')
  assert(archiveAllowed(25, 30) === false, 'H.9 breaker: large-fraction wipe blocked (25 > max(20, 15))')
  assert(archiveAllowed(0, 10) === false, 'H.9 breaker: nothing to archive → no-op')

  // ── H.11 — product/auto target deletion reconciliation (shared archiveMissingTargets) ──────────
  console.log('\n[H.6] H.11 target deletion reconciliation:')
  const { archiveMissingTargets } = await import('../apps/api/src/services/advertising/ads-keyword-list-sync.service.js')
  const tStill = await prisma.adTarget.create({ data: { adGroupId: srcAg.id, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0STILL001', bidCents: 50, status: 'ENABLED', isNegative: false, externalTargetId: 'amzn-tgt-still' } })
  const tGone = await prisma.adTarget.create({ data: { adGroupId: srcAg.id, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0GONE0001', bidCents: 50, status: 'ENABLED', isNegative: false, externalTargetId: 'amzn-tgt-gone' } })
  const tLocal = await prisma.adTarget.create({ data: { adGroupId: srcAg.id, kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0LOCAL001', bidCents: 50, status: 'ENABLED', isNegative: false, externalTargetId: null } })
  // Amazon's current list returns only "still" → "gone" should be archived; gated-local row is exempt.
  await archiveMissingTargets([srcAg.id], new Set(['amzn-tgt-still']), { kind: { in: ['PRODUCT', 'AUTO', 'CATEGORY'] }, isNegative: false })
  const st = async (id: string) => (await prisma.adTarget.findUnique({ where: { id }, select: { status: true } }))?.status
  assert((await st(tGone.id)) === 'ARCHIVED', 'H.11: a product target removed on Amazon is archived')
  assert((await st(tStill.id)) === 'ENABLED', 'H.11: a product target still on Amazon is untouched')
  assert((await st(tLocal.id)) === 'ENABLED', 'H.11: a gated-local product target (no external id) is exempt from archival')

  // ── H.12 — campaign deletion reconciliation (testable reconcileCampaignDeletions) ──────────────
  console.log('\n[H.6] H.12 campaign deletion reconciliation:')
  const { reconcileCampaignDeletions } = await import('../apps/api/src/services/advertising/ads-campaign-settings-sync.service.js')
  const campStatus = async (id: string) => (await prisma.campaign.findUnique({ where: { id }, select: { status: true } }))?.status
  // Amazon's ENABLED+PAUSED list returns AUTO + EXACT but NOT pat (pat archived/deleted on Amazon).
  const seenCamps = new Set([AUTO_C, EXACT_C])
  // 1) failed fetch → never archives
  await reconcileCampaignDeletions({ connMarketplace: MKT, seenExternalCampaignIds: seenCamps, fetchOk: false })
  assert((await campStatus(patCamp.id)) === 'ENABLED', 'H.12: failed fetch → no campaign archival')
  // 2) breaker: empty snapshot would archive ALL 3 (>20% cap) → tripped, nothing archived
  await reconcileCampaignDeletions({ connMarketplace: MKT, seenExternalCampaignIds: new Set<string>(), fetchOk: true })
  assert((await campStatus(patCamp.id)) === 'ENABLED', 'H.12: breaker blocks an implausible mass campaign wipe')
  // 3) happy path: pat absent from a plausible snapshot → archived; active campaigns untouched
  await reconcileCampaignDeletions({ connMarketplace: MKT, seenExternalCampaignIds: seenCamps, fetchOk: true })
  assert((await campStatus(patCamp.id)) === 'ARCHIVED', 'H.12: a campaign no longer active on Amazon is archived locally')
  assert((await campStatus(srcCamp.id)) === 'ENABLED' && (await campStatus(dstCamp.id)) === 'ENABLED', 'H.12: campaigns still on Amazon are untouched')

  console.log(`\n[H.6] RESULT: ${pass} passed, ${fail} failed`)
} catch (e) {
  fail++
  console.error('\n[H.6] ERROR:', e instanceof Error ? e.stack : e)
} finally {
  console.log('\n[H.6] cleaning up test rows…')
  await cleanup()
  await prisma.$disconnect()
  console.log('[H.6] done.')
  process.exit(fail > 0 ? 1 : 0)
}
