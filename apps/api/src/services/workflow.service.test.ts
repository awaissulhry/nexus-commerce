/**
 * W3.2 — Pure-function tests for validateWorkflow + slaState.
 *
 * No DB. Run with `npx tsx <file>`.
 */

import {
  slaState,
  validateWorkflow,
} from './workflow.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}
function truthy(v: unknown, msg = '') {
  if (!v) throw new Error(`${msg} expected truthy, got=${JSON.stringify(v)}`)
}

// ── validateWorkflow ───────────────────────────────────────────

test('validateWorkflow: empty stage list rejected', () => {
  const r = validateWorkflow([])
  eq(r.ok, false)
  truthy(r.errors.some((e) => /at least one stage/.test(e)))
})

test('validateWorkflow: zero isInitial rejected', () => {
  const r = validateWorkflow([
    { code: 'a', isInitial: false, isTerminal: false },
    { code: 'b', isInitial: false, isTerminal: false },
  ])
  truthy(r.errors.some((e) => /exactly one isInitial/.test(e)))
})

test('validateWorkflow: two isInitial rejected', () => {
  const r = validateWorkflow([
    { code: 'a', isInitial: true, isTerminal: false },
    { code: 'b', isInitial: true, isTerminal: false },
  ])
  truthy(r.errors.some((e) => /2 isInitial=true/.test(e)))
})

test('validateWorkflow: two isTerminal rejected', () => {
  const r = validateWorkflow([
    { code: 'a', isInitial: true, isTerminal: false },
    { code: 'b', isInitial: false, isTerminal: true },
    { code: 'c', isInitial: false, isTerminal: true },
  ])
  truthy(r.errors.some((e) => /2 isTerminal=true/.test(e)))
})

test('validateWorkflow: zero isTerminal is OK (workflow can be open-ended)', () => {
  const r = validateWorkflow([
    { code: 'draft', isInitial: true, isTerminal: false },
    { code: 'review', isInitial: false, isTerminal: false },
  ])
  eq(r.ok, true)
  eq(r.errors, [])
})

test('validateWorkflow: duplicate stage codes rejected', () => {
  const r = validateWorkflow([
    { code: 'draft', isInitial: true, isTerminal: false },
    { code: 'draft', isInitial: false, isTerminal: false },
  ])
  truthy(r.errors.some((e) => /"draft" appears 2 times/.test(e)))
})

test('validateWorkflow: canonical happy path', () => {
  const r = validateWorkflow([
    { code: 'draft', isInitial: true, isTerminal: false },
    { code: 'review', isInitial: false, isTerminal: false },
    { code: 'approved', isInitial: false, isTerminal: false },
    { code: 'published', isInitial: false, isTerminal: true },
  ])
  eq(r.ok, true)
})

// ── slaState ───────────────────────────────────────────────────

test('slaState: no SLA on stage → no_sla', () => {
  const r = slaState({ slaHours: null }, new Date('2026-05-09T10:00:00Z'), new Date('2026-05-09T11:00:00Z'))
  eq(r.state, 'no_sla')
  eq(r.dueAt, null)
  eq(r.hoursRemaining, null)
})

test('slaState: well within budget → on_track', () => {
  // Stage SLA 24h. Entered 2h ago. 22h remaining = 91% remaining.
  const enteredAt = new Date('2026-05-09T10:00:00Z')
  const now = new Date('2026-05-09T12:00:00Z')
  const r = slaState({ slaHours: 24 }, enteredAt, now)
  eq(r.state, 'on_track')
  eq(r.hoursRemaining, 22)
})

test('slaState: under 25% remaining → soon', () => {
  // Stage SLA 24h. Entered 20h ago. 4h remaining = 16% remaining.
  const enteredAt = new Date('2026-05-09T00:00:00Z')
  const now = new Date('2026-05-09T20:00:00Z')
  const r = slaState({ slaHours: 24 }, enteredAt, now)
  eq(r.state, 'soon')
  eq(r.hoursRemaining, 4)
})

test('slaState: past due → overdue with negative hours', () => {
  // Stage SLA 24h. Entered 30h ago. -6h remaining.
  const enteredAt = new Date('2026-05-09T00:00:00Z')
  const now = new Date('2026-05-10T06:00:00Z')
  const r = slaState({ slaHours: 24 }, enteredAt, now)
  eq(r.state, 'overdue')
  eq(r.hoursRemaining, -6)
})

test('slaState: dueAt is enteredAt + slaHours', () => {
  const enteredAt = new Date('2026-05-09T00:00:00Z')
  const r = slaState({ slaHours: 24 }, enteredAt, enteredAt)
  eq(r.dueAt, '2026-05-10T00:00:00.000Z')
})

test('slaState: handles ISO string input', () => {
  const r = slaState(
    { slaHours: 24 },
    '2026-05-09T00:00:00Z',
    new Date('2026-05-09T12:00:00Z'),
  )
  eq(r.state, 'on_track')
  eq(r.hoursRemaining, 12)
})

let failed = 0
for (const t of tests) {
  try {
    t.fn()
    console.log(`  ok  ${t.name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${t.name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
