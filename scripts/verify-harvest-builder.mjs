#!/usr/bin/env node
/**
 * verify-harvest-builder.mjs — H8 verifier for the Keyword Harvesting rule builder backend.
 *
 * Asserts the H2 ad-groups list endpoint + the H6 create/edit/delete cycle that the
 * builder relies on. Runs against a live API (default the local dev API on :4001;
 * override with API_BASE=https://… for prod once the endpoint ships).
 *
 *   node scripts/verify-harvest-builder.mjs
 *   API_BASE=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-harvest-builder.mjs
 */
const BASE = (process.env.API_BASE || 'http://localhost:4001').replace(/\/$/, '')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }
const j = async (path, init) => { const r = await fetch(`${BASE}/api/advertising${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) } }

console.log(`verify-harvest-builder → ${BASE}`)

// 1) GET /ad-groups (H2)
console.log('\n[1] GET /ad-groups')
const ag = await j('/ad-groups?limit=5')
ok(ag.status === 200, 'returns 200')
ok(Array.isArray(ag.body.items), 'items[] present')
const g0 = ag.body.items?.[0]
ok(!!g0 && 'campaignName' in g0 && 'campaignStatus' in g0 && 'adProduct' in g0, 'rows carry campaign context (campaignName/campaignStatus/adProduct)')

// 2) POST a harvest rule (H6) — must start disabled + dry-run
console.log('\n[2] POST /automation-rules (harvest)')
const payload = {
  name: `__verify Harvest ${Date.now()}`,
  trigger: 'SEARCH_TERM_CONVERTING',
  conditions: [{ match: 'all', lookback: 'Last 60 Days', exclude: 'Last 3 Days', conditions: [{ metric: 'PPC Orders', op: 'gte', value: '1' }] }],
  actions: [{ type: 'keyword-harvesting', control: 'manual', dedupe: true, negateInSource: true,
    bid: { mode: 'suggested', value: '' }, filters: { brandExclude: ['xavia'], competitorOnly: false },
    searchTerms: [{ term: 'running shoes', op: 'contains' }],
    schedule: { frequency: 'Daily', time: '00:00', timezone: 'pst' },
    mappings: [{ groups: [{ id: g0?.id ?? 'ag1', name: g0?.name ?? 'AG', campaignId: g0?.campaignId ?? 'c1', campaignName: g0?.campaignName ?? 'C', look: true, types: { P: true, E: true, product: false } }] }] }],
}
const created = await j('/automation-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const rule = created.body.rule ?? created.body
ok(created.status === 200 && !!rule?.id, 'created (200 + id)')
ok(rule?.enabled === false, 'starts disabled (enabled=false)')
ok(rule?.dryRun === true, 'starts dry-run (dryRun=true)')
ok(rule?.trigger === 'SEARCH_TERM_CONVERTING', 'trigger = SEARCH_TERM_CONVERTING')
const id = rule?.id

// 3) GET :id — full shape stored
console.log('\n[3] GET /automation-rules/:id')
const got = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(got?.conditions?.[0]?.conditions?.[0]?.metric === 'PPC Orders', 'criteria conditions stored')
ok(got?.actions?.[0]?.mappings?.[0]?.groups?.length >= 1, 'mappings (ad-group sources) stored')
ok(got?.actions?.[0]?.negateInSource === true, 'negate-in-source stored')
ok(Array.isArray(got?.actions?.[0]?.searchTerms), 'search terms stored')

// 4) PATCH :id — rename
console.log('\n[4] PATCH /automation-rules/:id')
const renamed = `${payload.name} (edited)`
const patched = id ? await j(`/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, name: renamed }) }) : { status: 0 }
ok(patched.status === 200, 'patch 200')
const after = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(after?.name === renamed, 'name updated')

// 5) DELETE :id — cleanup
console.log('\n[5] DELETE /automation-rules/:id (cleanup)')
const del = id ? await j(`/automation-rules/${id}`, { method: 'DELETE' }) : { status: 0 }
ok(del.status === 200, 'delete 200')
const gone = id ? (await j(`/automation-rules/${id}`)).status : 0
ok(gone === 404, 'gone (404)')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
