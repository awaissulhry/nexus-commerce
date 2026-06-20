#!/usr/bin/env node
/**
 * verify-placement-builder.mjs — P3 verifier for the Placement rule builder backend.
 *
 * Asserts the create/edit/delete cycle the Placement builder relies on, with the placement
 * payload (campaigns + IF placement-scope + THEN placement-target/action/% modifier) persisted
 * through the automation-rules store. Sibling to verify-budget-builder.mjs. Default PROD.
 *
 *   node scripts/verify-placement-builder.mjs
 *   API_BASE=http://localhost:4001 node scripts/verify-placement-builder.mjs
 */
const BASE = (process.env.API_BASE || 'https://nexusapi-production-b7bb.up.railway.app').replace(/\/$/, '')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const j = async (path, init) => { const r = await fetch(`${BASE}/api/advertising${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) } }

console.log(`verify-placement-builder → ${BASE}`)

// 1) GET /campaigns (picker + the placements:{tos,pdp,ros} the Preview reads)
console.log('\n[1] GET /campaigns')
const camps = await j('/campaigns?limit=3')
ok(camps.status === 200 && Array.isArray(camps.body.items), 'campaigns 200 + items[]')
const c0 = camps.body.items?.[0]
ok(!!c0 && 'placements' in c0, 'campaign rows carry placements{tos,pdp,ros} (Preview source)')

// 2) POST a placement rule — trigger CAMPAIGN_PERFORMANCE_BUDGET, disabled + dry-run
console.log('\n[2] POST /automation-rules (placement)')
const payload = {
  name: `__verify Placement ${Date.now()}`,
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  conditions: [{ match: 'all', lookback: 'Last 60 Days', exclude: 'Last 3 Days',
    conditions: [{ metric: 'ACOS', op: 'gt', value: '30', scope: 'tos' }],
    action: { op: 'decPct', value: '20', placeTarget: 'tos' } }],
  actions: [{ type: 'placement', control: 'manual',
    campaigns: [{ id: c0?.id ?? 'c1', name: c0?.name ?? 'C', marketplace: c0?.marketplace ?? 'IT', adProduct: 'SP', dailyBudget: 10 }] }],
}
const created = await j('/automation-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const rule = created.body.rule ?? created.body
ok(created.status === 200 && !!rule?.id, 'created (200 + id)')
ok(rule?.enabled === false, 'starts disabled')
ok(rule?.dryRun === true, 'starts dry-run')
ok(rule?.trigger === 'CAMPAIGN_PERFORMANCE_BUDGET', 'trigger = CAMPAIGN_PERFORMANCE_BUDGET')
const id = rule?.id

// 3) GET :id — placement shape round-trips
console.log('\n[3] GET /automation-rules/:id')
const got = id ? (await j(`/automation-rules/${id}`)).body.rule : null
const cnd = got?.conditions?.[0] ?? {}; const act = got?.actions?.[0] ?? {}
ok(cnd?.conditions?.[0]?.scope === 'tos', 'IF placement-scope (tos) stored')
ok(cnd?.action?.op === 'decPct' && cnd?.action?.value === '20', 'THEN action (decPct 20) stored')
ok(cnd?.action?.placeTarget === 'tos', 'THEN placement target (tos) stored')
ok(act?.type === 'placement', 'action type = placement')
ok(Array.isArray(act?.campaigns) && act.campaigns.length >= 1, 'campaigns stored')

// 4) PATCH :id — rename + flip target to pdp / action to incPct
console.log('\n[4] PATCH /automation-rules/:id')
const renamed = `${payload.name} (edited)`
const patched = id ? await j(`/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, name: renamed, conditions: [{ ...payload.conditions[0], action: { op: 'incPct', value: '15', placeTarget: 'pdp' } }] }) }) : { status: 0 }
ok(patched.status === 200, 'patch 200')
const after = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(after?.name === renamed, 'name updated')
ok(after?.conditions?.[0]?.action?.placeTarget === 'pdp', 'placement target updated → pdp')
ok(after?.conditions?.[0]?.action?.op === 'incPct', 'action updated → incPct')

// 5) DELETE :id — cleanup
console.log('\n[5] DELETE /automation-rules/:id (cleanup)')
const del = id ? await j(`/automation-rules/${id}`, { method: 'DELETE' }) : { status: 0 }
ok(del.status === 200, 'delete 200')
ok((id ? (await j(`/automation-rules/${id}`)).status : 0) === 404, 'gone (404)')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
