// E4 sandbox E2E: exercises every write op with the gate CLOSED (sandbox) —
// zero external eBay calls by construction. Creates temporary sandbox rows,
// asserts guardrails/transitions/quota/audit, then cleans up. Audit rows are
// kept (they are real audit of sandbox ops).
const prisma = (await import('../src/db.js')).default
const w = await import('../src/services/marketing/ebay-ads-write.service.js')
const csv = await import('../src/services/marketing/ebay-ads-csv.service.js')

const ctx = { actorUserId: 'e4-verify' }
let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(` ✓ ${name}`) } else { fail++; console.log(` ✗ ${name} ${detail}`) }
}

console.log('mode:', w.currentWriteMode(), '(expect sandbox — gate env unset locally)')
ok('gate closed → sandbox', w.currentWriteMode() === 'sandbox')

const auditBefore = await prisma.campaignAction.count({ where: { channel: 'EBAY' } })

// 1. create CPS campaign (sandbox)
const created = await w.createCampaign(ctx, { name: 'E4 VERIFY (sandbox)', marketplace: 'EBAY_IT', fundingModel: 'COST_PER_SALE', adRateStrategy: 'FIXED', ratePct: 8 })
ok('create campaign → sandbox id + DRAFT', created.mode === 'sandbox' && created.externalCampaignId.startsWith('sandbox-'))
const campId = created.campaignId

// negative: ES priority blocked
const esBlocked = await w.createCampaign(ctx, { name: 'x', marketplace: 'EBAY_ES', fundingModel: 'COST_PER_CLICK', dailyBudgetCents: 500, targetingType: 'MANUAL' }).then(() => false).catch((e) => /Spain/.test(e.message))
ok('Priority on EBAY_ES rejected', esBlocked)

// 2. guardrail block: synthetic economics row breakEven=10, promote at 20 w/o override
await prisma.ebayListingEconomics.upsert({
  where: { marketplace_itemId: { marketplace: 'IT', itemId: 'e4-test-block' } },
  create: { marketplace: 'IT', itemId: 'e4-test-block', breakEvenAdRatePct: '10.00', dataStatus: 'ESTIMATED', priceCents: 10000 },
  update: { breakEvenAdRatePct: '10.00', dataStatus: 'ESTIMATED' },
})
const promo = await w.promoteListings(ctx, { campaignId: campId, items: [
  { listingId: 'e4-test-block', ratePct: 20 },   // > break-even → BLOCK
  { listingId: 'e4-test-warn', ratePct: 12 },    // no economics → warn + create
  { listingId: 'e4-test-bad', ratePct: 1 },      // below eBay min → error
] })
const blocked = promo.results.find((r) => r.key === 'e4-test-block')
const warned = promo.results.find((r) => r.key === 'e4-test-warn')
const badRate = promo.results.find((r) => r.key === 'e4-test-bad')
ok('rate>break-even BLOCKED', !!blocked && !blocked.ok && /exceeds break-even/.test(blocked.blocked ?? ''))
ok('no-economics → created with warning', !!warned && warned.ok && /break-even unknown/.test(warned.warning ?? ''))
ok('rate<2% rejected', !!badRate && !badRate.ok && /between 2%/.test(badRate.error ?? ''))
const adRow = await prisma.ebayAd.findFirst({ where: { campaignId: campId, listingId: 'e4-test-warn' } })
ok('sandbox ad mirrored with status SANDBOX', adRow?.status === 'SANDBOX' && adRow.bidPercentage?.toString() === '12')

// override unlocks the block
const promo2 = await w.promoteListings(ctx, { campaignId: campId, items: [{ listingId: 'e4-test-block', ratePct: 20 }], override: { reason: 'e4 verification override' } })
ok('explicit override unlocks + audited warning', promo2.results[0]!.ok && /override: e4 verification/.test(promo2.results[0]!.warning ?? ''))

// 3. setAdRates guardrail + mirror
const rates = await w.setAdRates(ctx, campId, [{ listingId: 'e4-test-warn', ratePct: 9.5 }])
ok('setAdRates mirrors locally', rates.results[0]!.ok && (await prisma.ebayAd.findFirst({ where: { campaignId: campId, listingId: 'e4-test-warn' } }))?.bidPercentage?.toString() === '9.5')

// 4. lifecycle transition guard: DRAFT can't pause; DRAFT→ACTIVE→PAUSED→ENDED walks
const draftPause = await w.campaignLifecycle(ctx, campId, 'pause').then(() => false).catch((e) => /not a legal transition/.test(e.message))
ok('DRAFT → pause rejected by state machine', draftPause)
await w.campaignLifecycle(ctx, campId, 'resume') // DRAFT→ACTIVE
await w.campaignLifecycle(ctx, campId, 'pause')
const ended = await w.campaignLifecycle(ctx, campId, 'end')
ok('DRAFT→ACTIVE→PAUSED→ENDED walk', ended.status === 'ENDED')
const endedTwice = await w.campaignLifecycle(ctx, campId, 'resume').then(() => false).catch((e) => /not a legal transition/.test(e.message))
ok('ENDED → resume rejected (clone, not resume)', endedTwice)

// 5. budget: CPS rejected; CPC quota walk on a sandbox CPC campaign
const cpsBudget = await w.updateBudget(ctx, campId, 1000).then(() => false).catch((e) => /CPC/.test(e.message))
ok('budget on CPS rejected', cpsBudget)
const cpc = await w.createCampaign(ctx, { name: 'E4 VERIFY CPC (sandbox)', marketplace: 'EBAY_IT', fundingModel: 'COST_PER_CLICK', targetingType: 'MANUAL', dailyBudgetCents: 500 })
let quotaHit = false
for (let i = 0; i < 16; i++) {
  try { await w.updateBudget(ctx, cpc.campaignId, 500 + i * 10) } catch (e) { quotaHit = /15\/15/.test((e as Error).message); break }
}
ok('budget 15/day quota enforced on the 16th edit', quotaHit)

// 6. CPC structure: ad group + keywords (incl. invalid) + pause + negatives
const ag = await w.createAdGroup(ctx, cpc.campaignId, 'E4 group', 30)
const kws = await w.addKeywords(ctx, cpc.campaignId, ag.adGroupId, [
  { text: 'giacca moto uomo', matchType: 'PHRASE', bidCents: 35 },
  { text: 'a b c d e f g h i j k', matchType: 'EXACT', bidCents: 20 }, // 11 words → invalid
])
ok('keyword created + invalid rejected', kws.results.filter((r) => r.ok).length === 1 && kws.results.some((r) => /10 words/.test(r.error ?? '')))
const kwRow = await prisma.ebayKeyword.findFirst({ where: { campaignId: cpc.campaignId } })
const kwUpd = await w.updateKeywords(ctx, cpc.campaignId, [{ keywordId: kwRow!.id, status: 'PAUSED', bidCents: 40 }])
ok('keyword pause + bid mirror', kwUpd.results[0]!.ok && (await prisma.ebayKeyword.findUnique({ where: { id: kwRow!.id } }))?.status === 'PAUSED')
const negs = await w.addNegatives(ctx, cpc.campaignId, ag.adGroupId, [{ text: 'bambino', matchType: 'EXACT' }])
ok('negative keyword created (sandbox)', negs.results[0]!.ok)

// 7. CSV: export contains our sandbox campaign; import dry-run diff + apply
const exported = await csv.exportAdsCsv()
ok('export CSV has header + campaign rows', exported.startsWith('entity,campaign_id') && exported.includes('E4 VERIFY (sandbox)'))
const importCsv = [
  'entity,campaign_id,listing_id,ad_rate_pct,keyword_id,bid_eur,daily_budget_eur,action',
  `AD,${created.externalCampaignId},e4-test-warn,7.5,,,,`,
  'AD,unknown-campaign,x,5,,,,',
].join('\n')
const dry = await csv.diffOps(csv.parseAdsOpsCsv(importCsv).ops)
ok('import dry-run diffs valid + flags unknown campaign', dry.length === 2 && dry[0]!.to === '7.5%' && /unknown campaign/.test(dry[1]!.error ?? ''))
const applied = await csv.applyOps(ctx, csv.parseAdsOpsCsv(importCsv).ops)
ok('import apply: per-row results (1 ok, 1 failed)', applied.filter((a) => a.ok).length === 1 && applied.length === 2)

// 8. audit trail
const auditAfter = await prisma.campaignAction.count({ where: { channel: 'EBAY' } })
const lastAudit = await prisma.campaignAction.findFirst({ where: { channel: 'EBAY' }, orderBy: { createdAt: 'desc' } })
ok(`CampaignAction rows written (${auditAfter - auditBefore})`, auditAfter - auditBefore >= 12)
ok('audit rows carry _mode=sandbox', JSON.stringify(lastAudit?.payloadAfter ?? {}).includes('"_mode":"sandbox"'))

// 9. cleanup sandbox entities (audit rows kept)
await prisma.ebayCampaign.deleteMany({ where: { externalCampaignId: { startsWith: 'sandbox-' } } })
await prisma.ebayListingEconomics.deleteMany({ where: { itemId: { in: ['e4-test-block'] } } })
const leftovers = await prisma.ebayCampaign.count({ where: { externalCampaignId: { startsWith: 'sandbox-' } } })
ok('cleanup: sandbox campaigns removed (cascade ads/groups/keywords)', leftovers === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
