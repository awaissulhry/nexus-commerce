#!/usr/bin/env node
/**
 * Seed for `tests/sheet-alias-save.spec.ts` and `tests/sheet-save-races.spec.ts`: a made-up eBay · DE family of one
 * parent and one variation, listed twice on one credential-less eBay account — the primary listing and a second
 * listing ALIAS (`ProductListingAlias`, as `listing-alias.service.ts#createAlias` writes it) — with a DRAFT,
 * unpublished, paused listing for primary and alias on parent and child, and German translations: the parent's title
 * is "German original" (the paste test reads it back), the child's translation is at version 3. At version 1 a stale
 * copied cell's save could not be told from one against a recreated translation (`fixtures/recreate-sheet-translation.mjs`
 * recreates it at version 1), so the race test would pass for the wrong reason.
 *
 * Nothing here names a real product, listing, seller or account (the repository is public), and nothing can reach
 * eBay: no listing has an external id, every listing is paused, and the connection carries no credentials.
 *
 *   E2E_DATABASE_URL=postgresql://…@127.0.0.1:<port>/<name containing "test"> node tests/fixtures/sheet-alias-seed.mjs
 *
 * Prints the fixture as JSON — `{ family, child, alias, account }`, the shape the specs read from E2E_ALIAS_FIXTURE.
 * With --out <file> it also writes it there.
 *
 * 🔴 LOCAL ONLY. It refuses any database that is not on this machine or whose name does not contain "test" (hard
 * rule 1). Idempotent: it deletes and recreates its own family and alias, and only those.
 */
import { writeFileSync } from 'node:fs'
import pg from 'pg'

const FAMILY = 'e2e_aaa_save'
const CHILD = 'e2e_aaa_save_child'
const ALIAS = 'e2e_aaa_save_alias'
const CONNECTION = 'e2e_ebay_alias_connection'
const MARKET = 'DE'

const raw = process.env.E2E_DATABASE_URL
if (!raw) throw new Error('Set E2E_DATABASE_URL to a LOCAL test database.')
const url = new URL(raw)
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
  throw new Error(`Refusing ${url.hostname}${url.pathname}: this seed writes only to a database on this machine whose name contains "test".`)
}
const workspaceId = process.env.E2E_WORKSPACE_ID ?? 'nexus_legacy_workspace'
const outIndex = process.argv.indexOf('--out')
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined

const db = new pg.Client({ connectionString: url.href })
await db.connect()
try {
  await db.query('BEGIN')
  await db.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [workspaceId])
  const market = await db.query(`SELECT 1 FROM "Marketplace" WHERE channel = 'EBAY' AND code = $2 AND "workspaceId" = $1`, [workspaceId, MARKET])
  if (!market.rowCount) {
    await db.query(`INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, currency, region, language, languages, "isActive", "marketplaceId", "updatedAt")
      VALUES ('e2e_market_ebay_de', $1, 'EBAY', $2, 'Germany', 'EUR', 'EU', 'de', ARRAY['de'], true, 'EBAY_DE', now())`, [workspaceId, MARKET])
  }
  // Its own account, never the business's primary: no other sheet changes its default account because of this seed.
  await db.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "isActive", "isPrimary", "displayName", "accountLabel", "updatedAt")
    VALUES ($1, $2, 'EBAY', true, false, 'E2E eBay aliases (no credentials)', 'E2E aliases', now())
    ON CONFLICT (id) DO UPDATE SET "isActive" = true`, [CONNECTION, workspaceId])

  // Only this family: its listings and alias go with its products (both cascade), children first.
  await db.query(`DELETE FROM "ChannelListing" WHERE "productId" = ANY($1::text[])`, [[FAMILY, CHILD]])
  await db.query(`DELETE FROM "ProductListingAlias" WHERE id = $1 OR "productId" = $2`, [ALIAS, FAMILY])
  await db.query(`DELETE FROM "Product" WHERE id = $1 OR "parentId" = $2`, [CHILD, FAMILY])
  await db.query(`DELETE FROM "Product" WHERE id = $1`, [FAMILY])

  await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "isParent", "updatedAt")
    VALUES ($1, $2, 'E2E-ALIAS-SAVE', 'E2E alias family', 10, true, now())`, [FAMILY, workspaceId])
  await db.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, brand, "basePrice", "parentId", "updatedAt")
    VALUES ($1, $2, 'E2E-ALIAS-SAVE-1', 'E2E alias variation', 'E2E brand', 10, $3, now())`, [CHILD, workspaceId, FAMILY])
  await db.query(`INSERT INTO "ProductTranslation" (id, "workspaceId", "productId", language, name, description, version, "updatedAt") VALUES
    ($1, $3, $4, 'de', 'German original', 'Deutsche Beschreibung', 1, now()),
    ($2, $3, $5, 'de', 'Deutsche Variante', 'Deutsche Beschreibung der Variante', 3, now())`, [`${FAMILY}_de`, `${CHILD}_de`, workspaceId, FAMILY, CHILD])

  await db.query(`INSERT INTO "ProductListingAlias" (id, "workspaceId", "productId", channel, marketplace, "channelConnectionId", label, position, status, "updatedAt")
    VALUES ($1, $2, $3, 'EBAY', $4, $5, 'E2E second listing', 1, 'ACTIVE', now())`, [ALIAS, workspaceId, FAMILY, MARKET, CONNECTION])
  // As `draftListingFields` writes a draft: DRAFT, unpublished, paused, no external id, no price or quantity.
  for (const aliasKey of ['', ALIAS]) {
    for (const productId of [FAMILY, CHILD]) {
      await db.query(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, "channelMarket", region, "channelConnectionId",
          "aliasKey", "aliasId", "listingStatus", "isPublished", "syncPaused", "updatedAt")
        VALUES ($1, $2, $3, 'EBAY', $4, $5, 'EU', $6, $7, $8, 'DRAFT', false, true, now())`,
        [`l_${aliasKey ? 'alias' : 'primary'}_${productId}`, workspaceId, productId, MARKET, `EBAY_${MARKET}`, CONNECTION, aliasKey, aliasKey || null])
    }
  }
  await db.query('COMMIT')
  const fixture = { family: FAMILY, child: CHILD, alias: ALIAS, account: CONNECTION }
  if (out) writeFileSync(out, JSON.stringify(fixture))
  console.log(JSON.stringify(fixture))
} catch (error) {
  await db.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await db.end()
}
