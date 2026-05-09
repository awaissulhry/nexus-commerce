#!/usr/bin/env node
// Stand-alone runner for the BulkActionTemplate seeds (mirrors
// services/bulk-action-template-seeds.ts so we can verify W5.4 without
// booting the full API).
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
dotenv.config({ path: path.join(repo, '.env') })

let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')

const c = new pg.Client({ connectionString: url })
await c.connect()

const SEED_USER_ID = '__builtin'

const SEEDS = [
  { name: 'Spring sale — N% off', actionType: 'PRICING_UPDATE', category: 'pricing',
    actionPayload: { adjustmentType: 'PERCENT', value: '${pct}' },
    parameters: [{ name: 'pct', label: 'Discount %', type: 'number', defaultValue: -10, required: true, min: -90, max: 90 }],
    defaultFilters: { status: 'ACTIVE' } },
  { name: 'Round prices to .99', actionType: 'PRICING_UPDATE', category: 'pricing',
    actionPayload: { adjustmentType: 'ABSOLUTE', value: '${target}' },
    parameters: [{ name: 'target', label: 'Target price', type: 'number', defaultValue: 99.99, required: true, min: 0 }] },
  { name: 'Flat €N markup', actionType: 'PRICING_UPDATE', category: 'pricing',
    actionPayload: { adjustmentType: 'DELTA', value: '${delta}' },
    parameters: [{ name: 'delta', label: 'Amount', type: 'number', defaultValue: 5, required: true }] },
  { name: 'Reset stock to N', actionType: 'INVENTORY_UPDATE', category: 'inventory',
    actionPayload: { adjustmentType: 'ABSOLUTE', value: '${qty}' },
    parameters: [{ name: 'qty', label: 'Quantity', type: 'number', defaultValue: 0, required: true, min: 0 }] },
  { name: 'Adjust stock by ±N', actionType: 'INVENTORY_UPDATE', category: 'inventory',
    actionPayload: { adjustmentType: 'DELTA', value: '${delta}' },
    parameters: [{ name: 'delta', label: 'Quantity change', type: 'number', defaultValue: 0, required: true }] },
  { name: 'End-of-life — set INACTIVE', actionType: 'STATUS_UPDATE', category: 'status',
    actionPayload: { status: 'INACTIVE' } },
  { name: 'Move to DRAFT (review queue)', actionType: 'STATUS_UPDATE', category: 'status',
    actionPayload: { status: 'DRAFT' } },
  { name: 'Republish — set ACTIVE', actionType: 'STATUS_UPDATE', category: 'status',
    actionPayload: { status: 'ACTIVE' } },
  { name: 'Resync prices to all channels', actionType: 'LISTING_SYNC', category: 'channel',
    actionPayload: { syncType: 'PRICE_UPDATE', channels: [] } },
  { name: 'Resync inventory to all channels', actionType: 'LISTING_SYNC', category: 'channel',
    actionPayload: { syncType: 'QUANTITY_UPDATE', channels: [] } },
  { name: 'Full resync (all fields, all channels)', actionType: 'LISTING_SYNC', category: 'channel',
    actionPayload: { syncType: 'FULL_SYNC', channels: [] } },
  { name: 'Pause listings (Amazon DE)', actionType: 'MARKETPLACE_OVERRIDE_UPDATE', channel: 'AMAZON', category: 'channel',
    actionPayload: { isPublished: false } },
]

let created = 0, updated = 0
for (const t of SEEDS) {
  const { rows } = await c.query(
    `SELECT id FROM "BulkActionTemplate" WHERE "userId" = $1 AND name = $2`,
    [SEED_USER_ID, t.name],
  )
  if (rows.length > 0) {
    await c.query(
      `UPDATE "BulkActionTemplate" SET
         "actionType" = $2,
         channel = $3,
         "actionPayload" = $4::jsonb,
         "defaultFilters" = $5::jsonb,
         parameters = $6::jsonb,
         category = $7,
         "isBuiltin" = true,
         "updatedAt" = NOW()
       WHERE id = $1`,
      [
        rows[0].id,
        t.actionType,
        t.channel ?? null,
        JSON.stringify(t.actionPayload),
        t.defaultFilters ? JSON.stringify(t.defaultFilters) : null,
        JSON.stringify(t.parameters ?? []),
        t.category,
      ],
    )
    updated++
  } else {
    await c.query(
      `INSERT INTO "BulkActionTemplate" (
         id, name, "actionType", channel,
         "actionPayload", "defaultFilters", parameters,
         category, "userId", "isBuiltin",
         "createdBy", "createdAt", "updatedAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3,
         $4::jsonb, $5::jsonb, $6::jsonb,
         $7, $8, true,
         'seed', NOW(), NOW()
       )`,
      [
        t.name,
        t.actionType,
        t.channel ?? null,
        JSON.stringify(t.actionPayload),
        t.defaultFilters ? JSON.stringify(t.defaultFilters) : null,
        JSON.stringify(t.parameters ?? []),
        t.category,
        SEED_USER_ID,
      ],
    )
    created++
  }
}

console.log(`Seeded BulkActionTemplate — created=${created}, updated=${updated}`)
const { rows: total } = await c.query(
  `SELECT count(*)::int FROM "BulkActionTemplate" WHERE "isBuiltin" = true`,
)
console.log(`Total builtin templates in DB: ${total[0].count}`)

await c.end()
