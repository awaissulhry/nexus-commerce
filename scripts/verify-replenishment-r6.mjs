#!/usr/bin/env node
// R.6 verification — auto-PO trigger.
//
// Branches:
//   1. GET /auto-po/status — 200 with cron snapshot + global config.
//   2. POST /auto-po/run with { dryRun: true } — 200 with summary.
//      Should report eligible/declined counts but never create real
//      POs. Run-log row inserted with dryRun=true.
//   3. GET /auto-po/runs — 200 with array of run-log rows; the
//      dry-run from branch 2 should appear.
//   4. Real run smoke (only when forced via NEXUS_VERIFY_AUTO_PO_REAL
//      env var) — POST with dryRun=false. Skipped by default to avoid
//      creating accidental POs from the verify script.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r6.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// ─── Branch 1: status ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/auto-po/status`)
  const data = await res.json().catch(() => ({}))
  console.log(`[status] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200) {
    ok('GET /auto-po/status returns 200')
    if ('defaultQtyCeiling' in data) ok(`defaultQtyCeiling = ${data.defaultQtyCeiling}`)
    else bad('defaultQtyCeiling missing')
    if ('defaultCostCeilingCents' in data) ok(`defaultCostCeilingCents = ${data.defaultCostCeilingCents}`)
    else bad('defaultCostCeilingCents missing')
    if (Array.isArray(data?.triggerUrgencies)) ok(`triggerUrgencies = [${data.triggerUrgencies.join(',')}]`)
    else bad('triggerUrgencies missing')
    if (data.cron && typeof data.cron.scheduled === 'boolean') ok(`cron.scheduled = ${data.cron.scheduled}`)
    else bad('cron block missing')
  } else if (res.status === 404) {
    bad('404 — Railway not deployed yet?', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 2: dry-run trigger ───
let dryRunSummary = null
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/auto-po/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[run dryRun] status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`)
  if (res.status === 200) {
    dryRunSummary = data
    ok('POST /auto-po/run dryRun:true returns 200')
    if (data.dryRun === true) ok('summary.dryRun = true')
    else bad('summary.dryRun !== true')
    if (data.triggeredBy === 'manual') ok('summary.triggeredBy = manual')
    else bad('summary.triggeredBy mismatch')
    if (typeof data.eligibleCount === 'number') ok(`eligibleCount = ${data.eligibleCount}`)
    else bad('eligibleCount missing')
    if (typeof data.posCreated === 'number') ok(`posCreated (would be) = ${data.posCreated}`)
    else bad('posCreated missing')
    if (typeof data.runLogId === 'string') ok(`runLogId = ${data.runLogId}`)
    else bad('runLogId missing')
    if (Array.isArray(data.createdPoIds)) ok(`createdPoIds is array (length=${data.createdPoIds.length})`)
    else bad('createdPoIds not an array')
    // CRITICAL: dry run must never create real POs.
    if (data.createdPoIds.length === 0) {
      ok('dry run created zero real PO ids (as expected)')
    } else {
      bad(`DRY RUN CREATED ${data.createdPoIds.length} REAL POs — service bug`)
    }
  } else {
    bad(`dryRun expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 3: run history ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/auto-po/runs?limit=5`)
  const data = await res.json().catch(() => ({}))
  console.log(`[runs] status=${res.status} count=${data?.items?.length}`)
  if (res.status === 200) {
    ok('GET /auto-po/runs returns 200')
    if (Array.isArray(data.items)) {
      ok(`items array (length=${data.items.length})`)
      if (dryRunSummary && data.items.length > 0) {
        // The dry run we just made should be the first row.
        const first = data.items[0]
        if (first.id === dryRunSummary.runLogId) ok('our dry-run shows up at the top of the run-log')
        else bad(`expected runLogId=${dryRunSummary.runLogId}, got ${first.id}`)
        if (first.dryRun === true) ok('first row dryRun = true')
        else bad('first row dryRun mismatch')
        if (first.triggeredBy === 'manual') ok('first row triggeredBy = manual')
        else bad('first row triggeredBy mismatch')
      }
    } else {
      bad('items not an array')
    }
  } else {
    bad(`runs expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

// ─── Branch 4: optional real-run (gated) ───
if (process.env.NEXUS_VERIFY_AUTO_PO_REAL === '1') {
  console.log('[real-run] NEXUS_VERIFY_AUTO_PO_REAL=1 — running REAL sweep')
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/auto-po/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: false }),
  })
  const data = await res.json().catch(() => ({}))
  console.log(`[real run] status=${res.status} body=${JSON.stringify(data).slice(0, 400)}`)
  if (res.status === 200) ok(`real run completed: posCreated=${data.posCreated}, errors=${data.errorCount}`)
  else bad(`real run expected 200, got ${res.status}`)
} else {
  console.log('[real-run] skipped (set NEXUS_VERIFY_AUTO_PO_REAL=1 to enable)')
}

console.log(`\n[verify-replenishment-r6] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
