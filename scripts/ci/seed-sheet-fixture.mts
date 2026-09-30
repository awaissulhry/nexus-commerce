#!/usr/bin/env -S npx tsx
/**
 * P3 guardrail 1 (2026-09-30) — the product-sheet commit sweep's fixture: made-up families on every scope the sweep opens,
 * with made-up cached channel schemas, so `apps/web/smoke/sheet` can commit one value into EVERY editable column.
 *
 * WHY. Every sheet bug of 2026-09-29 (Enter and Tab dropped the choice, the chevron did nothing, an open list refused a
 * typed value) was invisible to CI: the smoke seed has no family, no listing and no channel schema, so no test ever
 * opened a channel sheet, let alone committed a cell in one.
 *
 * WHAT IT CREATES — all names start `e2e_sheet_` / `E2E-SHEET-`, all ids are made up (the repository is public):
 * - one family per scope — `master`, `EBAY` (IT), `AMAZON` (IT), `ETSY` (GLOBAL) — each a parent and `--rows` variations
 *   (default 150: the sweep gives every (column × gesture) its own row, so a commit always changes a known value). A
 *   channel family's rows each carry one DRAFT listing on that channel: no external id, never published;
 * - the cached schemas those listings point at, under made-up codes that no channel uses (each code has a twin with the
 *   same contract, so the sweep can change a row's category without changing its columns):
 *     EBAY IT category `99000101` — aspects covering a long strict list (12), a short strict list (4), an open list (a
 *       FREE_TEXT aspect with suggestions), free text, a number and a multi-value list;
 *     AMAZON IT product type `E2E_SHEET_OUTERWEAR` — the trimmed product-type definition the API's own spec tests use
 *       (`channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json`: scalar, enum, list, measure, compound, nested);
 *     ETSY GLOBAL taxonomy `99000201` — a closed property, a multi-valued one and a free one;
 * - two description themes (the eBay `descriptionThemeId` reference column's choices);
 * - a made-up category TAXONOMY per coordinate (the category editor searches it), but ONLY where the business has none:
 *   a real taxonomy is never written to. The output says, per channel, whether the category column can be swept;
 * - a connection per channel when the business has no active one — WITHOUT credentials, so nothing can reach a channel.
 *   An existing active connection is reused (the sheet resolves the business's primary one), never modified.
 * - a NONCE in every family name: the sweep's setup reads it back through the UI before any test runs, which proves the
 *   app answering is the one on THIS database (the smoke suite's fence).
 *
 * Idempotent: it deletes and recreates its own rows, and only those. The listings, products and schemas it deletes are
 * matched by their made-up ids and codes.
 *
 * SAFETY: loopback only, and the database name must contain "test" (as `seed-smoke.mts`). Writes `--out` (mode 600).
 *
 *   npx tsx scripts/ci/seed-sheet-fixture.mts --url postgresql://postgres@127.0.0.1:5432/nexus_smoke_test --out "$RUNNER_TEMP/sheet.json"
 *   … --workspace <id>   the business to seed (default: the legacy one)      … --rows <n>   variations per family
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import pg from 'pg'

const args = process.argv.slice(2)
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const url = new URL(value('--url') ?? process.env.NEXUS_TEST_LOCAL_PG_URL ?? '')
const out = value('--out')
if (!out) { console.error('✗ --out <file> is required'); process.exit(1) }
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
  console.error(`✗ REFUSED: ${url.hostname}${url.pathname} — only a loopback database whose name contains "test"`)
  process.exit(1)
}
const workspace = value('--workspace') ?? 'nexus_legacy_workspace'
const rows = Number(value('--rows') ?? 150)
if (!Number.isInteger(rows) || rows < 1 || rows > 999) { console.error('✗ --rows must be 1..999'); process.exit(1) }
const nonce = randomBytes(4).toString('hex').toUpperCase()

const EBAY_CATEGORY = '99000101'
const AMAZON_TYPE = 'E2E_SHEET_OUTERWEAR'
const ETSY_TAXONOMY = '99000201'
/* The category column's commit needs a SECOND category with the same contract, so changing a row's category keeps its
   columns. Each coordinate gets two made-up categories under one made-up schema. */
const CATEGORIES = {
  EBAY: { market: 'IT', schemaMarket: 'IT', ids: [EBAY_CATEGORY, '99000102'], names: ['E2E Giacche', 'E2E Giubbotti'] },
  AMAZON: { market: 'IT', schemaMarket: 'IT', ids: [AMAZON_TYPE, 'E2E_SHEET_OUTERWEAR_B'], names: ['E2E outerwear', 'E2E outerwear B'] },
  ETSY: { market: 'GLOBAL', schemaMarket: 'GLOBAL', ids: [ETSY_TAXONOMY, '99000202'], names: ['E2E Jackets', 'E2E Coats'] },
} as const
const SCHEMA_VERSION = 'e2e-sheet-fixture'
const THEMES = [{ id: 'e2e_sheet_theme_a', name: 'E2E Sheet Theme A' }, { id: 'e2e_sheet_theme_b', name: 'E2E Sheet Theme B' }]

/* Made-up aspects in the eBay cache shape (`channel-specs/ebay.ts` EbayCachedAspect). Labels are "localized (English)". */
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL', '6XL', '7XL']
const EBAY_ASPECTS = [
  { id: 'aspect_E2E_Taglia', kind: 'enum', label: 'E2E Taglia (E2E Size)', options: SIZES, enumMode: 'strict', cardinality: 'SINGLE', required: true, variantEligible: true },
  { id: 'aspect_E2E_Stagione', kind: 'enum', label: 'E2E Stagione (E2E Season)', options: ['Primavera', 'Estate', 'Autunno', 'Inverno'], enumMode: 'strict', cardinality: 'SINGLE' },
  { id: 'aspect_E2E_Marca', kind: 'enum', label: 'E2E Marca (E2E Brand)', options: ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa'], enumMode: 'open', cardinality: 'SINGLE', recommended: true },
  { id: 'aspect_E2E_Nota', kind: 'text', label: 'E2E Nota (E2E Note)', cardinality: 'SINGLE', maxLength: 65 },
  { id: 'aspect_E2E_Peso', kind: 'number', label: 'E2E Peso netto (E2E Net weight)', dataType: 'NUMBER', cardinality: 'SINGLE' },
  { id: 'aspect_E2E_Caratteristiche', kind: 'enum', label: 'E2E Caratteristiche (E2E Features)', options: ['Impermeabile', 'Traspirante', 'Riflettente', 'Imbottito', 'Antivento'], enumMode: 'strict', cardinality: 'MULTI' },
]
const EBAY_CONDITIONS = [{ value: '1000', label: 'Nuovo' }, { value: '1500', label: 'Nuovo (altro)' }, { value: '3000', label: 'Usato' }]

/* Made-up Etsy taxonomy properties in the Etsy API shape (`channel-specs/etsy-loader.ts` readEtsyProperties). */
const etsyProperty = (id: number, name: string, extra: Record<string, unknown>) => ({
  property_id: id, name, display_name: name, is_required: false, supports_attributes: true, supports_variations: false,
  is_multivalued: false, max_values_allowed: null, scales: [], possible_values: [], selected_values: [], ...extra,
})
const ETSY_PROPERTIES = [
  etsyProperty(990001, 'E2E Primary colour', { possible_values: ['Black', 'Blue', 'Brown', 'Green', 'Grey', 'Red', 'White', 'Yellow', 'Orange', 'Purple'].map((name, i) => ({ value_id: 991000 + i, name, scale_id: null, equal_to: [] })) }),
  etsyProperty(990002, 'E2E Occasion', { is_multivalued: true, max_values_allowed: 3, possible_values: ['Birthday', 'Wedding', 'Travel', 'Sport'].map((name, i) => ({ value_id: 992000 + i, name, scale_id: null, equal_to: [] })) }),
  etsyProperty(990003, 'E2E Pattern', { possible_values: ['Plain', 'Striped', 'Checked'].map((name, i) => ({ value_id: 993000 + i, name, scale_id: null, equal_to: [] })) }),
]

const amazonDefinition = JSON.parse(readFileSync(new URL('../../apps/api/src/services/pim/channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json', import.meta.url), 'utf8'))

const FAMILIES = [
  { scope: 'master', id: 'e2e_sheet_master', sku: 'E2E-SHEET-MASTER', label: 'Shared' },
  { scope: 'EBAY', id: 'e2e_sheet_ebay', sku: 'E2E-SHEET-EBAY', label: 'eBay', channel: 'EBAY', market: 'IT', channelMarket: 'EBAY_IT', region: 'IT', attributes: { categoryId: EBAY_CATEGORY } },
  { scope: 'AMAZON', id: 'e2e_sheet_amazon', sku: 'E2E-SHEET-AMAZON', label: 'Amazon', channel: 'AMAZON', market: 'IT', channelMarket: 'AMAZON_IT', region: 'IT', productType: AMAZON_TYPE, attributes: { productType: AMAZON_TYPE } },
  { scope: 'ETSY', id: 'e2e_sheet_etsy', sku: 'E2E-SHEET-ETSY', label: 'Etsy', channel: 'ETSY', market: 'GLOBAL', channelMarket: 'ETSY_GLOBAL', region: 'GLOBAL', attributes: { taxonomy_id: Number(ETSY_TAXONOMY) } },
] as const

const client = new pg.Client({ connectionString: url.toString() })
await client.connect()
const seeded: Record<string, unknown> = {}
try {
  await client.query('BEGIN')
  await client.query(`SELECT set_config('nexus.workspace_id', $1, true)`, [workspace])
  const exists = await client.query(`SELECT 1 FROM "Workspace" WHERE id = $1`, [workspace])
  if (!exists.rowCount) throw new Error(`business ${workspace} does not exist — run prepare-test-database (and seed-smoke) first`)

  // ── markets and connections ────────────────────────────────────────────────────────────────────────────
  for (const f of FAMILIES) {
    if (!('channel' in f)) continue
    const market = await client.query(`SELECT 1 FROM "Marketplace" WHERE channel = $1 AND code = $2 AND "workspaceId" = $3`, [f.channel, f.market, workspace])
    if (!market.rowCount) throw new Error(`no ${f.channel} ${f.market} market in ${workspace} — run prepare-test-database first`)
  }
  const connections: Record<string, string> = {}
  for (const channel of ['EBAY', 'AMAZON', 'ETSY']) {
    let id = (await client.query(`SELECT id FROM "ChannelConnection" WHERE "channelType" = $1 AND "isActive" AND "workspaceId" = $2
      ORDER BY "isPrimary" DESC, id LIMIT 1`, [channel, workspace])).rows[0]?.id as string | undefined
    if (!id) {
      id = `e2e_sheet_${channel.toLowerCase()}_connection`
      await client.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "isActive", "isPrimary", "displayName", "updatedAt")
        VALUES ($1, $2, $3, true, true, $4, now()) ON CONFLICT (id) DO NOTHING`, [id, workspace, channel, `E2E sheet ${channel} (no credentials)`])
    }
    connections[channel] = id
  }

  // ── cached schemas under made-up codes ─────────────────────────────────────────────────────────────────
  await client.query(`DELETE FROM "CategorySchema" WHERE "schemaVersion" = $1 AND "workspaceId" = $2`, [SCHEMA_VERSION, workspace])
  const schema = (channel: string, marketplace: string, productType: string, definition: unknown, twin: number) => client.query(
    `INSERT INTO "CategorySchema" (id, "workspaceId", channel, marketplace, "productType", "schemaVersion", "schemaDefinition", "fetchedAt", "expiresAt", "isActive")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now() + interval '30 days', true)`,
    [`e2e_sheet_schema_${channel.toLowerCase()}_${twin}`, workspace, channel, marketplace, productType, SCHEMA_VERSION, JSON.stringify(definition)])
  const definitions = {
    EBAY: { aspects: EBAY_ASPECTS, conditions: EBAY_CONDITIONS },
    AMAZON: amazonDefinition,
    ETSY: { count: ETSY_PROPERTIES.length, results: ETSY_PROPERTIES },
  }
  const categories: Record<string, { sweep: boolean; choices?: Array<{ id: string; name: string }>; reason?: string }> = {}
  for (const [channel, c] of Object.entries(CATEGORIES)) {
    for (const [i, id] of c.ids.entries()) await schema(channel, c.schemaMarket, id, definitions[channel as keyof typeof definitions], i)
    // The category search reads the business's active taxonomy revision. Seed one only where there is none.
    await client.query(`DELETE FROM "MarketplaceTaxonomy" WHERE id = $1`, [`e2e_sheet_taxonomy_${channel.toLowerCase()}`])
    const own = await client.query(`SELECT 1 FROM "MarketplaceTaxonomy" WHERE channel = $1 AND marketplace = $2 AND "workspaceId" = $3`, [channel, c.market, workspace])
    if (own.rowCount) { categories[channel] = { sweep: false, reason: `the business has its own ${channel} ${c.market} taxonomy, and this seed never writes into a real one` }; continue }
    const source = `e2e_sheet_taxonomy_${channel.toLowerCase()}`
    const snapshot = `${source}_snapshot`
    await client.query(`INSERT INTO "MarketplaceTaxonomy" (id, "workspaceId", channel, marketplace, "nextSyncAt", "updatedAt") VALUES ($1, $2, $3, $4, now() + interval '30 days', now())`, [source, workspace, channel, c.market])
    await client.query(`INSERT INTO "MarketplaceTaxonomySnapshot" (id, "workspaceId", "sourceId", status, "nodeCount", "completedAt") VALUES ($1, $2, $3, 'active', $4, now())`, [snapshot, workspace, source, c.ids.length])
    for (const [i, id] of c.ids.entries()) {
      await client.query(`INSERT INTO "MarketplaceTaxonomyNode" (id, "workspaceId", "snapshotId", "externalId", name, path, assignable) VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [`${source}_node_${i}`, workspace, snapshot, id, c.names[i], `E2E › ${c.names[i]}`])
    }
    await client.query(`UPDATE "MarketplaceTaxonomy" SET "activeSnapshotId" = $1 WHERE id = $2`, [snapshot, source])
    categories[channel] = { sweep: true, choices: c.ids.map((id, i) => ({ id, name: c.names[i] })) }
  }
  seeded.categories = categories

  for (const theme of THEMES) {
    await client.query(`INSERT INTO "EbayDescriptionTheme" (id, "workspaceId", name, html, "updatedAt") VALUES ($1, $2, $3, '<div>{{description}}</div>', now())
      ON CONFLICT (id) DO NOTHING`, [theme.id, workspace, theme.name])
  }

  // ── the families: listings, then variations, then parents (only these ids) ──────────────────────────────
  for (const f of FAMILIES) {
    await client.query(`DELETE FROM "ChannelListing" WHERE "productId" = $1 OR "productId" LIKE $2`, [f.id, `${f.id}\\_%`])
    await client.query(`DELETE FROM "Product" WHERE "parentId" = $1`, [f.id])
    await client.query(`DELETE FROM "Product" WHERE id = $1`, [f.id])
    const productType = 'productType' in f ? f.productType : null
    await client.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "isParent", "productType", "updatedAt")
      VALUES ($1, $2, $3, $4, 10, true, $5, now())`, [f.id, workspace, f.sku, `E2E sheet ${f.label} ${nonce}`, productType])
    const ids = Array.from({ length: rows }, (_, i) => `${f.id}_${String(i + 1).padStart(3, '0')}`)
    await client.query(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "productType", "updatedAt")
      SELECT id, $2, $4 || '-' || right(id, 3), $5 || ' ' || right(id, 3), 10, $3, $6, now() FROM unnest($1::text[]) AS id`,
    [ids, workspace, f.id, f.sku, `E2E sheet ${f.label} variation`, productType])
    if ('channel' in f) {
      await client.query(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, "channelMarket", marketplace, region, "channelConnectionId",
          "listingStatus", "isPublished", "platformAttributes", "updatedAt")
        SELECT 'l_' || id, $2, id, $3, $4, $5, $6, $7, 'DRAFT', false, $8::jsonb, now() FROM unnest($1::text[]) AS id`,
      [[f.id, ...ids], workspace, f.channel, f.channelMarket, f.market, f.region, connections[f.channel], JSON.stringify(f.attributes)])
    }
    seeded[f.scope] = {
      family: f.id, sku: f.sku, name: `E2E sheet ${f.label} ${nonce}`, variations: ids.length,
      ...('channel' in f ? { channel: f.channel, market: f.market, connection: connections[f.channel] } : {}),
    }
  }
  await client.query('COMMIT')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  console.error(`✗ sheet seed failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  await client.end()
}

const { categories, ...families } = seeded
writeFileSync(out, JSON.stringify({ workspace, nonce, families, categories, schemas: { EBAY: EBAY_CATEGORY, AMAZON: AMAZON_TYPE, ETSY: ETSY_TAXONOMY }, themes: THEMES }, null, 2))
chmodSync(out, 0o600)
console.log(`✓ sheet seed: ${FAMILIES.length} families × ${rows} variations in ${workspace} (nonce ${nonce}); schemas EBAY ${EBAY_CATEGORY}, AMAZON ${AMAZON_TYPE}, ETSY ${ETSY_TAXONOMY}`)
