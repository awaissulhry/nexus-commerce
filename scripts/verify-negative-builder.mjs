#!/usr/bin/env node
/**
 * verify-negative-builder.mjs — N3 verifier for the Negative Targeting rule builder backend.
 *
 * Asserts the N2 Preview source (/reports/negative-keyword-candidates) + the create/edit/delete
 * cycle with the N2 negative-only fields (protectConverting / protectDays / negationLevel) and the
 * brand-protection list round-tripping through the stored action JSON. Sibling to
 * verify-harvest-builder.mjs. Runs against a live API (default local dev :4001).
 *
 *   node scripts/verify-negative-builder.mjs
 *   API_BASE=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-negative-builder.mjs
 */
const BASE = (process.env.API_BASE || 'http://localhost:4001').replace(/\/$/, '')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }
const j = async (path, init) => { const r = await fetch(`${BASE}/api/advertising${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) } }

console.log(`verify-negative-builder → ${BASE}`)

// 1) GET /ad-groups (shared Rule Setup source)
console.log('\n[1] GET /ad-groups')
const ag = await j('/ad-groups?limit=5')
ok(ag.status === 200 && Array.isArray(ag.body.items), 'ad-groups 200 + items[]')
const g0 = ag.body.items?.[0]

// 2) GET /reports/negative-keyword-candidates (the N2 Preview source)
console.log('\n[2] GET /reports/negative-keyword-candidates (Preview source)')
const cand = await j('/reports/negative-keyword-candidates?lookbackDays=60&minSpend=0&limit=5')
ok(cand.status === 200, 'candidates 200')
ok(Array.isArray(cand.body.candidates), 'candidates[] present')
const c0 = cand.body.candidates?.[0]
ok(!!c0 && 'query' in c0 && 'matchType' in c0 && 'totalClicks' in c0 && 'totalCostUnits' in c0,
  'candidate shape carries query/matchType/totalClicks/totalCostUnits (Preview columns)')

// 3) POST a negative rule carrying the N2 fields — must start disabled + dry-run
console.log('\n[3] POST /automation-rules (negative)')
const payload = {
  name: `__verify Negative ${Date.now()}`,
  description: 'Negative Targeting — verify',
  trigger: 'SEARCH_TERM_WASTING',
  conditions: [{ match: 'all', lookback: 'Last 60 Days', exclude: 'Last 3 Days', conditions: [{ metric: 'Sales', op: 'eq', value: '0' }] }],
  actions: [{ type: 'negative-targeting', control: 'manual', dedupe: true, negateInSource: false,
    bid: { mode: 'suggested', value: '' }, filters: { brandExclude: ['xavia'], competitorOnly: false },
    searchTerms: [{ term: 'free', op: 'contains' }],
    schedule: { frequency: 'Daily', time: '00:00', timezone: 'pst' },
    protectConverting: true, protectDays: 30, negationLevel: 'campaign',
    mappings: [{ groups: [{ id: g0?.id ?? 'ag1', name: g0?.name ?? 'AG', campaignId: g0?.campaignId ?? 'c1', campaignName: g0?.campaignName ?? 'C', look: true, types: { P: true, E: true, product: false } }] }] }],
}
const created = await j('/automation-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const rule = created.body.rule ?? created.body
ok(created.status === 200 && !!rule?.id, 'created (200 + id)')
ok(rule?.enabled === false, 'starts disabled (enabled=false)')
ok(rule?.dryRun === true, 'starts dry-run (dryRun=true)')
ok(rule?.trigger === 'SEARCH_TERM_WASTING', 'trigger = SEARCH_TERM_WASTING')
const id = rule?.id

// 4) GET :id — the N2 negative-only fields round-trip
console.log('\n[4] GET /automation-rules/:id')
const got = id ? (await j(`/automation-rules/${id}`)).body.rule : null
const a = got?.actions?.[0] ?? {}
ok(got?.conditions?.[0]?.conditions?.[0]?.metric === 'Sales', 'criteria (Sales=0) stored')
ok(a.protectConverting === true, 'protectConverting stored')
ok(a.protectDays === 30, 'protectDays stored')
ok(a.negationLevel === 'campaign', 'negationLevel stored')
ok(Array.isArray(a.filters?.brandExclude) && a.filters.brandExclude.includes('xavia'), 'brand-protection list stored')
ok(a.mappings?.[0]?.groups?.length >= 1, 'mappings (ad-group sources) stored')

// 5) PATCH :id — rename + flip negationLevel (edit-mode write-through)
console.log('\n[5] PATCH /automation-rules/:id')
const renamed = `${payload.name} (edited)`
const patched = id ? await j(`/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, name: renamed, actions: [{ ...payload.actions[0], negationLevel: 'both' }] }) }) : { status: 0 }
ok(patched.status === 200, 'patch 200')
const after = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(after?.name === renamed, 'name updated')
ok(after?.actions?.[0]?.negationLevel === 'both', 'negationLevel updated → both')

// 6) DELETE :id — cleanup (no test data left in the DB)
console.log('\n[6] DELETE /automation-rules/:id (cleanup)')
const del = id ? await j(`/automation-rules/${id}`, { method: 'DELETE' }) : { status: 0 }
ok(del.status === 200, 'delete 200')
ok((id ? (await j(`/automation-rules/${id}`)).status : 0) === 404, 'gone (404)')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
