/**
 * R.7 — Pure-function tests for the PO workflow state machine.
 *
 * Tests only nextStatus() (deterministic). The persistence side-
 * effect (transitionPo) needs a DB and lands with the Vitest harness
 * in TECH_DEBT #42.
 */

import { nextStatus } from './po-workflow.service.js'

const tests: Array<{ name: string; fn: () => void }> = []
function test(name: string, fn: () => void) { tests.push({ name, fn }) }
function eq(a: unknown, b: unknown, msg = '') {
  const x = JSON.stringify(a); const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected=${y} actual=${x}`)
}

// ─── Happy path: requireApproval = true (multi-person workflow) ───
test('DRAFT + submit-for-review (require) → REVIEW', () => {
  const r = nextStatus({ current: 'DRAFT', transition: 'submit-for-review', requireApproval: true })
  eq(r, { ok: true, next: 'REVIEW', autoAdvanced: [] })
})
test('REVIEW + approve → APPROVED', () => {
  const r = nextStatus({ current: 'REVIEW', transition: 'approve', requireApproval: true })
  eq(r, { ok: true, next: 'APPROVED', autoAdvanced: [] })
})
test('APPROVED + send → SUBMITTED', () => {
  const r = nextStatus({ current: 'APPROVED', transition: 'send', requireApproval: true })
  eq(r, { ok: true, next: 'SUBMITTED', autoAdvanced: [] })
})
test('SUBMITTED + acknowledge → ACKNOWLEDGED', () => {
  const r = nextStatus({ current: 'SUBMITTED', transition: 'acknowledge', requireApproval: true })
  eq(r, { ok: true, next: 'ACKNOWLEDGED', autoAdvanced: [] })
})

// ─── Auto-advance: requireApproval = false (single-operator) ───
test('DRAFT + submit-for-review (no-require) → APPROVED with REVIEW auto-advanced', () => {
  const r = nextStatus({ current: 'DRAFT', transition: 'submit-for-review', requireApproval: false })
  eq(r, { ok: true, next: 'APPROVED', autoAdvanced: ['REVIEW'] })
})
test('approve from REVIEW does NOT auto-advance further (just APPROVED)', () => {
  const r = nextStatus({ current: 'REVIEW', transition: 'approve', requireApproval: false })
  eq(r, { ok: true, next: 'APPROVED', autoAdvanced: [] })
})

// ─── Cancellation ───
test('DRAFT + cancel → CANCELLED', () => {
  const r = nextStatus({ current: 'DRAFT', transition: 'cancel', requireApproval: true })
  eq(r, { ok: true, next: 'CANCELLED', autoAdvanced: [] })
})
test('REVIEW + cancel → CANCELLED', () => {
  const r = nextStatus({ current: 'REVIEW', transition: 'cancel', requireApproval: true })
  eq(r, { ok: true, next: 'CANCELLED', autoAdvanced: [] })
})
test('APPROVED + cancel → CANCELLED (still allowed pre-send)', () => {
  const r = nextStatus({ current: 'APPROVED', transition: 'cancel', requireApproval: true })
  eq(r, { ok: true, next: 'CANCELLED', autoAdvanced: [] })
})
test('SUBMITTED + cancel → REJECTED (already-sent must contact supplier)', () => {
  const r = nextStatus({ current: 'SUBMITTED', transition: 'cancel', requireApproval: true })
  eq(r.ok, false)
})

// ─── Illegal transitions ───
test('DRAFT + approve → REJECTED (must submit-for-review first)', () => {
  const r = nextStatus({ current: 'DRAFT', transition: 'approve', requireApproval: true })
  eq(r.ok, false)
})
test('DRAFT + send → REJECTED (must go through review)', () => {
  const r = nextStatus({ current: 'DRAFT', transition: 'send', requireApproval: true })
  eq(r.ok, false)
})
test('APPROVED + acknowledge → REJECTED (must send first)', () => {
  const r = nextStatus({ current: 'APPROVED', transition: 'acknowledge', requireApproval: true })
  eq(r.ok, false)
})
test('ACKNOWLEDGED + submit-for-review → REJECTED (terminal-ish)', () => {
  const r = nextStatus({ current: 'ACKNOWLEDGED', transition: 'submit-for-review', requireApproval: true })
  eq(r.ok, false)
})
test('CANCELLED + any transition → REJECTED', () => {
  const r1 = nextStatus({ current: 'CANCELLED', transition: 'submit-for-review', requireApproval: true })
  const r2 = nextStatus({ current: 'CANCELLED', transition: 'approve', requireApproval: false })
  eq(r1.ok, false)
  eq(r2.ok, false)
})

// ─── Legacy CONFIRMED status is read-only for R.7 ───
test('CONFIRMED + any → REJECTED (legacy alias, R.7 has no transitions out)', () => {
  const r = nextStatus({ current: 'CONFIRMED', transition: 'cancel', requireApproval: true })
  eq(r.ok, false)
})

let passed = 0
const failures: string[] = []
for (const t of tests) {
  try { t.fn(); passed++ } catch (e: any) { failures.push(`${t.name}: ${e.message}`) }
}
if (failures.length > 0) {
  console.error(`po-workflow.service.test: ${passed}/${tests.length} passed`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}

export {}
