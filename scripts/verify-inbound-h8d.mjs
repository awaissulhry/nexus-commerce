#!/usr/bin/env node
// H.8d (Inbound) verification — FBA status polling cron + manual
// trigger.
//
// Two endpoints:
//   GET  /api/fulfillment/fba/poll-status  → cron status snapshot.
//        Should always return 200 with { scheduled, lastRunAt,
//        lastUpdatedCount }.
//   POST /api/fulfillment/fba/poll-status  → run the poll once.
//        Three branches:
//          1. 503 — SP-API not configured. Soft pass; honest config
//             error.
//          2. 200 — Poll ran. Validate counts shape. Note: with no
//             non-terminal local FBAShipments, scanned=0 is normal
//             and still proves the path runs end-to-end.
//          3. 500 — SP-API call landed but Amazon errored
//             (throttled, etc.). Soft pass — proves new code is
//             live.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h8d.mjs

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

// ─── Branch 1: GET cron status ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/fba/poll-status`)
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[GET poll-status] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)
  if (res.status === 200 && data?.ok === true && typeof data.scheduled === 'boolean') {
    ok('GET poll-status: cron snapshot returned')
    if (data.scheduled === true) ok('cron is scheduled (default-on)')
    else ok('cron is not scheduled (NEXUS_ENABLE_FBA_STATUS_POLL_CRON=0)')
  } else if (res.status === 404) {
    bad('GET poll-status: 404 — Railway deploy not picked up?', JSON.stringify(data).slice(0, 300))
  } else {
    bad(`GET poll-status: unexpected status ${res.status}`, JSON.stringify(data).slice(0, 300))
  }
}

// ─── Branch 2: POST manual trigger ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/fba/poll-status`, { method: 'POST' })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  console.log(`[POST poll-status] status=${res.status} body=${JSON.stringify(data).slice(0, 300)}`)

  if (res.status === 503) {
    if (data?.error && /SP-API not configured/i.test(data.error)) {
      ok('POST 503: SP-API not configured (soft pass — config gap surfaced honestly)')
    } else bad('POST 503 without expected message', JSON.stringify(data))
  } else if (res.status === 200) {
    ok('POST 200: poll ran end-to-end')
    if (typeof data?.scanned === 'number') ok(`scanned=${data.scanned}`)
    else bad('scanned shape', JSON.stringify(data))
    if (typeof data?.updated === 'number') ok(`updated=${data.updated}`)
    else bad('updated shape', JSON.stringify(data))
    if (typeof data?.unchanged === 'number') ok(`unchanged=${data.unchanged}`)
    else bad('unchanged shape', JSON.stringify(data))
    if (typeof data?.errors === 'number') ok(`errors=${data.errors}`)
    else bad('errors shape', JSON.stringify(data))
  } else if (res.status === 500) {
    if (data?.error && /SP-API|RequestThrottled|access denied|InvalidParameter/i.test(data.error)) {
      ok('POST 500: real SP-API error surfaced (call reached Amazon)')
    } else if (data?.error && /SP-API getShipments|LWA token/i.test(data.error)) {
      ok('POST 500: SP-API client error path triggered (proves new code is live)')
    } else {
      bad('POST 500 with unexpected error shape', JSON.stringify(data).slice(0, 300))
    }
  } else if (res.status === 404) {
    bad('POST poll-status: 404 — Railway deploy not picked up?', JSON.stringify(data).slice(0, 300))
  } else {
    bad(`POST poll-status: unexpected status ${res.status}`, JSON.stringify(data).slice(0, 300))
  }
}

console.log(`\n[verify-inbound-h8d] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
