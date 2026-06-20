#!/usr/bin/env node
/**
 * verify-dayparting-builder.mjs — D-INT3 verifier for the Dayparting Schedule builder backend.
 *
 * Asserts the create/edit/delete cycle the Dayparting builder relies on, with the schedule
 * payload (timezone + campaigns + weekly windows w/ Enable/Pause + dates) persisted through the
 * automation-rules store (trigger SCHEDULE). Sibling to verify-budget-builder.mjs. Default PROD.
 *
 *   node scripts/verify-dayparting-builder.mjs
 *   API_BASE=http://localhost:4001 node scripts/verify-dayparting-builder.mjs
 */
const BASE = (process.env.API_BASE || 'https://nexusapi-production-b7bb.up.railway.app').replace(/\/$/, '')
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } }
const j = async (path, init) => { const r = await fetch(`${BASE}/api/advertising${path}`, init); return { status: r.status, body: await r.json().catch(() => ({})) } }

console.log(`verify-dayparting-builder → ${BASE}`)

// 1) GET /campaigns (the Campaign Section source)
console.log('\n[1] GET /campaigns')
const camps = await j('/campaigns?limit=3')
ok(camps.status === 200 && Array.isArray(camps.body.items), 'campaigns 200 + items[]')
const c0 = camps.body.items?.[0]

// 2) POST a dayparting schedule — trigger SCHEDULE, starts disabled + dry-run
console.log('\n[2] POST /automation-rules (dayparting-schedule)')
const payload = {
  name: `__verify Dayparting ${Date.now()}`,
  trigger: 'SCHEDULE',
  conditions: [],
  actions: [{ type: 'dayparting-schedule', timezone: 'Europe/Rome',
    campaigns: [{ id: c0?.id ?? 'c1', name: c0?.name ?? 'C', marketplace: c0?.marketplace ?? 'IT', adProduct: 'SP', dailyBudget: 10 }],
    windows: [{ day: 1, start: '18:00', end: '23:00', adj: 'enable', value: 0 }, { day: 1, start: '00:00', end: '06:00', adj: 'pause', value: 0 }],
    chartPrefs: { metric1: 'Spend', metric2: 'ACoS', groupBy: 'hour', daysFilter: 'all' },
    startDate: null, endDate: null, neverExpire: true, excludeDates: false }],
}
const created = await j('/automation-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
const rule = created.body.rule ?? created.body
ok(created.status === 200 && !!rule?.id, 'created (200 + id)')
ok(rule?.enabled === false, 'starts disabled (enabled=false)')
ok(rule?.dryRun === true, 'starts dry-run (dryRun=true)')
ok(rule?.trigger === 'SCHEDULE', 'trigger = SCHEDULE')
const id = rule?.id

// 3) GET :id — schedule shape round-trips
console.log('\n[3] GET /automation-rules/:id')
const got = id ? (await j(`/automation-rules/${id}`)).body.rule : null
const a = got?.actions?.[0] ?? {}
ok(a.type === 'dayparting-schedule', 'action type = dayparting-schedule')
ok(a.timezone === 'Europe/Rome', 'timezone stored')
ok(Array.isArray(a.campaigns) && a.campaigns.length >= 1, 'campaigns stored')
ok(Array.isArray(a.windows) && a.windows.length === 2, 'weekly windows stored')
ok(a.windows?.[0]?.adj === 'enable' && a.windows?.[1]?.adj === 'pause', 'Enable/Pause adjustments stored')
ok(a.neverExpire === true, 'neverExpire stored')

// 4) PATCH :id — rename + flip a window to a different time
console.log('\n[4] PATCH /automation-rules/:id')
const renamed = `${payload.name} (edited)`
const patched = id ? await j(`/automation-rules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...payload, name: renamed, actions: [{ ...payload.actions[0], timezone: 'Europe/Madrid' }] }) }) : { status: 0 }
ok(patched.status === 200, 'patch 200')
const after = id ? (await j(`/automation-rules/${id}`)).body.rule : null
ok(after?.name === renamed, 'name updated')
ok(after?.actions?.[0]?.timezone === 'Europe/Madrid', 'timezone updated → Madrid')

// 5) DELETE :id — cleanup
console.log('\n[5] DELETE /automation-rules/:id (cleanup)')
const del = id ? await j(`/automation-rules/${id}`, { method: 'DELETE' }) : { status: 0 }
ok(del.status === 200, 'delete 200')
ok((id ? (await j(`/automation-rules/${id}`)).status : 0) === 404, 'gone (404)')

console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
