/**
 * RA.AUTO — `bid_to_target_acos`: which rules carry which unit, and could any of them act?
 *
 * The handler (`ads-bid-optimizer.service.ts:250`) reads `action.targetAcos` as a RAW number and
 * hands it to `previewBidOptimization`, whose default is `0.3 // 30% default fallback`. So the
 * field is a FRACTION. A rule storing `30` is asking for a 3000% ACOS target — "spend up to 30×
 * revenue" — which in this engine means every bid it touches goes up.
 *
 * Second, separate defect on the same action: the handler reads `action.campaignId` (SINGULAR
 * string). A rule storing `campaignIds` (plural array) has that field ignored entirely, so a rule
 * scoped to 11 named campaigns would optimise the whole account.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, actions: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true },
  orderBy: { name: 'asc' },
})

console.log('\n═══ every rule carrying bid_to_target_acos ═══\n')
let risky = 0
let riskyAndActs = 0
let ignoredCampaignIds = 0

for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  for (const a of acts) {
    if (a?.type !== 'bid_to_target_acos') continue
    const level = resolveAutonomy(r)
    const raw = a.targetAcos
    const has = raw != null
    const n = Number(raw)
    // A fraction target is <= 1 (100%). Anything above 1 is almost certainly a percent written raw.
    const looksLikePercent = has && Number.isFinite(n) && n > 1
    const effectivePct = has ? n * 100 : 30
    const plural = Array.isArray(a.campaignIds) ? (a.campaignIds as unknown[]).length : 0
    const singular = typeof a.campaignId === 'string'
    if (looksLikePercent) { risky++; if (levelActs(level)) riskyAndActs++ }
    if (plural > 0 && !singular) ignoredCampaignIds++

    console.log(`${looksLikePercent ? '🔴' : '  '} [${level.padEnd(7)}] ${r.name.slice(0, 44).padEnd(46)}`)
    console.log(`      targetAcos = ${has ? JSON.stringify(raw) : '(absent → default 0.3)'}  →  engine reads it as ${effectivePct.toFixed(0)}% ACOS target${looksLikePercent ? '   ← 100× too high' : ''}`)
    if (plural > 0) console.log(`      campaignIds = [${plural} ids] — the handler reads \`campaignId\` (singular), so this is IGNORED → acts account-wide`)
    if (singular) console.log(`      campaignId = "${String(a.campaignId)}" (honoured)`)
    console.log(`      rule scope: marketplace=${r.scopeMarketplace ?? 'any'} portfolio=${r.scopePortfolioId ?? 'none'} campaign=${r.scopeCampaignId ?? 'none'}`)
  }
}

console.log(`\n═══ verdict ═══`)
console.log(`rules with a percent-shaped targetAcos (>1): ${risky}`)
console.log(`  ...of those, currently able to WRITE (AUTO): ${riskyAndActs}   ← the number that matters`)
console.log(`rules whose campaignIds array is silently ignored: ${ignoredCampaignIds}`)

// Has the engine ever actually applied anything from this action? `applied` in the output.
const since = new Date(Date.now() - 60 * 86_400_000)
const execs = await prisma.automationRuleExecution.findMany({
  where: { startedAt: { gte: since }, rule: { domain: 'advertising' } },
  select: { actionResults: true, dryRun: true, ruleId: true },
  take: 20000,
})
let appliedTotal = 0; let wouldChangeTotal = 0; let rowsSeen = 0
for (const e of execs) {
  for (const a of ((e.actionResults ?? []) as Array<{ type?: string; output?: Record<string, unknown> }>)) {
    if (a?.type !== 'bid_to_target_acos') continue
    rowsSeen++
    appliedTotal += Number(a.output?.applied ?? 0)
    wouldChangeTotal += Number(a.output?.wouldChange ?? 0)
  }
}
console.log(`\nbid_to_target_acos action results in 60 days: ${rowsSeen}`)
console.log(`  bids actually applied : ${appliedTotal}   ← if 0, the unit bug has never moved a bid`)
console.log(`  dry-run wouldChange   : ${wouldChangeTotal}`)
console.log('\n(read-only — nothing was written)')
await prisma.$disconnect()
