#!/usr/bin/env node
/**
 * Seed for `tests/sheet-bulk-autosave.spec.ts`: a made-up family of N variations (default 500), each with a DRAFT,
 * unpublished eBay · IT listing, plus two made-up description themes. Nothing here names a real product, listing,
 * seller or account (the repository is public), and nothing can reach eBay: no listing has an external id, and a
 * connection this script has to create carries no credentials.
 *
 *   E2E_DATABASE_URL=postgresql://…@127.0.0.1:<port>/<db> node tests/fixtures/bulk-autosave-seed.mjs [rows]
 *
 * 🔴 LOCAL ONLY. It refuses any database that is not on this machine (hard rule 1: nothing from this machine touches
 * production). Idempotent: it deletes and recreates its own family, and only that.
 */
import pg from 'pg'

const FAMILY = 'e2e_bulk_autosave'
const THEMES = [{ id: 'e2e_theme_a', name: 'E2E Theme A' }, { id: 'e2e_theme_b', name: 'E2E Theme B' }]
const rows = Number(process.argv[2] ?? 500)
const url = process.env.E2E_DATABASE_URL
if (!url) throw new Error('Set E2E_DATABASE_URL to a LOCAL database.')
const host = new URL(url).hostname
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`Refusing ${host}: this seed writes only to a database on this machine.`)
const workspaceId = process.env.E2E_WORKSPACE_ID ?? 'nexus_legacy_workspace'

const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  await db.query('BEGIN')
  await db.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [workspaceId])
  const market = await db.query(`SELECT 1 FROM "Marketplace" WHERE channel = 'EBAY' AND code = 'IT' AND "workspaceId" = $1`, [workspaceId])
  if (!market.rowCount) {
    await db.query(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, currency, region, language, languages, "isActive", "updatedAt")
      VALUES ('e2e_market_ebay_it', $1, 'EBAY', 'IT', 'Italy', 'EUR', 'EU', 'it', ARRAY['it'], true, now())`, [workspaceId])
  }
  let connection = (await db.query(`SELECT id FROM "ChannelConnection" WHERE "channelType" = 'EBAY' AND "isActive" AND "workspaceId" = $1
    ORDER BY "isPrimary" DESC, id LIMIT 1`, [workspaceId])).rows[0]?.id
  if (!connection) {
    connection = 'e2e_ebay_connection'
    await db.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "isActive", "isPrimary", "displayName", "updatedAt")
      VALUES ($1, $2, 'EBAY', true, true, 'E2E eBay (no credentials)', now()) ON CONFLICT (id) DO NOTHING`, [connection, workspaceId])
  }
  for (const theme of THEMES) {
    await db.query(`INSERT INTO "EbayDescriptionTheme" (id, "workspaceId", name, html, "updatedAt") VALUES ($1, $2, $3, '<div>{{description}}</div>', now())
      ON CONFLICT (id) DO NOTHING`, [theme.id, workspaceId, theme.name])
  }
  // Only this family: its listings, then its variations, then the parent.
  await db.query(`DELETE FROM "ChannelListing" WHERE "productId" = $1 OR "productId" LIKE $2`, [FAMILY, `${FAMILY}_%`])
  await db.query(`DELETE FROM "Product" WHERE "parentId" = $1`, [FAMILY])
  await db.query(`DELETE FROM "Product" WHERE id = $1`, [FAMILY])
  await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "isParent", "updatedAt") VALUES ($1, $2, 'E2E-BULK-AUTOSAVE', 'E2E bulk autosave family', 10, true, now())`, [FAMILY, workspaceId])
  const ids = Array.from({ length: rows }, (_, i) => `${FAMILY}_${String(i + 1).padStart(3, '0')}`)
  await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "updatedAt")
    SELECT id, $2, upper(replace(id, '_', '-')), 'E2E variation ' || right(id, 3), 10, $3, now() FROM unnest($1::text[]) AS id`, [ids, workspaceId, FAMILY])
  await db.query(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, "channelMarket", marketplace, region, "channelConnectionId", "listingStatus", "isPublished", "updatedAt")
    SELECT 'l_' || id, $2, id, 'EBAY', 'EBAY_IT', 'IT', 'EU', $3, 'DRAFT', false, now() FROM unnest($1::text[]) AS id`, [[FAMILY, ...ids], workspaceId, connection])
  await db.query('COMMIT')
  console.log(JSON.stringify({ family: FAMILY, variations: rows, themes: THEMES.map(t => t.id), connection }))
} catch (error) {
  await db.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await db.end()
}
