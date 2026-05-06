#!/usr/bin/env node
// R.5 verification — page polish (URL state, sort, mobile, errors).
//
// R.5 is UI-only — no new endpoints, no schema. The backend smoke
// is just "the existing /replenishment route still works" (regression
// guard against the file rewrite). The interactive behaviors (URL
// state, sort headers, auto-refresh, toasts, mobile cards, drawer
// error UI, CSV export) need a browser to verify; flagged here as
// a manual checklist printed at the end of the script.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-replenishment-r5.mjs

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

// ─── Backend regression guard ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30`)
  const data = await res.json().catch(() => ({}))
  console.log(`[list] status=${res.status} suggestions=${data?.suggestions?.length}`)
  if (res.status === 200) ok('replenishment list still 200 (no backend regression from R.5 file edits)')
  else bad(`expected 200, got ${res.status}`, JSON.stringify(data).slice(0, 200))

  if (Array.isArray(data?.suggestions)) ok('suggestions still an array')
  else bad('suggestions shape changed')
}

// ─── Filter + search query params accepted ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/replenishment?window=30&channel=AMAZON&marketplace=IT`)
  if (res.status === 200) ok('channel + marketplace query params still honored')
  else bad(`channel+marketplace: expected 200, got ${res.status}`)
}

// ─── Manual checklist ───
console.log(`\n[verify-replenishment-r5] PASS=${pass} FAIL=${fail}`)
console.log(`
─────────────────────────────────────────────────────────────────
R.5 manual checklist (open the page in a browser to verify):

URL state
  [ ] Click an urgency filter — URL gains ?filter=...
  [ ] Type in search — URL updates after 250ms debounce
  [ ] Click a sortable column header — URL gains ?sortBy=...&sortDir=...
  [ ] Open drawer — URL gains ?drawer=<productId>
  [ ] Reload the page — all of the above persist
  [ ] Copy URL to another tab — same view loads

Sort
  [ ] Click "Days left" header — table re-sorts ascending (least first)
  [ ] Click again — flips to descending
  [ ] Click "Velocity" — switches sort, resets to default direction
  [ ] Active column shows ↑/↓ arrow

Auto-refresh
  [ ] Pick "Auto-refresh: 5 min" — preference persists per device
  [ ] Page refetches at the interval (network tab confirms)
  [ ] Open another tab → original tab pauses (visibilitychange)

Toasts
  [ ] Click per-row "PO" button — green toast on success
  [ ] Toast auto-dismisses after ~4.5s
  [ ] X button closes immediately

Drawer error
  [ ] Open drawer with bad productId in URL — error UI renders, not infinite spinner
  [ ] Retry button reloads

Mobile (<1024px)
  [ ] 13-column table replaced with cards
  [ ] Each card shows SKU, urgency, name, stock/days/qty grid, PO/details buttons
  [ ] Selection checkbox still works on cards

CSV export
  [ ] "Export CSV" downloads file named replenishment-YYYY-MM-DD.csv
  [ ] Opens in Excel; 17 columns; rows match currently filtered view
  [ ] Comma-containing names quoted correctly
─────────────────────────────────────────────────────────────────
`)

if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
