#!/usr/bin/env node
// Verify R6.1 — return policy CRUD + window/deadline resolution.
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

console.log('\n[1] List policies — seed rows present')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies`)
  const j = await r.json()
  if (r.ok && Array.isArray(j.items) && j.items.length >= 3) ok(`${j.items.length} policies returned`)
  else bad('list shape wrong', JSON.stringify(j).slice(0, 200))
  const channels = j.items.map((p) => p.channel)
  if (['AMAZON', 'EBAY', 'SHOPIFY'].every((c) => channels.includes(c))) ok('all 3 active-channel seeds present')
  else bad('seed coverage', channels.join(','))
}

console.log('\n[2] Resolve baseline → channel-only seed match')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=AMAZON`)
  const j = await r.json()
  if (r.ok && j.policy?.windowDays === 14 && j.policy?.refundDeadlineDays === 14) ok('baseline window=14 deadline=14')
  else bad('baseline policy wrong', JSON.stringify(j))
  if (j.policy?.source === 'channel_only') ok('source=channel_only (seed match)')
  else bad('source mismatch', j.policy?.source)
}

console.log('\n[3] Create override policy — AMAZON IT marketplace = 30-day window')
let createdId = null
{
  const r = await fetch(`${API}/api/fulfillment/return-policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'r61-verify' },
    body: JSON.stringify({
      channel: 'AMAZON',
      marketplace: 'IT',
      windowDays: 30,
      refundDeadlineDays: 14,
      buyerPaysReturn: true,
      restockingFeePct: 10,
      notes: 'IT marketplace 30-day extended window',
    }),
  })
  const j = await r.json()
  if (r.ok && j.id) ok(`created policy ${j.id}`)
  else bad('create failed', JSON.stringify(j))
  createdId = j.id
}

console.log('\n[4] Resolve with marketplace match → most-specific override wins')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=AMAZON&marketplace=IT`)
  const j = await r.json()
  if (j.policy?.windowDays === 30 && j.policy?.source === 'channel_marketplace') ok('IT-specific 30-day window resolved')
  else bad('marketplace match failed', JSON.stringify(j.policy))
  if (j.policy?.buyerPaysReturn === true) ok('buyerPaysReturn=true from override')
  if (Number(j.policy?.restockingFeePct) === 10) ok('restockingFeePct=10 from override')
}

console.log('\n[5] Resolve with non-IT marketplace → falls back to channel-only seed')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=AMAZON&marketplace=DE`)
  const j = await r.json()
  if (j.policy?.windowDays === 14 && j.policy?.source === 'channel_only') ok('DE marketplace falls back to 14-day seed')
  else bad('fallback wrong', JSON.stringify(j.policy))
}

console.log('\n[6] Window check — 7 days post-delivery on 14-day window → in window')
{
  const deliveredAt = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=EBAY&deliveredAt=${encodeURIComponent(deliveredAt)}`)
  const j = await r.json()
  if (j.window?.inWindow === true && j.window?.daysSinceDelivery === 7) ok('7d → inWindow=true')
  else bad('7d window check wrong', JSON.stringify(j.window))
}

console.log('\n[7] Window check — 20 days post-delivery → outside window')
{
  const deliveredAt = new Date(Date.now() - 20 * 86_400_000).toISOString()
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=EBAY&deliveredAt=${encodeURIComponent(deliveredAt)}`)
  const j = await r.json()
  if (j.window?.inWindow === false && j.window?.daysSinceDelivery === 20) ok('20d → inWindow=false')
  else bad('20d window check wrong', JSON.stringify(j.window))
  if (j.window?.reason === 'outside_window') ok('reason=outside_window')
  else bad('reason mismatch', j.window?.reason)
}

console.log('\n[8] Window check — no deliveredAt → reason=no_delivery_date')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=EBAY`)
  const j = await r.json()
  if (j.window?.reason === 'no_delivery_date' && j.window?.inWindow === true) ok('no delivery date → inWindow=true (operator decides)')
  else bad('no-date case wrong', JSON.stringify(j.window))
}

console.log('\n[9] PATCH policy — toggle isActive')
{
  const r = await fetch(`${API}/api/fulfillment/return-policies/${createdId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: false, notes: 'paused for review' }),
  })
  const j = await r.json()
  if (r.ok && j.isActive === false && j.notes === 'paused for review') ok('toggle + notes update')
  else bad('patch failed', JSON.stringify(j))
}

console.log('\n[10] Resolver skips inactive policies')
{
  // After deactivating the IT override, AMAZON IT should fall back to seed
  const r = await fetch(`${API}/api/fulfillment/return-policies/resolve?channel=AMAZON&marketplace=IT`)
  const j = await r.json()
  if (j.policy?.source === 'channel_only') ok('inactive override skipped, seed wins')
  else bad('inactive policy still applied', JSON.stringify(j.policy))
}

console.log('\n[11] DELETE policy — non-seeded → 200; seeded → 409')
{
  const r1 = await fetch(`${API}/api/fulfillment/return-policies/${createdId}`, { method: 'DELETE' })
  if (r1.ok) ok('non-seeded policy deleted')
  else bad('delete failed', await r1.text())
  const r2 = await fetch(`${API}/api/fulfillment/return-policies/seed_amazon_default`, { method: 'DELETE' })
  if (r2.status === 409) ok('seeded baseline → 409')
  else bad(`expected 409, got ${r2.status}`, await r2.text())
}

console.log('\n[12] Unique constraint on (channel, marketplace, productType)')
{
  const body = { channel: 'EBAY', marketplace: null, productType: null }
  // Already exists as seed_ebay_default
  const r = await fetch(`${API}/api/fulfillment/return-policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (r.status === 409) ok('duplicate scope → 409')
  else bad(`expected 409, got ${r.status}`, await r.text().then(t => t.slice(0, 100)))
}

console.log('\n[13] Per-return policy view (drawer)')
{
  // Need a real return to test
  const productRow = (await dbq(`SELECT sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
  const create = await fetch(`${API}/api/fulfillment/returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: 'EBAY',
      reason: 'R61_TEST',
      items: [{ sku: productRow.sku, quantity: 1 }],
    }),
  })
  const ret = await create.json()
  // Mark as received 5 days ago so deadline check has data
  await dbq(`UPDATE "Return" SET "receivedAt" = NOW() - INTERVAL '5 days' WHERE id = $1`, [ret.id])
  const r = await fetch(`${API}/api/fulfillment/returns/${ret.id}/policy`)
  const j = await r.json()
  if (r.ok && j.window && j.deadline) ok('per-return policy view returns window + deadline')
  else bad('shape wrong', JSON.stringify(j).slice(0, 200))
  if (j.deadline?.daysUntilDeadline === 9 && j.deadline?.status === 'safe') ok(`deadline countdown: ${j.deadline.daysUntilDeadline} days, status=safe`)
  else bad('deadline math wrong', JSON.stringify(j.deadline))
  // Cleanup
  await dbq(`DELETE FROM "Return" WHERE id = $1`, [ret.id])
}

console.log('\n[14] Cleanup AuditLog rows for this run')
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'ReturnPolicy' AND "entityId" = $1`, [createdId])
ok('audit rows cleaned')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
