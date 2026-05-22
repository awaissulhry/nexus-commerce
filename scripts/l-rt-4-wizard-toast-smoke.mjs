// L-RT.4 — smoke for the WizardActivityToast filter logic.
// Mirrors the production effect in
// apps/web/src/app/listings/_components/WizardActivityToast.tsx:
//   1. Only react to type === 'wizard.submitted' events
//   2. Map status (LIVE | SUBMITTED | FAILED) → toast variant
//   3. Dedup by wizardId+ts
//
// Run:
//   node scripts/l-rt-4-wizard-toast-smoke.mjs
// Exit 0 = pass, 1 = filter or dedup broke.

function classify(event, toastedKeys) {
  if (!event) return { skip: 'no event' }
  if (event.type !== 'wizard.submitted') return { skip: 'wrong type' }
  if (!event.wizardId) return { skip: 'no wizardId' }
  const dedupKey = `${event.wizardId}:${event.ts ?? 0}`
  if (toastedKeys.has(dedupKey)) return { skip: 'already toasted' }
  toastedKeys.add(dedupKey)
  if (event.status === 'LIVE') return { toast: 'success' }
  if (event.status === 'SUBMITTED') return { toast: 'info' }
  if (event.status === 'FAILED') return { toast: 'error' }
  return { skip: 'unknown status' }
}

const cases = [
  {
    name: 'LIVE → success toast',
    event: { type: 'wizard.submitted', wizardId: 'w_1', status: 'LIVE', ts: 1 },
    expect: { toast: 'success' },
  },
  {
    name: 'SUBMITTED → info toast',
    event: { type: 'wizard.submitted', wizardId: 'w_2', status: 'SUBMITTED', ts: 2 },
    expect: { toast: 'info' },
  },
  {
    name: 'FAILED → error toast',
    event: { type: 'wizard.submitted', wizardId: 'w_3', status: 'FAILED', ts: 3 },
    expect: { toast: 'error' },
  },
  {
    name: 'wrong type → no toast',
    event: { type: 'listing.synced', wizardId: 'w_4', status: 'LIVE', ts: 4 },
    expect: { skip: 'wrong type' },
  },
  {
    name: 'unknown status → no toast',
    event: { type: 'wizard.submitted', wizardId: 'w_5', status: 'DRAFT', ts: 5 },
    expect: { skip: 'unknown status' },
  },
  {
    name: 'null event → no-op',
    event: null,
    expect: { skip: 'no event' },
  },
  {
    name: 'missing wizardId → no toast',
    event: { type: 'wizard.submitted', status: 'LIVE', ts: 6 },
    expect: { skip: 'no wizardId' },
  },
]

let ok = true
let toastedKeys = new Set()
for (const c of cases) {
  const got = classify(c.event, toastedKeys)
  const fail = Object.entries(c.expect).some(([k, v]) => got[k] !== v)
  if (fail) {
    console.log(`[smoke] FAIL — ${c.name}`)
    console.log(`   want ${JSON.stringify(c.expect)}`)
    console.log(`   got  ${JSON.stringify(got)}`)
    ok = false
  } else {
    console.log(`[smoke] PASS — ${c.name}`)
  }
}

// Dedup case
toastedKeys = new Set()
const dup = { type: 'wizard.submitted', wizardId: 'w_dup', status: 'LIVE', ts: 99 }
const first = classify(dup, toastedKeys)
const second = classify(dup, toastedKeys)
if (first.toast === 'success' && second.skip === 'already toasted') {
  console.log('[smoke] PASS — dedup blocks second toast for same wizardId+ts')
} else {
  console.log('[smoke] FAIL — dedup not blocking')
  console.log(`   first: ${JSON.stringify(first)}`)
  console.log(`   second: ${JSON.stringify(second)}`)
  ok = false
}

process.exit(ok ? 0 : 1)
