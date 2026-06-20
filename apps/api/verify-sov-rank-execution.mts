// SK4 verifier — SOV + Keyword Tracker rules flow through evaluateRule in DRY-RUN: the adapter
// translates the builder shape → bid_apply with adTarget.sovPct / adTarget.organicRank conditions,
// then the conditions-tree matches (or not) and bid_apply computes the new bid. No SP-API writes.
// Run: cd apps/api && npx tsx verify-sov-rank-execution.mts
import 'dotenv/config'
import { config } from 'dotenv'
import path from 'node:path'
config({ path: path.join(process.cwd(), '..', '..', '.env'), override: true })

const { default: prisma } = await import('./src/db.js')
const { evaluateRule } = await import('./src/services/automation-rule.service.js')
const { maybeTranslateAdsRule } = await import('./src/services/advertising/ads-rule-adapter.service.js')
await import('./src/services/advertising/automation-action-handlers.js')

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const made: string[] = []
const mkRule = async (name: string, trigger: string, conditions: unknown, actions: unknown) => {
  const r = await prisma.automationRule.create({ data: { name: `__sk4 ${name} ${Date.now()}`, domain: 'advertising', trigger, enabled: true, dryRun: true, maxExecutionsPerDay: 100, conditions: conditions as object, actions: actions as object } })
  made.push(r.id); return r
}

// a real keyword AdTarget so bid_apply's findUnique resolves (dry-run, no write)
const target = await prisma.adTarget.findFirst({ where: { kind: 'KEYWORD', isNegative: false }, select: { id: true, bidCents: true, adGroup: { select: { campaignId: true } } } })
if (!target) { console.log('No keyword AdTarget found — cannot verify bid_apply lookup'); process.exit(1) }
const campaignId = target.adGroup?.campaignId ?? ''

// ── adapter translation (pure) ──
console.log('[adapter translation]')
{
  const sov = maybeTranslateAdsRule({ id: 'r1', actions: [{ type: 'sov', campaigns: [{ id: campaignId }], bidFloor: 0.1, bidCeiling: 2 }], conditions: [{ conditions: [{ metric: 'Share of Voice', op: 'lt', value: '20' }], action: { op: 'incPct', value: '25' } }] })
  ok(sov?.actions[0]?.type === 'bid_apply', `SOV → bid_apply (${sov?.actions[0]?.type})`)
  ok(sov?.conditions[0]?.field === 'adTarget.sovPct' && sov?.conditions[0]?.value === 0.2, `SOV criteria → adTarget.sovPct < 0.2 (frac) (field=${sov?.conditions[0]?.field} val=${sov?.conditions[0]?.value})`)
  ok((sov?.actions[0] as { minEur?: number })?.minEur === 0.1 && (sov?.actions[0] as { maxEur?: number })?.maxEur === 2, `SOV bid guardrails → minEur 0.1 / maxEur 2`)
  const rank = maybeTranslateAdsRule({ id: 'r2', actions: [{ type: 'keyword-tracker', campaigns: [{ id: campaignId }] }], conditions: [{ conditions: [{ metric: 'Organic Rank', op: 'gt', value: '10' }], action: { op: 'incPct', value: '30' } }] })
  ok(rank?.actions[0]?.type === 'bid_apply', `Keyword Tracker → bid_apply (${rank?.actions[0]?.type})`)
  ok(rank?.conditions[0]?.field === 'adTarget.organicRank' && rank?.conditions[0]?.value === 10, `rank criteria → adTarget.organicRank > 10 (plain) (field=${rank?.conditions[0]?.field} val=${rank?.conditions[0]?.value})`)
}

// ── SOV_BID end-to-end (dry-run) ──
console.log('[SOV_BID evaluateRule — dry-run]')
{
  const r = await mkRule('sov', 'SOV_BID',
    [{ match: 'all', conditions: [{ metric: 'Share of Voice', op: 'lt', value: '20' }], action: { op: 'incPct', value: '25' } }],
    [{ type: 'sov', campaigns: [{ id: campaignId }], bidFloor: 0.1, bidCeiling: 2 }])
  // SOV 10% < 20% → match → raise bid 25%
  const hit = { trigger: 'SOV_BID', marketplace: 'DE', adTarget: { id: target.id, sovPct: 0.10, topSharePct: 0.4, impressionSharePct: 0.10, spendCents: 500, salesCents: 1000, orders: 3, acos: 0.5 } }
  const res = await evaluateRule({ ruleId: r.id, context: hit })
  ok(res.matched && res.actionResults[0]?.type === 'bid_apply', `SOV 10%<20% → matched → bid_apply (${(res.actionResults[0]?.output as { wouldChange?: string })?.wouldChange ?? res.actionResults[0]?.type})`)
  // SOV 50% NOT < 20% → no match
  const miss = { trigger: 'SOV_BID', marketplace: 'DE', adTarget: { id: target.id, sovPct: 0.50, topSharePct: 0.4, impressionSharePct: 0.50, spendCents: 500, salesCents: 1000, orders: 3, acos: 0.5 } }
  const res2 = await evaluateRule({ ruleId: r.id, context: miss })
  ok(!res2.matched, `SOV 50% NOT < 20% → no match`)
}

// ── KEYWORD_RANK_BID end-to-end (dry-run) ──
console.log('[KEYWORD_RANK_BID evaluateRule — dry-run]')
{
  const r = await mkRule('rank', 'KEYWORD_RANK_BID',
    [{ match: 'all', conditions: [{ metric: 'Organic Rank', op: 'gt', value: '10' }], action: { op: 'incPct', value: '30' } }],
    [{ type: 'keyword-tracker', campaigns: [{ id: campaignId }], bidFloor: 0.1, bidCeiling: 3 }])
  // organic rank 15 > 10 → match → raise bid 30%
  const hit = { trigger: 'KEYWORD_RANK_BID', marketplace: 'DE', adTarget: { id: target.id, organicRank: 15, sponsoredRank: 4, searchVolume: 8100, rankDelta: -2, spendCents: 400, acos: 0.3 } }
  const res = await evaluateRule({ ruleId: r.id, context: hit })
  ok(res.matched && res.actionResults[0]?.type === 'bid_apply', `Organic rank 15>10 → matched → bid_apply (${(res.actionResults[0]?.output as { wouldChange?: string })?.wouldChange ?? res.actionResults[0]?.type})`)
  // organic rank 5 NOT > 10 (already ranking well) → no match
  const miss = { trigger: 'KEYWORD_RANK_BID', marketplace: 'DE', adTarget: { id: target.id, organicRank: 5, sponsoredRank: 1, searchVolume: 8100, rankDelta: 1, spendCents: 400, acos: 0.3 } }
  const res2 = await evaluateRule({ ruleId: r.id, context: miss })
  ok(!res2.matched, `Organic rank 5 NOT > 10 → no match`)
  // dry-run never wrote — confirm the target bid is unchanged
  const after = await prisma.adTarget.findUnique({ where: { id: target.id }, select: { bidCents: true } })
  ok(after?.bidCents === target.bidCents, `dry-run wrote nothing — bid still ${target.bidCents}¢`)
}

// cleanup
await prisma.automationRule.deleteMany({ where: { id: { in: made } } })
const leftover = await prisma.automationRule.count({ where: { id: { in: made } } })
ok(leftover === 0, `cleanup: ${made.length} test rules removed`)

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} passed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
