#!/usr/bin/env node
// H.1 (Inbound) verification — schema introspection + round-trip.
// 16 assertions covering every new column, the four new enum values,
// both new tables, and a full create→read→delete cycle that exercises
// every H.1 surface.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h1.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `INBOUND_H1_${Date.now()}`
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}
async function api(method, p, body) {
  const opts = { method }
  if (body != null) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${p}`, opts)
  const text = await res.text()
  let data; try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data }
}

let inboundId, attachmentId, discrepancyId

async function cleanup() {
  console.log('[verify-inbound-h1] cleanup')
  if (discrepancyId) {
    try { await client.query(`DELETE FROM "InboundDiscrepancy" WHERE id = $1`, [discrepancyId]) } catch {}
  }
  if (attachmentId) {
    try { await client.query(`DELETE FROM "InboundShipmentAttachment" WHERE id = $1`, [attachmentId]) } catch {}
  }
  if (inboundId) {
    try { await client.query(`DELETE FROM "InboundShipment" WHERE id = $1`, [inboundId]) } catch (e) {
      console.log('inbound cleanup error:', e.message)
    }
  }
}

try {
  // ── Schema introspection ──────────────────────────────────────────
  console.log('[verify-inbound-h1] schema introspection')

  const shipCols = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='InboundShipment'
  `)
  const shipColMap = new Map(shipCols.rows.map((r) => [r.column_name, r.data_type]))
  const expectedShipCols = [
    ['asnFileUrl',         'text'],
    ['carrierCode',        'text'],
    ['trackingNumber',     'text'],
    ['trackingUrl',        'text'],
    ['currencyCode',       'text'],
    ['exchangeRate',       'numeric'],
    ['shippingCostCents',  'integer'],
    ['customsCostCents',   'integer'],
    ['dutiesCostCents',    'integer'],
    ['insuranceCostCents', 'integer'],
    ['createdById',        'text'],
    ['receivedById',       'text'],
  ]
  for (const [col, type] of expectedShipCols) {
    if (shipColMap.get(col) === type) ok(`InboundShipment.${col} (${type})`)
    else bad(`InboundShipment.${col}`, `got ${shipColMap.get(col)}, expected ${type}`)
  }

  const itemCols = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='InboundShipmentItem'
  `)
  const itemColMap = new Map(itemCols.rows.map((r) => [r.column_name, r.data_type]))
  const expectedItemCols = [
    ['unitCostCents',     'integer'],
    ['costVarianceCents', 'integer'],
    ['photoUrls',         'ARRAY'],
  ]
  for (const [col, type] of expectedItemCols) {
    if (itemColMap.get(col) === type) ok(`InboundShipmentItem.${col} (${type})`)
    else bad(`InboundShipmentItem.${col}`, `got ${itemColMap.get(col)}, expected ${type}`)
  }

  // Enum values
  const enumVals = await client.query(`
    SELECT unnest(enum_range(NULL::"InboundStatus"))::text as v
  `)
  const vSet = new Set(enumVals.rows.map((r) => r.v))
  for (const v of ['SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILED']) {
    if (vSet.has(v)) ok(`InboundStatus.${v} present`)
    else bad(`InboundStatus.${v}`, 'missing')
  }

  // New tables
  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN ('InboundShipmentAttachment','InboundDiscrepancy')
  `)
  const tSet = new Set(tables.rows.map((r) => r.table_name))
  if (tSet.has('InboundShipmentAttachment')) ok('InboundShipmentAttachment table exists')
  else bad('InboundShipmentAttachment table missing')
  if (tSet.has('InboundDiscrepancy')) ok('InboundDiscrepancy table exists')
  else bad('InboundDiscrepancy table missing')

  // ── Round-trip via API ───────────────────────────────────────────
  console.log('[verify-inbound-h1] round-trip')

  const createRes = await api('POST', '/api/fulfillment/inbound', {
    type: 'SUPPLIER',
    reference: `${TEST_TAG} fixture`,
    expectedAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    asnNumber: 'ASN-TEST-001',
    asnFileUrl: 'https://example.com/asn.pdf',
    carrierCode: 'BRT',
    trackingNumber: 'BRT123456789',
    trackingUrl: 'https://www.brt.it/tracking/BRT123456789',
    currencyCode: 'USD',
    exchangeRate: 0.92,
    shippingCostCents: 5000,
    customsCostCents: 1500,
    dutiesCostCents: 800,
    insuranceCostCents: 300,
    createdById: 'verify-inbound-h1',
    items: [
      { sku: `${TEST_TAG}-SKU-1`, quantityExpected: 10, unitCostCents: 1200 },
    ],
  })
  if (!createRes.ok) { bad('create inbound with H.1 fields', JSON.stringify(createRes.data)); throw new Error('halt') }
  inboundId = createRes.data.id
  ok('create inbound with H.1 fields')

  // GET back and confirm fields persisted
  const getRes = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  if (!getRes.ok) { bad('GET shipment', JSON.stringify(getRes.data)); throw new Error('halt') }
  const ship = getRes.data
  const checks = [
    ['carrierCode',         'BRT'],
    ['trackingNumber',      'BRT123456789'],
    ['currencyCode',        'USD'],
    ['shippingCostCents',   5000],
  ]
  let roundtripOk = true
  for (const [k, v] of checks) {
    if (ship[k] !== v) { roundtripOk = false; bad(`round-trip ${k}`, `got ${ship[k]}`) }
  }
  if (roundtripOk) ok('round-trip persists carrier/tracking/currency/cost')

  if (Number(ship.exchangeRate) === 0.92) ok('round-trip persists exchangeRate')
  else bad('round-trip exchangeRate', `got ${ship.exchangeRate}`)

  if (ship.items[0]?.unitCostCents === 1200) ok('round-trip persists item unitCostCents')
  else bad('round-trip unitCostCents', JSON.stringify(ship.items[0]))

  if (Array.isArray(ship.items[0]?.photoUrls) && ship.items[0].photoUrls.length === 0) ok('item.photoUrls defaults to empty array')
  else bad('item.photoUrls default', JSON.stringify(ship.items[0]?.photoUrls))

  // Insert an attachment + discrepancy directly (no API surface yet — Commits 16/17 add those)
  const attRow = await client.query(`
    INSERT INTO "InboundShipmentAttachment"
      (id, "inboundShipmentId", kind, url, filename, "uploadedAt")
    VALUES (gen_random_uuid()::text, $1, 'INVOICE', 'https://example.com/inv.pdf', 'invoice.pdf', now())
    RETURNING id
  `, [inboundId])
  attachmentId = attRow.rows[0].id

  const discRow = await client.query(`
    INSERT INTO "InboundDiscrepancy"
      (id, "inboundShipmentId", "reasonCode", "quantityImpact", description, status)
    VALUES (gen_random_uuid()::text, $1, 'SHORT_SHIP', 3, 'Verify-H1 fixture', 'REPORTED')
    RETURNING id
  `, [inboundId])
  discrepancyId = discRow.rows[0].id

  // Re-fetch and verify the include[] surfaces them
  const getAfter = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  if (getAfter.data?.attachments?.length === 1) ok('attachments[] returned in detail bundle')
  else bad('attachments not in bundle', JSON.stringify(getAfter.data?.attachments))
  if (getAfter.data?.discrepancies?.length === 1) ok('discrepancies[] returned in detail bundle')
  else bad('discrepancies not in bundle', JSON.stringify(getAfter.data?.discrepancies))
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-inbound-h1] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
