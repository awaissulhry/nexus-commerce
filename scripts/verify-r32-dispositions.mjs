#!/usr/bin/env node
// Verify R3.2 — per-item disposition routing through inspect → restock.
// Exercises both single-warehouse fallback (typical Xavia case) and the
// kind-matching path when we temporarily tag a Warehouse with a kind.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

// ── Schema columns
console.log('\n[1] Schema columns')
{
  const w = await dbq(`SELECT column_name FROM information_schema.columns WHERE table_name='Warehouse' AND column_name='kind'`)
  const ri = await dbq(`SELECT column_name FROM information_schema.columns WHERE table_name='ReturnItem' AND column_name IN ('disposition', 'scrapReason') ORDER BY column_name`)
  if (w.length === 1) ok('Warehouse.kind present')
  else bad('Warehouse.kind missing', JSON.stringify(w))
  if (ri.length === 2) ok('ReturnItem.disposition + scrapReason present')
  else bad('ReturnItem cols missing', JSON.stringify(ri))
}

// ── Find a real product to attach to so applyStockMovement actually
// fires (productId required).
const productRow = (await dbq(`SELECT id, sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
if (!productRow) { bad('no Product to test against', ''); process.exit(1) }
ok(`using product ${productRow.sku}`)

// Need an existing order so the inspect→restock flow has Return.orderId
const orderRow = (await dbq(`SELECT id FROM "Order" ORDER BY "createdAt" DESC LIMIT 1`))[0]

// ── Create return with 4 items mapping to 4 different dispositions
console.log('\n[2] Create return + inspect with mixed dispositions')
const create = await fetch(`${API}/api/fulfillment/returns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-user-id': 'r32-verify' },
  body: JSON.stringify({
    channel: 'AMAZON',
    orderId: orderRow?.id,
    reason: 'R32_DISPOSITION_TEST',
    // 4 lines × same product so the StockMovement footprint is easy to
    // assert in [3] below.
    items: [
      { sku: productRow.sku, productId: productRow.id, quantity: 1 },
      { sku: productRow.sku, productId: productRow.id, quantity: 1 },
      { sku: productRow.sku, productId: productRow.id, quantity: 1 },
      { sku: productRow.sku, productId: productRow.id, quantity: 1 },
    ],
  }),
})
const ret = await create.json()
const id = ret.id
if (!id) { bad('create failed', JSON.stringify(ret)); process.exit(1) }
ok(`created return ${id}`)

// Receive then inspect with explicit dispositions
await fetch(`${API}/api/fulfillment/returns/${id}/receive`, { method: 'POST' })
const itemRows = await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1 ORDER BY id`, [id])
const inspectBody = {
  items: [
    { itemId: itemRows[0].id, conditionGrade: 'NEW',      disposition: 'SELLABLE'       },
    { itemId: itemRows[1].id, conditionGrade: 'GOOD',     disposition: 'SECOND_QUALITY' },
    { itemId: itemRows[2].id, conditionGrade: 'GOOD',     disposition: 'QUARANTINE'     },
    { itemId: itemRows[3].id, conditionGrade: 'DAMAGED',  disposition: 'SCRAP', scrapReason: 'cracked screen' },
  ],
}
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inspectBody),
  })
  if (r.ok) ok('inspect 200')
  else bad('inspect failed', await r.text().then(t => t.slice(0, 200)))
}
{
  const persisted = await dbq(`SELECT id, "disposition", "scrapReason" FROM "ReturnItem" WHERE "returnId" = $1 ORDER BY id`, [id])
  const ds = persisted.map(p => p.disposition)
  if (JSON.stringify(ds) === JSON.stringify(['SELLABLE', 'SECOND_QUALITY', 'QUARANTINE', 'SCRAP'])) ok('all 4 dispositions persisted')
  else bad('disposition mismatch', JSON.stringify(ds))
  if (persisted[3].scrapReason === 'cracked screen') ok('scrap reason persisted on SCRAP item')
  else bad('scrap reason missing', JSON.stringify(persisted[3]))
}

// ── Restock — single-warehouse fallback path (no kinded warehouses
// in the org → all non-SCRAP items land in default).
console.log('\n[3] Restock — fallback to default warehouse')
const stockBefore = (await dbq(
  `SELECT COALESCE(SUM(change), 0) AS total FROM "StockMovement" WHERE "productId" = $1 AND "referenceType" = 'Return' AND "referenceId" = $2`,
  [productRow.id, id],
))[0].total
{
  const r = await fetch(`${API}/api/fulfillment/returns/${id}/restock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const j = await r.json()
  if (r.ok && j.status === 'RESTOCKED') ok('restock 200 → status RESTOCKED')
  else bad('restock failed', JSON.stringify(j).slice(0, 200))
}
{
  // 3 movements expected (SELLABLE + SECOND_QUALITY + QUARANTINE).
  // The SCRAP item produces no movement.
  const mv = await dbq(
    `SELECT change, notes FROM "StockMovement"
     WHERE "productId" = $1 AND "referenceType" = 'Return' AND "referenceId" = $2
     ORDER BY "createdAt" ASC`,
    [productRow.id, id],
  )
  if (mv.length === 3) ok(`3 stock movements (1 per non-SCRAP disposition)`)
  else bad(`expected 3, got ${mv.length}`, JSON.stringify(mv))
  const dispositionsInNotes = mv.map(m => (m.notes ?? '').match(/disposition=([A-Z_]+)/)?.[1])
  if (JSON.stringify(dispositionsInNotes) === JSON.stringify(['SELLABLE', 'SECOND_QUALITY', 'QUARANTINE'])) {
    ok('movement notes carry disposition tags in the right order')
  } else bad('movement disposition tags wrong', JSON.stringify(dispositionsInNotes))
  if (mv.every(m => (m.notes ?? '').includes('fell back to default'))) {
    ok('all non-SELLABLE movements report fallback (no kinded warehouse exists)')
  } else bad('fallback markers missing', JSON.stringify(mv.map(m => m.notes)))
}

// ── Audit trail surfaces dispositions
console.log('\n[4] AuditLog — restock entry carries dispositions')
await new Promise((r) => setTimeout(r, 400))
{
  const audit = await dbq(
    `SELECT after FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1 AND action = 'restock' ORDER BY "createdAt" DESC LIMIT 1`,
    [id],
  )
  if (audit.length === 1) {
    const after = audit[0].after
    const restockedDisps = (after?.restockedItems ?? []).map((r) => r.disposition).sort()
    if (JSON.stringify(restockedDisps) === JSON.stringify(['QUARANTINE', 'SECOND_QUALITY', 'SELLABLE'])) {
      ok('restocked dispositions: ' + restockedDisps.join(','))
    } else bad('audit restocked mismatch', JSON.stringify(restockedDisps))
    const skippedScrap = (after?.skippedItems ?? []).filter((s) => s.disposition === 'SCRAP')
    if (skippedScrap.length === 1 && skippedScrap[0].reason === 'cracked screen') {
      ok('SCRAP item recorded with reason in skipped list')
    } else bad('scrap audit mismatch', JSON.stringify(skippedScrap))
  } else bad('no restock audit entry', '')
}

// ── Kind-matching path: tag the default warehouse with kind=PRIMARY
// and a second one (if exists) with kind=SECOND_QUALITY → make a new
// return and confirm SECOND_QUALITY items land in the second WH.
console.log('\n[5] Kind-matching warehouse routing')
{
  const warehouses = await dbq(`SELECT id, code, "isDefault" FROM "Warehouse" WHERE "isActive" ORDER BY "isDefault" DESC, code ASC LIMIT 2`)
  if (warehouses.length < 2) {
    console.log('  → only 1 warehouse exists; skipping kind-matching gate. (Single-warehouse fallback above is the production path.)')
  } else {
    // Tag the second warehouse as SECOND_QUALITY temporarily.
    const primary = warehouses[0]
    const secondQ = warehouses[1]
    const originalKind = (await dbq(`SELECT kind FROM "Warehouse" WHERE id = $1`, [secondQ.id]))[0].kind
    await dbq(`UPDATE "Warehouse" SET kind = 'SECOND_QUALITY' WHERE id = $1`, [secondQ.id])
    try {
      const c2 = await fetch(`${API}/api/fulfillment/returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'AMAZON',
          orderId: orderRow?.id,
          reason: 'R32_KIND_TEST',
          items: [
            { sku: productRow.sku, productId: productRow.id, quantity: 1 },
            { sku: productRow.sku, productId: productRow.id, quantity: 1 },
          ],
        }),
      })
      const r2 = await c2.json()
      const id2 = r2.id
      const items2 = await dbq(`SELECT id FROM "ReturnItem" WHERE "returnId" = $1 ORDER BY id`, [id2])
      await fetch(`${API}/api/fulfillment/returns/${id2}/receive`, { method: 'POST' })
      await fetch(`${API}/api/fulfillment/returns/${id2}/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [
            { itemId: items2[0].id, conditionGrade: 'NEW', disposition: 'SELLABLE' },
            { itemId: items2[1].id, conditionGrade: 'GOOD', disposition: 'SECOND_QUALITY' },
          ],
        }),
      })
      const restock2 = await fetch(`${API}/api/fulfillment/returns/${id2}/restock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!restock2.ok) bad('restock 2 failed', await restock2.text().then(t => t.slice(0, 200)))
      const mv2 = await dbq(
        `SELECT "warehouseId", notes FROM "StockMovement"
         WHERE "referenceType" = 'Return' AND "referenceId" = $1
         ORDER BY "createdAt" ASC`,
        [id2],
      )
      const sellable = mv2.find(m => m.notes?.includes('SELLABLE'))
      const secondQty = mv2.find(m => m.notes?.includes('SECOND_QUALITY'))
      if (sellable && sellable.warehouseId === primary.id) ok('SELLABLE → default/PRIMARY warehouse')
      else bad('SELLABLE routing wrong', JSON.stringify(sellable))
      if (secondQty && secondQty.warehouseId === secondQ.id && !secondQty.notes.includes('fell back')) {
        ok('SECOND_QUALITY → kind-matched warehouse (no fallback)')
      } else bad('SECOND_QUALITY routing wrong', JSON.stringify(secondQty))
      // Cleanup the second test return
      await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [id2])
      await dbq(`DELETE FROM "Return" WHERE id = $1`, [id2])
      await dbq(`DELETE FROM "StockMovement" WHERE "referenceType" = 'Return' AND "referenceId" = $1`, [id2])
    } finally {
      // Restore warehouse kind regardless.
      await dbq(`UPDATE "Warehouse" SET kind = $1 WHERE id = $2`, [originalKind, secondQ.id])
    }
  }
}

// Cleanup primary test return
console.log('\n[6] Cleanup')
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = $1`, [id])
await dbq(`DELETE FROM "Return" WHERE id = $1`, [id])
await dbq(`DELETE FROM "StockMovement" WHERE "referenceType" = 'Return' AND "referenceId" = $1`, [id])
ok('test rows + audit logs + stock movements deleted')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
