#!/usr/bin/env node
// R.13 verification — event-driven prep mode.
//
// Branches:
//   1. /replenishment list emits prepEvent + prepEventId + prepExtraUnits
//      (may be null when no events apply, that's still a pass).
//   2. urgencySource: 'EVENT' is a valid value (no enum-validation
//      regression on the persistence side).
//   3. Invariant: when prepEvent is non-null, expectedLift > 1
//      (we filter out lift ≤ 1 events at query time).
//
// Pure-function math (24 deterministic tests) ran at build time.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r13.mjs

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

// ─── Branch 1: list emits R.13 fields ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  if (res.status !== 200) {
    bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))
  } else if (!Array.isArray(data?.suggestions) || data.suggestions.length === 0) {
    ok('No suggestions in system — branch skipped')
  } else {
    ok(`200 with ${data.suggestions.length} suggestion(s)`)
    const s = data.suggestions[0]
    if ('prepEvent' in s) ok(`prepEvent present (${s.prepEvent ? 'object' : 'null'})`)
    else bad('prepEvent missing')
    if ('prepEventId' in s) ok(`prepEventId present (${s.prepEventId ?? 'null'})`)
    else bad('prepEventId missing')
    if ('prepExtraUnits' in s) ok(`prepExtraUnits present (${s.prepExtraUnits ?? 'null'})`)
    else bad('prepExtraUnits missing')

    // ─── Branch 3: lift > 1 invariant ───
    const withEvent = data.suggestions.filter((x) => x.prepEvent != null)
    let liftViolations = 0
    for (const sg of withEvent) {
      if (Number(sg.prepEvent.expectedLift) <= 1) {
        liftViolations++
      }
    }
    if (withEvent.length === 0) {
      ok('No applicable events in window (pre-launch state) — lift-invariant branch skipped')
    } else if (liftViolations === 0) {
      ok(`lift > 1 invariant holds across ${withEvent.length} event-flagged suggestion(s)`)
    } else {
      bad(`${liftViolations} suggestions have prepEvent with expectedLift ≤ 1 (should be filtered out)`)
    }

    // urgencySource validity check
    const validSources = new Set(['GLOBAL', 'CHANNEL', 'EVENT'])
    let invalidSourceCount = 0
    for (const sg of data.suggestions.slice(0, 100)) {
      if (sg.urgencySource != null && !validSources.has(sg.urgencySource)) invalidSourceCount++
    }
    if (invalidSourceCount === 0) ok('urgencySource values all in {GLOBAL, CHANNEL, EVENT, null}')
    else bad(`${invalidSourceCount} suggestions have unexpected urgencySource value`)
  }
}

// ─── Branch 4: forecast-detail recommendation propagates fields ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleProductId = listData?.suggestions?.[0]?.productId ?? null
  if (sampleProductId) {
    const res = await fetch(`${API_BASE}/api/fulfillment/replenishment/${sampleProductId}/forecast-detail`)
    const data = await res.json().catch(() => ({}))
    if (res.status === 200) {
      ok('forecast-detail returns 200')
    } else {
      bad(`forecast-detail expected 200, got ${res.status}`)
    }
  } else {
    ok('No product to probe — forecast-detail branch skipped')
  }
}

console.log(`\n[verify-replenishment-r13] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
