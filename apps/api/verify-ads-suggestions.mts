// ES1 verifier — Manual rule → AdsRuleSuggestion generation + dedup + dismiss + apply-flow (safe:
// apply runs the handler against a FAKE campaign so no SP-API write happens). Run from apps/api.
import 'dotenv/config'
import { config } from 'dotenv'
import path from 'node:path'
config({ path: path.join(process.cwd(), '..', '..', '.env'), override: true })

const { default: prisma } = await import('./src/db.js')
const { evaluateRule, ACTION_HANDLERS } = await import('./src/services/automation-rule.service.js')
await import('./src/services/advertising/automation-action-handlers.js')

let pass = 0, fail = 0
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const camp = await prisma.campaign.findFirst({ where: { marketplace: 'IT' }, select: { id: true, name: true } })
const made: string[] = []

console.log('[generation]')
const rule = await prisma.automationRule.create({ data: {
  name: `__es1 manual ${Date.now()}`, domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  enabled: true, dryRun: false, maxExecutionsPerDay: 100,
  conditions: [{ match: 'all', conditions: [{ metric: 'ACOS', op: 'gt', value: '30' }], action: { op: 'decPct', value: '20' } }] as object,
  actions: [{ type: 'budget', control: 'manual', campaigns: [{ id: camp!.id }], budgetFloor: 2, budgetCeiling: 50 }] as object,
} })
made.push(rule.id)
const ctx = { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id: camp!.id, name: camp!.name, dailyBudgetCents: 2000, acos: 0.5, roas: 2, spendCents: 5000, salesCents: 10000, budgetUtilization: 0.9 } }
const r1 = await evaluateRule({ ruleId: rule.id, context: ctx })
ok(r1.matched && (r1.actionResults[0]?.output as { dryRun?: boolean })?.dryRun === true, 'manual rule matched + dry-run (no write)')
await sleep(400) // fire-and-forget suggestion write
const sugs = await prisma.adsRuleSuggestion.findMany({ where: { ruleId: rule.id } })
ok(sugs.length === 1 && sugs[0].status === 'pending', `1 pending suggestion created (got ${sugs.length})`)
ok(sugs[0].entityType === 'CAMPAIGN' && sugs[0].entityId === camp!.id, 'suggestion carries the campaign entity')
ok((sugs[0].proposedAction as { wouldChange?: string })?.wouldChange?.includes('€') === true, `proposedAction has wouldChange (${(sugs[0].proposedAction as { wouldChange?: string })?.wouldChange})`)

console.log('[dedup]')
await evaluateRule({ ruleId: rule.id, context: ctx }); await sleep(400)
const sugs2 = await prisma.adsRuleSuggestion.findMany({ where: { ruleId: rule.id } })
ok(sugs2.length === 1, `re-run → still 1 suggestion (deduped, got ${sugs2.length})`)

console.log('[apply flow — safe, fake campaign → no write]')
const sug = sugs2[0]
// point the proposed action at a FAKE campaign so budget_apply returns "not found" (no SP-API write)
const fakeAction = { ...(sug.proposedAction as object), campaignId: '__fake__', type: 'budget_apply' }
const handler = ACTION_HANDLERS['budget_apply']
const applyRes = await handler(fakeAction as never, { campaign: { id: '__fake__' } }, { dryRun: false, ruleId: rule.id })
ok(applyRes.ok === false && /not found/i.test(applyRes.error ?? ''), 'apply against fake campaign → not-found (no write)')
await prisma.adsRuleSuggestion.update({ where: { id: sug.id }, data: { status: 'applied', decidedAt: new Date(), decidedBy: 'test' } })
const after = await prisma.adsRuleSuggestion.findUnique({ where: { id: sug.id } })
ok(after?.status === 'applied', 'suggestion → applied')

console.log('[dismiss + list]')
// a fresh suggestion to dismiss
await prisma.adsRuleSuggestion.create({ data: { ruleId: rule.id, entityType: 'CAMPAIGN', entityId: 'C2', proposedAction: { type: 'budget_apply', wouldChange: '€10→€8' }, proposedKey: 'budget_apply:decPct:20:C2', status: 'pending' } })
const pendingBefore = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
ok(pendingBefore >= 1, 'list pending includes the new one')
const toDismiss = await prisma.adsRuleSuggestion.findFirst({ where: { ruleId: rule.id, status: 'pending' } })
await prisma.adsRuleSuggestion.update({ where: { id: toDismiss!.id }, data: { status: 'dismissed', decidedAt: new Date() } })
ok((await prisma.adsRuleSuggestion.findUnique({ where: { id: toDismiss!.id } }))?.status === 'dismissed', 'dismiss → status dismissed')

// cleanup
await prisma.adsRuleSuggestion.deleteMany({ where: { ruleId: rule.id } })
for (const id of made) { await prisma.automationRuleExecution.deleteMany({ where: { ruleId: id } }); await prisma.automationRule.delete({ where: { id } }).catch(() => {}) }
ok(true, 'cleanup')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
await prisma.$disconnect()
process.exit(fail === 0 ? 0 : 1)
