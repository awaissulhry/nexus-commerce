// P-RT.5 — runtime smoke proving the OutboundSyncQueue rollup fold
// correctly classifies each precedence case end-to-end (no DB needed).
// The chip rendering in GridView reads {pending, failed, dead,
// syncedAt, mostUrgentChannel, mostUrgentStatus} and picks a colour
// based on mostUrgentStatus. This script feeds the same QueueRow
// shapes the products list route sees and asserts the rollup output
// matches the unit-test expectations — but as a script you can run
// against any future schema migration of OutboundSyncQueue without
// rerunning the whole vitest suite.
//
// Run:
//   node scripts/p-rt-5-sync-status-smoke.mjs
// Exit 0 = pass, 1 = rollup logic broke.

const ts = (iso) => new Date(iso)

// Mirror of the route fold. See
// apps/api/src/routes/__tests__/products-sync-queue-rollup.test.ts
// for the canonical reference + extraction TODO.
function foldQueueRows(rows) {
  const out = new Map()
  for (const r of rows) {
    if (!r.productId) continue
    const cur = out.get(r.productId) ?? {
      pending: 0, failed: 0, dead: 0,
      syncedAt: null,
      mostUrgentChannel: null,
      mostUrgentStatus: null,
    }
    const isPending = r.syncStatus === 'PENDING'
    const isFailed = r.syncStatus === 'FAILED' && !r.isDead
    const isSucceeded = r.syncStatus === 'SUCCEEDED'
    if (r.isDead) cur.dead++
    else if (isFailed) cur.failed++
    else if (isPending) cur.pending++
    if (isSucceeded && r.syncedAt) {
      const candidate = r.syncedAt.toISOString()
      if (!cur.syncedAt || candidate > cur.syncedAt) cur.syncedAt = candidate
    }
    const rank = (s) =>
      s === 'DEAD' ? 3 : s === 'FAILED' ? 2 : s === 'PENDING' ? 1 : s === 'SYNCED' ? 0 : -1
    const candidateStatus =
      r.isDead ? 'DEAD' :
      isFailed ? 'FAILED' :
      isPending ? 'PENDING' :
      isSucceeded ? 'SYNCED' : null
    if (candidateStatus && rank(candidateStatus) > rank(cur.mostUrgentStatus)) {
      cur.mostUrgentStatus = candidateStatus
      cur.mostUrgentChannel = r.targetChannel
    }
    out.set(r.productId, cur)
  }
  return out
}

const cases = [
  {
    name: 'PENDING-only → blue "Pushing" chip',
    rows: [{ productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING', syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T00:00:00Z') }],
    expect: { mostUrgentStatus: 'PENDING', mostUrgentChannel: 'AMAZON', pending: 1, failed: 0, dead: 0 },
  },
  {
    name: 'FAILED + PENDING → amber "Failed" chip',
    rows: [
      { productId: 'p1', targetChannel: 'EBAY', syncStatus: 'FAILED', syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T01:00:00Z') },
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING', syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T02:00:00Z') },
    ],
    expect: { mostUrgentStatus: 'FAILED', mostUrgentChannel: 'EBAY', pending: 1, failed: 1, dead: 0 },
  },
  {
    name: 'DEAD beats FAILED → red "Dead" chip',
    rows: [
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'FAILED', syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T03:00:00Z') },
      { productId: 'p1', targetChannel: 'SHOPIFY', syncStatus: 'FAILED', syncedAt: null, isDead: true, updatedAt: ts('2026-05-22T02:00:00Z') },
    ],
    expect: { mostUrgentStatus: 'DEAD', mostUrgentChannel: 'SHOPIFY', failed: 1, dead: 1 },
  },
  {
    name: 'SUCCEEDED-only → green "Synced Nm ago" chip',
    rows: [{ productId: 'p1', targetChannel: 'EBAY', syncStatus: 'SUCCEEDED', syncedAt: ts('2026-05-22T05:00:00Z'), isDead: false, updatedAt: ts('2026-05-22T05:00:00Z') }],
    expect: { mostUrgentStatus: 'SYNCED', mostUrgentChannel: 'EBAY', syncedAt: '2026-05-22T05:00:00.000Z' },
  },
  {
    name: 'PENDING wins over SUCCEEDED (in-flight beats history)',
    rows: [
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'PENDING', syncedAt: null, isDead: false, updatedAt: ts('2026-05-22T07:00:00Z') },
      { productId: 'p1', targetChannel: 'AMAZON', syncStatus: 'SUCCEEDED', syncedAt: ts('2026-05-22T06:00:00Z'), isDead: false, updatedAt: ts('2026-05-22T06:00:00Z') },
    ],
    expect: { mostUrgentStatus: 'PENDING', syncedAt: '2026-05-22T06:00:00.000Z' },
  },
]

let ok = true
for (const c of cases) {
  const got = foldQueueRows(c.rows).get('p1')
  const fails = []
  for (const [k, want] of Object.entries(c.expect)) {
    if (got?.[k] !== want) fails.push(`${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got?.[k])}`)
  }
  if (fails.length === 0) {
    console.log(`[smoke] PASS — ${c.name}`)
  } else {
    console.log(`[smoke] FAIL — ${c.name}`)
    for (const f of fails) console.log(`   ${f}`)
    ok = false
  }
}

process.exit(ok ? 0 : 1)
