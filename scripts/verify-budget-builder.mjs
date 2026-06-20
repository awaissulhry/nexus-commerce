#!/usr/bin/env node
/**
 * verify-budget-builder.mjs — B6 verifier for the Budget rule builder backend.
 *
 * Asserts the create/edit/delete cycle the Budget builder relies on, with the budget-specific
 * payload (campaigns + per-criteria THEN action + guardrails + marketplace scope + spend cap).
 * Sibling to verify-harvest-builder.mjs / verify-negative-builder.mjs. Runs against a live API
 * (default PROD — the trigger CAMPAIGN_PERFORMANCE_BUDGET is whitelisted there).
 *
 *   node scripts/verify-budget-builder.mjs
 *   API_BASE=http://localhost:4001 node scripts/verify-budget-builder.mjs
 */
const BASE = (process.env.API_BASE || 'https://nexusapi-production-b7bb.up.railway.app').replace(/\/$/, '')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }
const j = async (path, init) => { const r = await fetch(`${BASE}/api/advertising${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) } }

console.log(`verify-budget-builder → ${BASE}`)

// 1) GET /campaigns (the Budget picker source — must carry dailyBudget)
console.log('\n[1] GET /campaigns (picker source)')
const camps = await j('/campaigns?limit=3')
ok(camps.status === 200 && Array.isArray(camps.body.items), 'campaigns 200 + items[]')
const c0 = camps.body.items?.[0]
ok(!!c0 && 'dailyBudget' in c0, 'campaign rows carry dailyBudget (needed for Preview)')

// 2) POST a budget rule — must start disabled + dry-run, trigger CAMPAIGN_PERFORMANCE_BUDGET
console.log('\n[2] POST /automation-rules (budget)')
const payload = {
  name: `__verify Budget ${Date.now()}`,
  description: 'Budget — verify',
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  conditions: [{ match: 'all', lookback: 'Last 30 Days', exclude: 'Last 3 Days',
    conditions: [{ metric: 'ACOS', op: 'gt', value: '25' }], action: { op: 'incPct', value: '20' } }],
  actions: [{ type: 'budget', control: 'manual',
    campaigns: [{ id: c0?.id ?? 'c1', name: c0?.name ?? 'C', marketplace: c0?.marketplace ?? 'DE', adProduct: 'SP', targetingType: 'AUTO', dailyBudget: c0?.dailyBudget != null ? Number(c0.dailyBudget) : 10 }],
    budgetFloor: 1, budgetCeiling: 50,
    schedule: { frequency: 'Daily', time: '00:00', timezone: 'pst' } }],
  maxDailyAdSpendCentsEur: 5000, scopeMarketplace: 'DE',
}
const created = await j('/automation-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const rule = created.body.rule ?? created.body
ok(created.status === 200 && !!rule?.id, 'created (200 + id)')
ok(rule?.enabled === false, 'starts disabled (enabled=false)')
ok(rule?.dryRun === true, 'starts dry-run (dryRun=true)')
ok(rule?.trigger === 'CAMPAIGN_PERFORMANCE_BUDGET', 'trigger = CAMPAIGN_PERFORMANCE_BUDGET')
ok(rule?.maxDailyAdSpendCentsEur === 5000, 'spend cap (maxDailyAdSpendCentsEur) stored')
ok(rule?.scopeMarketplace === 'DE', 'marketplace scope stored')
const id = rule?.id

// 3) GET :id — full budget shape round-trips
console.log('\n[3] GET /automation-rules/:id')
const got = id ? (await j(`/automation-rules/${id}`)).body.rule : null
const cnd = got?.conditions?.[0] ?? {}; const act = got?.actions?.[0] ?? {}
ok(cnd?.conditions?.[0]?.metric === 'ACOS', 'IF criterion (ACOS) stored')
ok(cnd?.action?.op === 'incPct' && cnd?.action?.value === '20', 'THEN budget action (incPct 20) stored')
ok(Array.isArray(act?.campaigns) && act.campaigns.length >= 1, 'selected campaigns stored')
ok(act?.budgetFloor === 1 && act?.budgetCeiling === 50, 'guardrails (floor 1 / ceiling 50) stored')

// 4) PATCH :id — rename + flip action to Set, ceiling 80
console.log('\n[4] PATCH /automation-rules/:id')
const renamed = `${payload.name} (edited)`
const patched = id ? await j(`/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, name: renamed,
    conditions: [{ ...payload.conditions[0], action: { op: 'set', value: '15' } }],
    actions: [{ ...payload.actions[0], budgetCeiling: 80 }] }) }) : { status: 0 }
ok(patched.status === 200, 'patch 200')
const after = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(after?.name === renamed, 'name updated')
ok(after?.conditions?.[0]?.action?.op === 'set', 'action updated → Set')
ok(after?.actions?.[0]?.budgetCeiling === 80, 'ceiling updated → 80')

// 5) DELETE :id — cleanup (no test rows left in the DB)
console.log('\n[5] DELETE /automation-rules/:id (cleanup)')
const del = id ? await j(`/automation-rules/${id}`, { method: 'DELETE' }) : { status: 0 }
ok(del.status === 200, 'delete 200')
ok((id ? (await j(`/automation-rules/${id}`)).status : 0) === 404, 'gone (404)')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
