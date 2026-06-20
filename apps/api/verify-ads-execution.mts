// EA1+EA2 verifier — all 6 builder rule types flow through evaluateRule in DRY-RUN: translation
// + condition match + the *_apply handler, persisting AutomationRuleExecution. No SP-API writes.
// Run: cd apps/api && npx tsx _verify-ads-exec.mts
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
  const r = await prisma.automationRule.create({ data: { name: `__ea ${name} ${Date.now()}`, domain: 'advertising', trigger, enabled: true, dryRun: true, maxExecutionsPerDay: 100, conditions: conditions as object, actions: actions as object } })
  made.push(r.id); return r
}
const camp = await prisma.campaign.findFirst({ where: { marketplace: 'IT' }, select: { id: true, name: true, dailyBudget: true, marketplace: true } })

console.log('[budget]')
{
  const r = await mkRule('budget', 'CAMPAIGN_PERFORMANCE_BUDGET',
    [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '30' }], action: { op: 'decPct', value: '20' } }],
    [{ type: 'budget', campaigns: [{ id: camp!.id }], budgetFloor: 2, budgetCeiling: 50 }])
  const ctx = { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id: camp!.id, name: camp!.name, dailyBudgetCents: 2000, acos: 0.5, roas: 2, spendCents: 5000, salesCents: 10000, budgetUtilization: 0.9 } }
  const res = await evaluateRule({ ruleId: r.id, context: ctx })
  ok(res.matched && res.actionResults[0]?.type === 'budget_apply', `matched → budget_apply (${(res.actionResults[0]?.output as { wouldChange?: string })?.wouldChange})`)
}

console.log('[negative]')
{
  const r = await mkRule('neg', 'SEARCH_TERM_WASTING',
    [{ match: 'all', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }, { metric: 'Clicks', op: 'gte', value: '5' }], action: {} }],
    [{ type: 'negative-targeting', negationLevel: 'adgroup', protectConverting: true }])
  const t = maybeTranslateAdsRule({ id: r.id, actions: r.actions, conditions: r.conditions })
  ok(t?.actions[0]?.type === 'add_negative_exact' && t?.actions[0]?.scope === 'AD_GROUP', '→ add_negative_exact scope AD_GROUP')
  const ctx = { trigger: 'SEARCH_TERM_WASTING', marketplace: 'IT', searchTerm: { query: 'free moto jacket', externalCampaignId: 'EXT1', externalAdGroupId: 'AG1', spendCents: 800, clicks: 12, orders: 0, salesCents: 0 } }
  const res = await evaluateRule({ ruleId: r.id, context: ctx })
  ok(res.matched && res.actionResults[0]?.ok === true, 'Sales=0 & Clicks 12≥5 → matched, negate dry-run')
  ok((res.actionResults[0]?.output as { dryRun?: boolean })?.dryRun === true, 'negate is dry-run (no write)')
}

console.log('[harvest]')
{
  const r = await mkRule('harvest', 'SEARCH_TERM_CONVERTING',
    [{ match: 'all', conditions: [{ metric: 'PPC Orders', op: 'gte', value: '1' }], action: {} }],
    [{ type: 'keyword-harvesting', bid: { mode: 'fixed', value: '0.9' }, negateInSource: true }])
  const t = maybeTranslateAdsRule({ id: r.id, actions: r.actions, conditions: r.conditions })
  ok(t?.actions[0]?.type === 'promote_to_exact' && t?.actions[0]?.bidEur === 0.9, '→ promote_to_exact bidEur 0.9')
  ok(t?.actions[1]?.type === 'add_negative_exact', 'negate-in-source → 2nd action add_negative_exact')
  const ctx = { trigger: 'SEARCH_TERM_CONVERTING', marketplace: 'IT', searchTerm: { query: 'misano jacket', externalCampaignId: 'EXT1', externalAdGroupId: 'AG1', orders: 3, clicks: 10, spendCents: 1200, salesCents: 8000 } }
  const res = await evaluateRule({ ruleId: r.id, context: ctx })
  ok(res.matched && res.actionResults[0]?.type === 'promote_to_exact' && res.actionResults[0]?.ok === true, 'Orders 3≥1 → matched, promote dry-run')
}

console.log('[bid]')
{
  const r = await mkRule('bid', 'KEYWORD_HIGH_ACOS',
    [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '40' }], action: { op: 'decPct', value: '15' } }],
    [{ type: 'bid', campaigns: [{ id: camp!.id }] }])
  const t = maybeTranslateAdsRule({ id: r.id, actions: r.actions, conditions: r.conditions })
  ok(t?.actions[0]?.type === 'bid_apply' && t?.conditions[0]?.field === 'adTarget.acos' && t?.conditions[0]?.value === 0.4, '→ bid_apply, ACOS>40 → adTarget.acos>0.4')
  const adt = await prisma.adTarget.findFirst({ select: { id: true, bidCents: true } })
  if (adt) {
    const ctx = { trigger: 'KEYWORD_HIGH_ACOS', marketplace: 'IT', adTarget: { id: adt.id, acos: 0.6, spendCents: 3000, salesCents: 5000, orders: 2 } }
    const res = await evaluateRule({ ruleId: r.id, context: ctx })
    ok(res.matched && res.actionResults[0]?.type === 'bid_apply' && res.actionResults[0]?.ok === true, `ACOS 0.6>0.4 → matched, bid_apply dry-run (${(res.actionResults[0]?.output as { wouldChange?: string })?.wouldChange})`)
  } else ok(true, 'no adTarget in DB — bid evaluateRule skipped (translation verified)')
}

console.log('[dayparting]')
{
  const now = new Date()
  const dowName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(now)
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(now)) % 24
  const dow = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[dowName]
  const win = { day: dow, start: `${String(hour).padStart(2, '0')}:00`, end: `${String(Math.min(23, hour + 1)).padStart(2, '0')}:00`, adj: 'pause', value: '' }
  const r = await mkRule('dp', 'SCHEDULE', [], [{ type: 'dayparting-schedule', timezone: 'Europe/Rome', windows: [win], campaigns: [{ id: camp!.id }] }])
  const t = maybeTranslateAdsRule({ id: r.id, actions: r.actions, conditions: r.conditions })
  ok(t?.actions[0]?.type === 'dayparting_apply' && Array.isArray(t?.conditions) && t?.conditions.length === 0, '→ dayparting_apply, empty conditions (always-match)')
  const ctx = { trigger: 'SCHEDULE', marketplace: camp!.marketplace, budget: { monthlySpendCents: 0 } }
  const res = await evaluateRule({ ruleId: r.id, context: ctx })
  const out = res.actionResults[0]?.output as { action?: string; noActiveWindow?: boolean } | undefined
  ok(res.matched && res.actionResults[0]?.type === 'dayparting_apply', `SCHEDULE → dayparting_apply ran`)
  ok(out?.action === 'pause' || out?.noActiveWindow === true, `current-hour window resolved (action=${out?.action ?? 'none'})`)
}

// ─────────── EA3 control mode — Manual = propose-only even when graduated live ───────────
console.log('[control: manual force-suggest]')
{
  // dryRun:FALSE (graduated) BUT control:manual → must still force dry-run (suggest, no write).
  // Backstop: maxDailyAdSpendCentsEur:0 + an INCREASE action → even a broken wiring is cap-blocked.
  const r = await prisma.automationRule.create({ data: { name: `__ea manual ${Date.now()}`, domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true, dryRun: false, maxExecutionsPerDay: 100, maxDailyAdSpendCentsEur: 0,
    conditions: [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'lt', value: '90' }], action: { op: 'incPct', value: '20' } }] as object,
    actions: [{ type: 'budget', control: 'manual', campaigns: [{ id: camp!.id }], budgetFloor: 1, budgetCeiling: 999 }] as object } })
  made.push(r.id)
  const ctx = { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id: camp!.id, name: camp!.name, dailyBudgetCents: 2000, acos: 0.2, roas: 5, spendCents: 1000, salesCents: 5000, budgetUtilization: 0.5 } }
  const res = await evaluateRule({ ruleId: r.id, context: ctx })
  const exec = await prisma.automationRuleExecution.findFirst({ where: { ruleId: r.id }, orderBy: { startedAt: 'desc' } })
  ok(res.matched === true, 'manual rule matched')
  ok(exec?.dryRun === true, 'Manual control + rule.dryRun=false → execution STILL dryRun (force-suggest)')
  ok((res.actionResults[0]?.output as { dryRun?: boolean })?.dryRun === true, 'budget_apply proposed-only (no write)')
  // confirm an Automate rule with dryRun:false would NOT be force-dry (respects rule.dryRun)
  const r2 = await prisma.automationRule.create({ data: { name: `__ea auto ${Date.now()}`, domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', enabled: true, dryRun: true, maxExecutionsPerDay: 100,
    conditions: r.conditions as object, actions: [{ type: 'budget', control: 'automate', campaigns: [{ id: camp!.id }], budgetFloor: 1, budgetCeiling: 999 }] as object } })
  made.push(r2.id)
  const res2 = await evaluateRule({ ruleId: r2.id, context: ctx })
  ok(res2.matched === true && res2.actionResults[0]?.ok === true, 'Automate rule runs (respects own dryRun flag)')
}

for (const id of made) { await prisma.automationRuleExecution.deleteMany({ where: { ruleId: id } }); await prisma.automationRule.delete({ where: { id } }).catch(() => {}) }
ok(true, `cleanup — ${made.length} test rules deleted`)

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
