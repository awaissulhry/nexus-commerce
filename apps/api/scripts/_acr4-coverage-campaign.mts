/**
 * ACR.4 — the coverage-gap campaign: five terms with real volume that nothing of ours bids on.
 *
 * Operator-approved 2026-08-05. Chosen by RELEVANCE against what XAVIA actually sells — a
 * motorcycle jacket, waterproof, ventilated, Level 2 protection — not by volume. The two largest
 * unbid terms are deliberately EXCLUDED: `accessori moto` (366,958/wk) is dominated by phone
 * mounts and luggage, and `moto` (231,502/wk) is people shopping for motorcycles. Together they
 * are 598k of the 1.1M "unbid" impressions, and buying them would burn the budget on traffic that
 * cannot convert on a jacket.
 *
 * Each term below carries its own evidence:
 *   antipioggia moto          32,285/wk  CVR 1.46%  ← highest CVR on the board; GALE is impermeabile
 *   accessori moto uomo       30,642/wk  CVR 2.16%  ← highest CVR of ANY term measured
 *   paraschiena moto livello 2 31,272/wk CVR 1.02%  ← "Livello 2" is literally in the product title
 *   protezioni moto estive    58,896/wk  share 0.41% ← strongest ORGANIC signal of any unbid term
 *   protezioni moto           47,894/wk  share 0.10%
 *
 * EXACT match on its own campaign so the result is measurable rather than absorbed into the
 * existing fragmentation, at the account's own median bid (34c) rather than a guess.
 *
 * Created PAUSED. The budget is the one number neither of us named, so nothing spends until an
 * operator looks at it and flips it on.
 *
 * Usage: npx tsx scripts/_acr4-coverage-campaign.mts [--apply]
 */
import '../src/env.js'

const APPLY = process.argv.includes('--apply')
const MARKET = 'IT'
const DAILY_BUDGET_EUR = 5
const BID_EUR = 0.34
const NAME = 'XAVIA | IT | Exact | Coverage Gaps'

const TERMS = [
  { kw: 'antipioggia moto', why: '32,285/wk · market CVR 1.46% · GALE is impermeabile' },
  { kw: 'accessori moto uomo', why: '30,642/wk · market CVR 2.16% — highest measured' },
  { kw: 'paraschiena moto livello 2', why: '31,272/wk · CVR 1.02% · "Livello 2" is in the title' },
  { kw: 'protezioni moto estive', why: '58,896/wk · 4 of our ASINs already rank organically' },
  { kw: 'protezioni moto', why: '47,894/wk · broader sibling of the above' },
]

const { default: prisma } = await import('../src/db.js')

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${NAME}`)
console.log(`  marketplace ${MARKET} · EXACT · €${DAILY_BUDGET_EUR.toFixed(2)}/day · bid €${BID_EUR.toFixed(2)} · created PAUSED\n`)
for (const t of TERMS) console.log(`  + ${t.kw.padEnd(30)} ${t.why}`)

const dupes = await prisma.adTarget.findMany({
  where: {
    kind: 'KEYWORD', isNegative: false,
    expressionValue: { in: TERMS.map((t) => t.kw), mode: 'insensitive' },
    adGroup: { campaign: { marketplace: MARKET } },
  },
  select: { expressionValue: true, adGroup: { select: { campaign: { select: { name: true } } } } },
})
console.log(`\n  pre-flight: ${dupes.length} of these terms already exist as positive keywords in ${MARKET}`)
for (const d of dupes) console.log(`    ! ${d.expressionValue} — already in ${d.adGroup.campaign.name}`)

if (!APPLY) { await prisma.$disconnect(); console.log('\nNothing created. Re-run with --apply.\n'); process.exit(0) }

const { createCampaignLocal, createAdGroupLocal, createKeywordLocal } = await import('../src/services/advertising/ads-create.service.js')
const { updateCampaignWithSync } = await import('../src/services/advertising/ads-mutation.service.js')

const camp = await createCampaignLocal({
  name: NAME, type: 'SP', marketplace: MARKET, targetingType: 'MANUAL',
  dailyBudgetEur: DAILY_BUDGET_EUR, biddingStrategy: 'manual',
})
console.log(`\ncampaign ${camp.id} (amazon: ${camp.externalCampaignId ?? 'local only'}) mode=${camp.mode}`)

const ag = await createAdGroupLocal({ campaignId: camp.id, name: 'Coverage Gaps — Exact', defaultBidEur: BID_EUR })
console.log(`ad group ${ag.id} (amazon: ${ag.externalAdGroupId ?? 'local only'})`)

for (const t of TERMS) {
  const k = await createKeywordLocal({ adGroupId: ag.id, keywordText: t.kw, matchType: 'EXACT', bidEur: BID_EUR })
  console.log(`  keyword ${t.kw.padEnd(30)} ${k.externalTargetId ?? 'local only'}`)
}

// PAUSED immediately: the budget was never agreed, so the structure ships and the spending
// decision stays with the operator. One toggle starts it.
const paused = await updateCampaignWithSync({
  campaignId: camp.id,
  patch: { status: 'PAUSED' },
  actor: { kind: 'SYSTEM', id: 'acr4-coverage-campaign' } as never,
  reason: 'Created paused — coverage-gap test awaiting operator budget sign-off',
  applyImmediately: true,
})
console.log(`\npaused: ok=${paused.ok} ${JSON.stringify(paused).slice(0, 160)}`)
await prisma.$disconnect()
console.log('')
