#!/usr/bin/env node
// P.21 — smoke-test the /products foundation rebuild's surface.
//
// Walks every commit's contract and checks the API still honours it.
// Runs against the deployed Railway API by default; pass --local to
// hit http://localhost:4000 instead (assumes the API server is up).
//
// Each check prints a green ✓ / red ✗ + a one-line note. Exits 0
// when every check passes, 1 otherwise. Designed to run after a
// deploy or before tagging a release; doesn't mutate state.
//
// Usage:
//   node scripts/verify-products-rebuild.mjs
//   node scripts/verify-products-rebuild.mjs --local
//
// What this DOESN'T test:
//   - Frontend (the workspace tsx files): no headless-browser harness
//     in this repo. Manual smoke + Vercel preview is the gate today.
//   - Drift reconciliation writes (the unfollow path): destructive,
//     scripts/reconcile-master-drift.mjs --apply is the dedicated runner
//   - AI suggest-fields: skipped when no provider configured to keep
//     the verifier free of side effects + key requirements
//   - Per-product correctness (the values): a structural verifier,
//     not a data-quality audit (use scripts/audit-products-state.mjs)

const args = process.argv.slice(2)
const isLocal = args.includes('--local')
const BASE = isLocal
  ? 'http://localhost:4000'
  : 'https://nexusapi-production-b7bb.up.railway.app'

const results = []
const note = (ok, name, msg) => {
  results.push({ ok, name, msg })
  const tick = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${tick} ${name}${msg ? `  — ${msg}` : ''}`)
}

const fetchJson = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, ok: res.ok }
}

console.log(`\nVerifying /products rebuild against: ${BASE}\n`)

// ── Commit 0: bulk-status cascade + PATCH version + bulk publish res.ok ──
console.log('Commit 0 — correctness gate')
{
  // bulk-status endpoint exists + rejects bad status
  const r = await fetchJson('/api/products/bulk-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productIds: [], status: 'BAD' }),
  })
  note(
    r.status === 400,
    'POST /api/products/bulk-status validates input',
    `expected 400 (productIds[] required); got ${r.status}`,
  )
}

// ── P.2: drift detection cron endpoints ──
console.log('\nP.2 — drift detection')
{
  const r = await fetchJson('/api/sync/detect-drift/status')
  note(
    r.ok && typeof r.body?.scheduled === 'boolean',
    'GET /api/sync/detect-drift/status',
    r.ok ? `scheduled=${r.body.scheduled}` : `HTTP ${r.status}`,
  )
}

// ── P.3: saved-views with alertSummary ──
console.log('\nP.3 — saved-views + alert summary')
{
  const r = await fetchJson('/api/saved-views?surface=products')
  const items = r.body?.items ?? []
  const hasSummary = items.length === 0
    ? true
    : items.every((v) => v.alertSummary && typeof v.alertSummary.total === 'number')
  note(
    r.ok && hasSummary,
    'GET /api/saved-views returns alertSummary per item',
    r.ok ? `${items.length} views, summary present` : `HTTP ${r.status}`,
  )
}

// ── P.6: extended health endpoint with master fields + counts ──
console.log('\nP.6 — extended /products/:id/health')
{
  const list = await fetchJson('/api/products?limit=1')
  const sampleId = list.body?.products?.[0]?.id
  if (!sampleId) {
    note(false, 'sample product id', 'no products in catalog')
  } else {
    const r = await fetchJson(`/api/products/${sampleId}/health`)
    const hasMaster = !!r.body?.name && r.body?.id === sampleId
    const hasCounts =
      r.body?._count &&
      typeof r.body._count.images === 'number' &&
      typeof r.body._count.children === 'number' &&
      typeof r.body._count.translations === 'number'
    const hasScore = typeof r.body?.score === 'number'
    note(
      r.ok && hasMaster && hasCounts && hasScore,
      'health returns master + _count.children/translations + score',
      r.ok
        ? `score=${r.body.score} children=${r.body._count?.children} translations=${r.body._count?.translations}`
        : `HTTP ${r.status}`,
    )
  }
}

// ── P.7: list endpoint returns version per row ──
console.log('\nP.7 — list returns Product.version')
{
  const r = await fetchJson('/api/products?limit=1')
  const row = r.body?.products?.[0]
  note(
    r.ok && typeof row?.version === 'number',
    'GET /api/products returns version on each row',
    r.ok ? `sample version=${row?.version}` : `HTTP ${r.status}`,
  )
}

// ── P.9: bulk-fetch supports productIds filter ──
console.log('\nP.9 — bulk-fetch productIds filter')
{
  const list = await fetchJson('/api/products?limit=2')
  const ids = (list.body?.products ?? []).map((p) => p.id)
  if (ids.length < 2) {
    note(false, 'productIds filter test', 'need ≥2 products')
  } else {
    const r = await fetchJson(
      `/api/products/bulk-fetch?productIds=${ids[0]},${ids[1]}`,
    )
    const got = r.body?.products?.length ?? 0
    note(
      r.ok && got === 2,
      'GET /api/products/bulk-fetch?productIds=…',
      r.ok ? `requested 2, got ${got}` : `HTTP ${r.status}`,
    )
  }
}

// ── P.10: missingChannels filter ──
console.log('\nP.10 — missingChannels filter')
{
  const r = await fetchJson('/api/products?missingChannels=AMAZON&limit=1')
  note(
    r.ok && Array.isArray(r.body?.products),
    'GET /api/products?missingChannels=AMAZON',
    r.ok ? `returned ${r.body.products.length} of ${r.body.total} total` : `HTTP ${r.status}`,
  )
}

// ── P.11: per-listing resync endpoint exists ──
console.log('\nP.11 — per-listing resync')
{
  // Just verify the route is registered. Use a known-bad id so we
  // get a clean 404 instead of mutating real state.
  const r = await fetchJson('/api/listings/__verify_dummy__/resync', {
    method: 'POST',
  })
  note(
    r.status === 404,
    'POST /api/listings/:id/resync registered',
    `expected 404 for dummy id; got ${r.status}`,
  )
}

// ── P.13: AI usage endpoints ──
console.log('\nP.13 — AI usage telemetry')
{
  const r = await fetchJson('/api/ai/providers')
  const providers = r.body?.providers ?? r.body
  note(
    r.ok && Array.isArray(providers),
    'GET /api/ai/providers',
    r.ok && Array.isArray(providers)
      ? `${providers.length} providers registered (${providers.filter((p) => p.configured).map((p) => p.name).join(', ') || 'none configured'})`
      : `HTTP ${r.status}`,
  )
}

// ── Final tally ──
const failed = results.filter((r) => !r.ok)
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed${failed.length > 0 ? ` — ${failed.length} failed` : ''}`,
)
process.exit(failed.length === 0 ? 0 : 1)
