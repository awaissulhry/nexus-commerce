#!/usr/bin/env node
// H.6 (Inbound) verification — drawer UX is exercised via the same
// API endpoints H.2 already covered, but H.6 added one new shape:
// receive payload accepts items[].photoUrls[] which the server
// appends to InboundShipmentItem.photoUrls.
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h6.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'
const TEST_TAG = `INBOUND_H6_${Date.now()}`
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

let inboundId, itemId

async function findRealTestProduct() {
  const r = await client.query(`SELECT id, sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`)
  return r.rows[0]
}
async function cleanup() {
  console.log('[verify-inbound-h6] cleanup')
  if (inboundId) try { await client.query(`DELETE FROM "InboundShipment" WHERE id = $1`, [inboundId]) } catch {}
}

try {
  const product = await findRealTestProduct()
  if (!product) { console.error('no product'); process.exit(1) }

  // 1. Create a manual inbound (no PO link — H.6 drawer doesn't require one)
  const create = await api('POST', '/api/fulfillment/inbound', {
    type: 'SUPPLIER',
    reference: `${TEST_TAG} drawer test`,
    items: [{ productId: product.id, sku: product.sku, quantityExpected: 5 }],
  })
  if (!create.ok) { bad('create inbound', JSON.stringify(create.data)); throw new Error('halt') }
  inboundId = create.data.id
  itemId = create.data.items[0].id
  ok('create inbound')

  // 2. Walk to RECEIVING (H.2 transitions)
  for (const s of ['SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING']) {
    const r = await api('POST', `/api/fulfillment/inbound/${inboundId}/transition`, { status: s })
    if (!r.ok) bad(`transition → ${s}`, JSON.stringify(r.data))
  }
  ok('walked to RECEIVING')

  // 3. H.6 NEW — receive with embedded photoUrls. Verify photos persist
  // alongside the receive event.
  const photoUrl = 'https://res.cloudinary.com/test/image/upload/v1/inbound/h6test.jpg'
  const recvRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{
      itemId,
      quantityReceived: 3,
      qcStatus: 'PASS',
      photoUrls: [photoUrl],
    }],
  })
  if (recvRes.ok) ok('receive with embedded photoUrls')
  else bad('receive with photos', JSON.stringify(recvRes.data))

  // 4. Detail bundle surfaces the photo
  const detail = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  const item = detail.data?.items?.find((it) => it.id === itemId)
  if (item?.photoUrls?.includes(photoUrl)) ok('item.photoUrls[] includes the new photo')
  else bad('photo not in detail', JSON.stringify(item?.photoUrls))
  if (item?.quantityReceived === 3) ok('item.quantityReceived = 3')
  else bad('item received', JSON.stringify(item?.quantityReceived))
  if (item?.receipts?.length >= 1) ok('item.receipts[] has receipt event')
  else bad('item.receipts', JSON.stringify(item?.receipts))

  // 5. Add a second photo via the dedicated photo endpoint (the
  // expanded item row's "Add photo URL" input would call this)
  const photoUrl2 = 'https://res.cloudinary.com/test/image/upload/v1/inbound/h6test2.jpg'
  const photo2 = await api('POST', `/api/fulfillment/inbound/${inboundId}/items/${itemId}/photos`, { url: photoUrl2 })
  if (photo2.ok && photo2.data.photoUrls?.length === 2) ok('photo append endpoint adds second URL')
  else bad('photo append', JSON.stringify(photo2.data))

  // 6. Item-level discrepancy via the drawer's quick-add composer
  const dRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/discrepancies`, {
    itemId,
    reasonCode: 'DAMAGED',
    quantityImpact: 1,
    description: 'H.6 drawer fixture',
  })
  if (dRes.ok) ok('item-level discrepancy via drawer composer')
  else bad('discrepancy create', JSON.stringify(dRes.data))

  // 7. Detail item.discrepancies includes the new one
  const detail2 = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  const item2 = detail2.data?.items?.find((it) => it.id === itemId)
  if (item2?.discrepancies?.length >= 1 && item2.discrepancies.some((d) => d.reasonCode === 'DAMAGED')) {
    ok('item.discrepancies[] surfaces DAMAGED')
  } else bad('item discrepancies', JSON.stringify(item2?.discrepancies))

  // 8. Attachment add via drawer composer
  const attRes = await api('POST', `/api/fulfillment/inbound/${inboundId}/attachments`, {
    kind: 'PACKING',
    url: 'https://example.com/packing-list.pdf',
    filename: 'packing-list.pdf',
  })
  if (attRes.ok) ok('attachment add via drawer composer')
  else bad('attachment add', JSON.stringify(attRes.data))

  // 9. Receive HOLD then release — covers expanded-item Release-hold button
  const recvHold = await api('POST', `/api/fulfillment/inbound/${inboundId}/receive`, {
    items: [{ itemId, quantityReceived: 5, qcStatus: 'HOLD' }],
  })
  if (recvHold.ok) ok('receive remainder with HOLD')
  else bad('receive HOLD', JSON.stringify(recvHold.data))

  const release = await api('POST', `/api/fulfillment/inbound/${inboundId}/items/${itemId}/release-hold`, {})
  if (release.ok) ok('release HOLD via drawer button')
  else bad('release', JSON.stringify(release.data))

  // After release qcStatus should be PASS (full release path)
  const detail3 = await api('GET', `/api/fulfillment/inbound/${inboundId}`)
  const item3 = detail3.data?.items?.find((it) => it.id === itemId)
  if (item3?.qcStatus === 'PASS') ok('post-release qcStatus = PASS')
  else bad('post-release qc', JSON.stringify(item3?.qcStatus))
} finally {
  await cleanup()
  await client.end()
  console.log(`\n[verify-inbound-h6] PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
    process.exit(1)
  }
}
