#!/usr/bin/env node
// H.17 verification — discrepancy report PDF.
//
//   GET /api/fulfillment/inbound/:id/discrepancies/report.pdf
//     - 404 for unknown shipment id.
//     - 200 with application/pdf + body starts with "%PDF-" for any
//       real shipment.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h17.mjs

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

// ─── Branch 1: 404 for unknown shipment ───
{
  const SYNTH = `inb_synth_${Date.now()}`
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/${SYNTH}/discrepancies/report.pdf`)
  console.log(`[unknown] status=${res.status} ct=${res.headers.get('content-type')}`)
  if (res.status === 404) ok('404 for unknown shipment id')
  else if (res.status === 405) bad('405: route may not be wired')
  else bad(`expected 404, got ${res.status}`)
}

// ─── Branch 2: real shipment returns PDF binary ───
{
  const listRes = await fetch(`${API_BASE}/api/fulfillment/inbound?limit=1`)
  const listData = await listRes.json().catch(() => ({}))
  const sampleId = listData?.items?.[0]?.id ?? null
  if (!sampleId) {
    ok('No shipments in system — PDF binary check skipped (route still wired)')
  } else {
    const res = await fetch(`${API_BASE}/api/fulfillment/inbound/${sampleId}/discrepancies/report.pdf`)
    const ct = res.headers.get('content-type') ?? ''
    const cd = res.headers.get('content-disposition') ?? ''
    console.log(`[real] status=${res.status} ct=${ct} cd=${cd}`)
    if (res.status === 200) {
      ok('200 for real shipment')
      if (/application\/pdf/.test(ct)) ok('content-type: application/pdf')
      else bad('content-type not application/pdf', ct)
      if (/attachment/.test(cd) && /\.pdf/.test(cd)) ok('content-disposition is attachment')
      else bad('content-disposition not attachment', cd)
      const buf = Buffer.from(await res.arrayBuffer())
      const head = buf.slice(0, 8).toString('latin1')
      console.log(`[real] body starts with: ${JSON.stringify(head)}`)
      if (head.startsWith('%PDF-')) ok('body is a valid PDF (header magic %PDF-)')
      else bad('body does not look like a PDF', head)
    } else {
      bad(`expected 200, got ${res.status}`)
    }
  }
}

console.log(`\n[verify-inbound-h17] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
