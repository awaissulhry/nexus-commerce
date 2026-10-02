/**
 * MCP full control I2 — the identity audit, run against a real PostgreSQL with the production schema and the
 * business-isolation policies (PGlite). No mocked query.
 *
 * Business A carries, for every check, at least one row it must find (a positive) next to near misses it must leave
 * alone (controls): a parent and its variation sharing one Item ID, a UPC that is the same code as a GTIN, a brand that
 * differs only in case, a claim that has its listing, … Each check is asserted to find EXACTLY its positives. Business
 * CLEAN holds a consistent catalogue — including an Item ID that two families of A share — and every check finds
 * nothing there. The tools are run through the one door (call-tool.ts); identity-issues is walked page by page.
 *
 * The extra-listing SKU check needs ProductListingAlias.sku, which is not in this schema yet: it is skipped with its
 * reason, then the column is added here and the check finds its positive and leaves its control.
 *
 * Run with business profiles OFF and again with NEXUS_WORKSPACES_ENABLED=1: every call is bound to a business.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { callTool, ToolAccessError, type UserPrincipal } from '../agents/call-tool.js'
import { validateGtin } from '../listing-preflight.service.js'
import { IDENTITY_CHECKS, identityCheck } from './identity-checks.js'
import { auditIdentity, runCheck, type IdentityFinding } from './identity-audit.service.js'

const A = LEGACY_WORKSPACE_ID
const CLEAN = 'ws_identity_clean'
const OTHER = 'ws_identity_other'
const CODES = 'ws_identity_codes'

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function principal(workspaceId: string, permissions: string[]): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-identity',
    label: 'Identity test',
    permissions: { isOwner: false, permissions: new Set(permissions) },
    workspace: business(workspaceId),
    via: 'claude',
  }
}
const everything = (workspaceId = A) => principal(workspaceId, [...Object.values(FEATURES), ...Object.values(FIELDS)])

type Json = Record<string, any>
async function call(tool: string, args: Record<string, unknown>, who: UserPrincipal = everything()): Promise<Json> {
  return (await callTool(who, tool, args)).visible as Json
}

/** A barcode with its mod-10 check digit (GTIN-8/12/13/14 from 7/11/12/13 digits). */
function withCheckDigit(base: string): string {
  let sum = 0
  for (let i = base.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(base[i]) * w
  return base + ((10 - (sum % 10)) % 10)
}
const wrongCheckDigit = (code: string) => code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10)
const G = Array.from({ length: 16 }, (_, i) => withCheckDigit(`4006381${String(10000 + i * 37).padStart(5, '0')}`))

// ── The seed ──────────────────────────────────────────────────────────────────────────────────────────

const ids: Record<string, string> = {}
const conn: Record<string, string> = {}

async function product(sku: string, extra: Json = {}) {
  const row = await database.client.product.create({ data: { sku, name: `${sku} jacket`, basePrice: '10.00', ...extra } })
  ids[sku] = row.id
  return row
}

const ACCOUNT_OF: Record<string, string> = { EBAY: 'ebay', AMAZON: 'amazon', SHOPIFY: 'shopify', ETSY: 'etsy' }

async function listing(sku: string, channel: string, market: string, external: string | null, extra: Json = {}) {
  return database.client.channelListing.create({
    data: {
      productId: ids[sku],
      channel,
      marketplace: market,
      region: market,
      channelMarket: `${channel}_${market}`,
      listingStatus: 'ACTIVE',
      externalListingId: external,
      channelConnectionId: conn[ACCOUNT_OF[channel]],
      ...extra,
    },
  })
}

async function alias(sku: string, market: string, label: string, extra: Json = {}) {
  return database.client.productListingAlias.create({
    data: { productId: ids[sku], channel: 'EBAY', marketplace: market, channelConnectionId: conn.ebay, label, position: 2, ...extra },
  })
}

async function seedA() {
  await inside(A, async () => {
    const db = database.client
    const account = async (key: string, channelType: string, externalAccountId: string | null) => {
      conn[key] = (await db.channelConnection.create({ data: { channelType, accountLabel: `${key} account`, isActive: true, externalAccountId } })).id
    }
    await account('ebay', 'EBAY', 'TEST-EBAY-SELLER-A')
    await account('ebayOld', 'EBAY', null)
    await account('amazon', 'AMAZON', 'TEST-AMAZON-A')
    await account('amazon2', 'AMAZON', 'TEST-AMAZON-A2')
    await account('shopify', 'SHOPIFY', 'test-shop-a')

    // #1 — one Item ID on two families; one Item ID on two listings of one family; one Shopify product (gid and short).
    await product('ID1-ROOT', { isParent: true })
    await product('ID1-C1', { parentId: ids['ID1-ROOT'] })
    await product('ID1-OTHER')
    await product('ID1-ALIASED')
    await product('ID1-OK', { isParent: true })
    await product('ID1-OKC', { parentId: ids['ID1-OK'] })
    await product('ID1-SHOP1')
    await product('ID1-SHOP2')
    await listing('ID1-ROOT', 'EBAY', 'IT', '110000000001')
    await listing('ID1-C1', 'EBAY', 'IT', '110000000001')
    await listing('ID1-OTHER', 'EBAY', 'IT', '110000000001')
    await listing('ID1-ALIASED', 'EBAY', 'IT', '110000000002')
    const second = await alias('ID1-ALIASED', 'IT', 'second listing')
    await listing('ID1-ALIASED', 'EBAY', 'IT', '110000000002', { aliasId: second.id, aliasKey: second.id })
    await listing('ID1-OK', 'EBAY', 'IT', '110000000003')
    await listing('ID1-OKC', 'EBAY', 'IT', '110000000003')
    await listing('ID1-SHOP1', 'SHOPIFY', 'GLOBAL', 'gid://shopify/Product/500', { platformAttributes: { shopifyProductId: '500' } })
    await listing('ID1-SHOP2', 'SHOPIFY', 'GLOBAL', '500')

    // #5 — live without an id; controls: a draft, a Shopify id kept in platformAttributes, not published.
    for (const sku of ['ID5-LIVE', 'ID5-DRAFT', 'ID5-SHOP', 'ID5-NOTPUB']) await product(sku)
    await listing('ID5-LIVE', 'EBAY', 'IT', null)
    await listing('ID5-DRAFT', 'EBAY', 'IT', null, { listingStatus: 'DRAFT' })
    await listing('ID5-SHOP', 'SHOPIFY', 'GLOBAL', null, { platformAttributes: { shopifyProductId: '600' } })
    await listing('ID5-NOTPUB', 'EBAY', 'IT', null, { isPublished: false })

    // #6 — the listing names an ended Item ID, the shared variations the live one; controls: they agree; an ended row.
    for (const sku of ['ID6-ROOT', 'ID6-OK', 'ID6-ENDED']) await product(sku)
    await listing('ID6-ROOT', 'EBAY', 'IT', '220000000001')
    await listing('ID6-OK', 'EBAY', 'IT', '220000000003')
    await listing('ID6-ENDED', 'EBAY', 'IT', '220000000004')
    const membership = (parentSku: string, sku: string, itemId: string, status = 'ACTIVE') =>
      db.sharedListingMembership.create({ data: { marketplace: 'IT', sku, itemId, parentSku, variationSpecifics: {}, status, channelConnectionId: conn.ebay } })
    await membership('ID6-ROOT', 'ID6-V1', '220000000002')
    await membership('ID6-ROOT', 'ID6-V2', '220000000002')
    await membership('ID6-OK', 'ID6-OKV1', '220000000003')
    await membership('ID6-ENDED', 'ID6-ENDV1', '220000000005', 'ENDED')

    // #7 — old columns: an ASIN and an Item ID no listing carries; controls: equal; no listing to compare with.
    await product('ID7-ASIN', { amazonAsin: 'B0LEGACY01' })
    await product('ID7-ITEM', { ebayItemId: '330000000009' })
    await product('ID7-OK', { amazonAsin: 'B0SAME0001' })
    await product('ID7-NOLIST', { amazonAsin: 'B0ALONE001' })
    await listing('ID7-ASIN', 'AMAZON', 'DE', 'B0NEW00001')
    await listing('ID7-ITEM', 'EBAY', 'IT', '330000000001')
    await listing('ID7-OK', 'AMAZON', 'DE', 'B0SAME0001')

    // #8 — a variation on another Item ID / parent ASIN than its parent; controls: the same ones.
    await product('ID8-ROOT', { isParent: true })
    await product('ID8-C1', { parentId: ids['ID8-ROOT'] })
    await product('ID8-C2', { parentId: ids['ID8-ROOT'] })
    await product('ID8-AR', { isParent: true })
    await product('ID8-AC', { parentId: ids['ID8-AR'] })
    await product('ID8-AC2', { parentId: ids['ID8-AR'] })
    await listing('ID8-ROOT', 'EBAY', 'IT', '440000000001')
    await listing('ID8-C1', 'EBAY', 'IT', '440000000009')
    await listing('ID8-C2', 'EBAY', 'IT', '440000000001')
    await listing('ID8-AR', 'AMAZON', 'DE', 'B0PARENT01')
    await listing('ID8-AC', 'AMAZON', 'DE', 'B0CHILD001', { externalParentId: 'B0OTHER001' })
    await listing('ID8-AC2', 'AMAZON', 'DE', 'B0CHILD002', { externalParentId: 'B0PARENT01' })

    // #9 — broken families.
    await product('ID9-DEADP', { isParent: true })
    await product('ID9-ORPH', { parentId: ids['ID9-DEADP'] })
    await db.product.update({ where: { id: ids['ID9-DEADP'] }, data: { deletedAt: new Date() } })
    await product('ID9-TOP', { isParent: true })
    await product('ID9-MID', { isParent: true, parentId: ids['ID9-TOP'] })
    await product('ID9-LEAF', { parentId: ids['ID9-MID'] })
    await product('ID9-SELF')
    await db.product.update({ where: { id: ids['ID9-SELF'] }, data: { parentId: ids['ID9-SELF'] } })
    await product('ID9-NP')
    await product('ID9-NPC', { parentId: ids['ID9-NP'] })
    await product('ID9-AR', { isParent: true })
    await product('ID9-AC', { parentId: ids['ID9-AR'] })
    await alias('ID9-AC', 'IT', 'on a variation')

    // #10 — a shell nobody adopted (control: one adopted); SKUs equal but for case.
    await product('ID10-SHELL', { productType: 'EBAY_LISTING_SHELL' })
    await listing('ID10-SHELL', 'EBAY', 'IT', '550000000001')
    await product('ID10-REAL')
    await product('ID10-ADOPTED', { productType: 'EBAY_LISTING_SHELL' })
    const adopted = await alias('ID10-REAL', 'IT', 'adopted shell', { adoptedFromProductId: ids['ID10-ADOPTED'] })
    await listing('ID10-REAL', 'EBAY', 'IT', '550000000002', { aliasId: adopted.id, aliasKey: adopted.id })
    await product('ID10-Dup')
    await product('id10-dup')

    // #11 — an offer SKU that is another listing's seller SKU on the same account and market (controls: its own SKU;
    // the same SKU on another account); a SKU alias that is another product's SKU (control: no such product);
    // extra listings for the alias-SKU check (their SKUs are written once the column exists).
    for (const sku of ['ID11-OA', 'ID11-OB', 'ID11-OC', 'ID11-OD', 'ID11-SA', 'ID11-OTHER', 'ID11-ALIASROOT', 'ID11-TAKEN']) await product(sku)
    const oa = await listing('ID11-OA', 'AMAZON', 'DE', 'B0OA000001')
    await listing('ID11-OB', 'AMAZON', 'DE', 'B0OB000001')
    const oc = await listing('ID11-OC', 'AMAZON', 'DE', 'B0OC000001')
    const od = await listing('ID11-OD', 'AMAZON', 'DE', 'B0OD000001', { channelConnectionId: conn.amazon2 })
    await db.offer.create({ data: { channelListingId: oa.id, fulfillmentMethod: 'FBA', sku: 'ID11-OB' } })
    await db.offer.create({ data: { channelListingId: oc.id, fulfillmentMethod: 'FBA', sku: 'ID11-OC-FBA' } })
    await db.offer.create({ data: { channelListingId: od.id, fulfillmentMethod: 'FBA', sku: 'ID11-OB' } })
    await db.skuAlias.create({ data: { productId: ids['ID11-SA'], alias: 'id11-other', raw: 'ID11-OTHER' } })
    await db.skuAlias.create({ data: { productId: ids['ID11-SA'], alias: 'id11-nobody', raw: 'ID11-NOBODY' } })
    const taken = await alias('ID11-ALIASROOT', 'DE', 'listing named like a product')
    await listing('ID11-ALIASROOT', 'EBAY', 'DE', '770000000001', { aliasId: taken.id, aliasKey: taken.id })
    const own = await alias('ID11-ALIASROOT', 'FR', 'listing with its own SKU')
    await listing('ID11-ALIASROOT', 'EBAY', 'FR', '770000000002', { aliasId: own.id, aliasKey: own.id })
    aliasIds.taken = taken.id
    aliasIds.own = own.id

    // #13 — one Shopify variant on two products (gid and short); a variation on another product than its parent's,
    // than its colour product's, and a listing whose two Shopify product ids disagree; controls beside each.
    for (const sku of ['ID13-V1', 'ID13-V2', 'ID13-V3', 'ID13-OWN']) await product(sku)
    await listing('ID13-V1', 'SHOPIFY', 'GLOBAL', '700', { platformAttributes: { shopifyProductId: '700', variantId: '7001' } })
    await listing('ID13-V2', 'SHOPIFY', 'GLOBAL', '701', { platformAttributes: { shopifyProductId: '701', variantId: 'gid://shopify/ProductVariant/7001' } })
    await listing('ID13-V3', 'SHOPIFY', 'GLOBAL', '702', { platformAttributes: { shopifyProductId: '702', variantId: '7002' } })
    await listing('ID13-OWN', 'SHOPIFY', 'GLOBAL', '900', { platformAttributes: { shopifyProductId: '901' } })
    await product('ID13-ROOT', { isParent: true })
    for (const sku of ['ID13-C1', 'ID13-C2', 'ID13-COL', 'ID13-COLOK']) await product(sku, { parentId: ids['ID13-ROOT'] })
    const colour = (valueKey: string, shopifyProductId: string) => db.shopifyColourProduct.create({
      data: { familyId: ids['ID13-ROOT'], channelConnectionId: conn.shopify, splitAxis: 'Color', valueKey, shopifyProductId, state: 'LINKED' },
    })
    const red = await colour('red', 'gid://shopify/Product/950')
    const blue = await colour('blue', 'gid://shopify/Product/960')
    await listing('ID13-ROOT', 'SHOPIFY', 'GLOBAL', '800')
    await listing('ID13-C1', 'SHOPIFY', 'GLOBAL', '801')
    await listing('ID13-C2', 'SHOPIFY', 'GLOBAL', '800')
    await listing('ID13-COL', 'SHOPIFY', 'GLOBAL', '951', { platformAttributes: { shopifyColourProductId: red.id, shopifyProductId: '951' } })
    await listing('ID13-COLOK', 'SHOPIFY', 'GLOBAL', '960', { platformAttributes: { shopifyColourProductId: blue.id, shopifyProductId: '960' } })

    // #14 / #15 — products whose listings sit on another business's accounts (written below as the database owner).
    for (const sku of ['ID14-NOCLAIM', 'ID14-CLAIMED', 'ID15-REVOKED', 'ID15-READ']) await product(sku)

    // #16 — a listing with no account.
    await product('ID16-NOACC')
    await listing('ID16-NOACC', 'EBAY', 'IT', '990000000001', { channelConnectionId: null })

    // #17 / #18 — barcodes.
    await product('ID17-BAD', { gtin: wrongCheckDigit(G[0]) })
    await product('ID17-LEN', { ean: '12345' })
    await product('ID17-ALPHA', { upc: 'ABC123456789' })
    await product('ID17-OK', { gtin: `${G[1].slice(0, 7)}-${G[1].slice(7)}` })
    await product('ID17-DIS', { gtin: G[2], ean: G[3] })
    const upc = withCheckDigit('01234567890')
    await product('ID17-SAME', { gtin: `0${upc}`, upc })
    await product('ID17-LG', { gtin: G[4] })
    await product('ID17-LGOK', { gtin: G[5] })
    await product('ID17-LGNA', { gtin: G[6] })
    await listing('ID17-LG', 'EBAY', 'IT', '120000000001', { platformAttributes: { itemSpecifics: { EAN: G[7] } } })
    await listing('ID17-LGOK', 'EBAY', 'IT', '120000000002', { platformAttributes: { gtin: G[5] } })
    await listing('ID17-LGNA', 'EBAY', 'IT', '120000000003', { platformAttributes: { itemSpecifics: { EAN: 'Does not apply' } } })
    await product('ID17-PAR', { isParent: true, gtin: G[8] })
    await product('ID17-PARC', { parentId: ids['ID17-PAR'], gtin: G[9] })
    await product('ID17-NEW')
    await product('ID17-NEWEX')
    await product('ID17-NEWG', { gtin: G[10] })
    await listing('ID17-NEW', 'AMAZON', 'DE', null, { listingStatus: 'DRAFT' })
    await listing('ID17-NEWEX', 'AMAZON', 'DE', null, { listingStatus: 'DRAFT', platformAttributes: { supplier_declared_has_product_identifier_exemption: true } })
    await listing('ID17-NEWG', 'AMAZON', 'DE', null, { listingStatus: 'DRAFT' })
    await product('ID18-A', { ean: G[11] })
    await product('ID18-B', { gtin: G[11] })

    // #19 — one brand three ways; a listing brand that differs (eBay item specific, Amazon's older nested shape).
    await product('ID19-A', { brand: 'Acme Moto' })
    await product('ID19-B', { brand: 'ACME MOTO' })
    await product('ID19-C', { brand: 'acme-moto' })
    for (const sku of ['ID19-LB', 'ID19-LBOK', 'ID19-AMZ', 'ID19-AMZOK']) await product(sku, { brand: 'Acme Moto' })
    await listing('ID19-LB', 'EBAY', 'IT', '130000000001', { platformAttributes: { itemSpecifics: { Marca: 'Other Brand' } } })
    await listing('ID19-LBOK', 'EBAY', 'IT', '130000000002', { platformAttributes: { itemSpecifics: { Marca: ['ACME moto'] } } })
    await listing('ID19-AMZ', 'AMAZON', 'DE', 'B0BRAND001', { platformAttributes: { attributes: { brand: [{ value: 'Different Co' }] } } })
    await listing('ID19-AMZOK', 'AMAZON', 'DE', 'B0BRAND002', { platformAttributes: { brand: 'Acme Moto' } })

    // #20 — orphans: a deleted product's listing; an extra listing with no rows; an index row naming a deleted product.
    await product('ID20-DEL')
    await listing('ID20-DEL', 'EBAY', 'IT', '140000000001')
    await db.product.update({ where: { id: ids['ID20-DEL'] }, data: { deletedAt: new Date() } })
    await product('ID20-AL')
    await alias('ID20-AL', 'IT', 'never listed')
    await db.ebayListingIndex.create({ data: { marketplace: 'IT', itemId: '660000000001', productIds: [ids['ID20-DEL']] } })
    await db.ebayListingIndex.create({ data: { marketplace: 'IT', itemId: '660000000002', productIds: [ids['ID1-OTHER']] } })
    await db.ebayListingIndex.create({ data: { marketplace: 'IT', itemId: '660000000003', productIds: [ids['ID20-DEL']], endedAt: new Date() } })
  })
}

const aliasIds: Record<string, string> = {}

/** Another business's eBay accounts, shared with A (publish), shared read-only, and no longer shared; A's listings on them. */
async function seedShared() {
  const shared = randomUUID()
  const readOnly = randomUUID()
  const revoked = randomUUID()
  const listingRow = (sku: string, account: string, status: string, external: string) => ({ id: randomUUID(), sku, account, status, external })
  const rows = [
    listingRow('ID14-NOCLAIM', shared, 'ACTIVE', '880000000001'),
    listingRow('ID14-CLAIMED', shared, 'ACTIVE', '880000000002'),
    listingRow('ID15-REVOKED', revoked, 'DRAFT', '880000000003'),
    listingRow('ID15-READ', readOnly, 'DRAFT', '880000000004'),
  ]
  await database.db.transaction(async (tx) => {
    await tx.query(`SET LOCAL session_replication_role = replica`)
    for (const [id, external] of [[shared, 'TEST-EBAY-SHARED'], [readOnly, 'TEST-EBAY-READ'], [revoked, 'TEST-EBAY-REVOKED']]) {
      await tx.query(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "externalAccountId", "isActive", "updatedAt") VALUES ($1, $2, 'EBAY', $3, true, CURRENT_TIMESTAMP)`, [id, OTHER, external])
    }
    const grant = (account: string, mode: string, revokedAt: string | null) => tx.query(
      `INSERT INTO "ChannelAccountGrant" ("connectionId", "workspaceId", "ownerWorkspaceId", mode, "grantedByUserId", "revokedAt") VALUES ($1, $2, $3, $4, 'u-other', $5)`,
      [account, A, OTHER, mode, revokedAt],
    )
    await grant(shared, 'publish', null)
    await grant(readOnly, 'read', null)
    await grant(revoked, 'publish', new Date().toISOString())
    for (const row of rows) {
      await tx.query(
        `INSERT INTO "ChannelListing" (id, "workspaceId", "productId", "channelMarket", channel, region, marketplace, "listingStatus", "externalListingId", "channelConnectionId", "updatedAt")
         VALUES ($1, $2, $3, 'EBAY_IT', 'EBAY', 'IT', 'IT', $4, $5, $6, CURRENT_TIMESTAMP)`,
        [row.id, A, ids[row.sku], row.status, row.external, row.account],
      )
    }
    const claim = (sellerSku: string, listingId: string | null) => tx.query(
      `INSERT INTO "ChannelListingClaim" ("connectionId", marketplace, "sellerSku", "workspaceId", "channelListingId") VALUES ($1, 'IT', $2, $3, $4)`,
      [shared, sellerSku, A, listingId],
    )
    await claim('ID14-CLAIMED', rows[1].id)
    await claim('ID14-GONE', null)
  })
}

/** A consistent catalogue, holding an Item ID that two families of A share: nothing here is a finding. */
async function seedClean() {
  await inside(CLEAN, async () => {
    const db = database.client
    const ebay = await db.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'TEST-EBAY-CLEAN' } })
    const amazon = await db.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'TEST-AMAZON-CLEAN' } })
    const make = (sku: string, extra: Json = {}) => db.product.create({ data: { sku, name: sku, basePrice: '10.00', ...extra } })
    const root = await make('CLEAN-ROOT', { isParent: true, brand: 'Clean Brand' })
    const child = await make('CLEAN-CHILD', { parentId: root.id, gtin: G[12], brand: 'Clean Brand' })
    const single = await make('CLEAN-SINGLE', { gtin: G[13], brand: 'Clean Brand' })
    const list = (productId: string, channel: string, market: string, external: string, extra: Json = {}) => db.channelListing.create({
      data: {
        productId, channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, listingStatus: 'ACTIVE',
        externalListingId: external, channelConnectionId: channel === 'EBAY' ? ebay.id : amazon.id, ...extra,
      },
    })
    await list(root.id, 'EBAY', 'IT', '110000000001', { platformAttributes: { itemSpecifics: { Marca: 'Clean Brand' } } })
    await list(child.id, 'EBAY', 'IT', '110000000001', { platformAttributes: { itemSpecifics: { EAN: G[12] } } })
    await list(root.id, 'AMAZON', 'DE', 'B0CLEANP01')
    await list(child.id, 'AMAZON', 'DE', 'B0CLEANC01', { externalParentId: 'B0CLEANP01' })
    await list(single.id, 'AMAZON', 'DE', 'B0CLEANS01', { platformAttributes: { brand: 'Clean Brand' } })
  })
}

/** Barcodes of every length and fault, one product each, to hold the SQL check digit to validateGtin. */
const CODE_SAMPLES = [
  withCheckDigit('9638507'), wrongCheckDigit(withCheckDigit('9638507')),
  withCheckDigit('03600029145'), wrongCheckDigit(withCheckDigit('03600029145')),
  G[14], wrongCheckDigit(G[14]),
  withCheckDigit('1400638133393'), wrongCheckDigit(withCheckDigit('1400638133393')),
  ` ${G[15]} `, `${G[15].slice(0, 4)} ${G[15].slice(4)}`, `${G[15].slice(0, 4)}-${G[15].slice(4)}`,
  '123456789', '1234567890', '12345678901', '400638133393x', '0000000000000',
]

async function seedCodes() {
  await inside(CODES, async () => {
    for (const [i, code] of CODE_SAMPLES.entries()) {
      await database.client.product.create({ data: { sku: `CODE-${String(i).padStart(2, '0')}`, name: 'code', basePrice: '1.00', gtin: code } })
    }
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  for (const [id, name] of [[CLEAN, 'Clean business'], [OTHER, 'Other business'], [CODES, 'Barcode business']]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $2, 'active', 'identity', $1, CURRENT_TIMESTAMP)`, [id, name])
  }
  await seedA()
  await seedShared()
  await seedClean()
  await seedCodes()
  // Integration (ids × eBay import by SKU): this schema already has ProductListingAlias.sku (20261001c). The tests below
  // start from the state before that migration and add the column themselves, so drop it once the seed is in.
  await database.db.query(`ALTER TABLE "ProductListingAlias" DROP COLUMN IF EXISTS "sku"`)
}, 180_000)

afterAll(async () => {
  await database?.close()
}, 30_000)

// ── Each check ────────────────────────────────────────────────────────────────────────────────────────

async function everyFinding(kind: string, workspaceId = A): Promise<IdentityFinding[]> {
  return inside(workspaceId, async () => (await runCheck(identityCheck(kind)!, { limit: 1000 })).findings)
}

const sku = (f: IdentityFinding) => f.sku
/** What each check must find in A, exactly: a label per finding. */
const EXPECTED: Record<string, { label: (f: IdentityFinding) => unknown; found: unknown[] }> = {
  'channel-id-on-two-families': { label: (f) => f.key, found: ['EBAY IT 110000000001', 'EBAY IT 110000000002', 'SHOPIFY GLOBAL 500'] },
  // I5 — CLEAN holds 110000000001 too. No person asks here (a system caller), so CLEAN is not named.
  'channel-id-in-another-business': { label: (f) => `${f.key} ${f.sku} ${f.details?.heldBy}`, found: ['EBAY 110000000001 ID1-C1 another business'] },
  'live-listing-without-channel-id': { label: sku, found: ['ID5-LIVE'] },
  'ebay-item-id-differs-from-shared-listing': { label: (f) => `${f.sku} ${f.details?.sharedItemId} ${f.details?.listingItemIds}`, found: ['ID6-ROOT 220000000002 220000000001'] },
  'legacy-channel-id-differs': { label: (f) => `${f.sku} ${f.details?.column}`, found: ['ID7-ASIN amazonAsin', 'ID7-ITEM ebayItemId'] },
  'child-listing-points-elsewhere': { label: (f) => `${f.sku} ${f.details?.variationValue}≠${f.details?.parentValue}`, found: ['ID8-AC B0OTHER001≠B0PARENT01', 'ID8-C1 440000000009≠440000000001'] },
  'parent-deleted': { label: sku, found: ['ID9-ORPH'] },
  'parent-is-a-variation': { label: sku, found: ['ID9-LEAF', 'ID9-SELF'] },
  'children-under-non-parent': { label: sku, found: ['ID9-NP'] },
  'listing-alias-on-a-variation': { label: sku, found: ['ID9-AC'] },
  'unadopted-ebay-shell': { label: sku, found: ['ID10-SHELL'] },
  'sku-differs-only-in-case': { label: (f) => [...(f.details?.skus as string[])].sort(), found: [['ID10-Dup', 'id10-dup'].sort()] },
  'offer-sku-equals-other-listing-sku': { label: (f) => `${f.sku} ${f.details?.offerSku} ${f.details?.otherProductSku}`, found: ['ID11-OA ID11-OB ID11-OB'] },
  'name-alias-equals-other-product-sku': { label: (f) => `${f.sku} ${f.details?.otherProductSku}`, found: ['ID11-SA ID11-OTHER'] },
  'shopify-variant-on-two-products': { label: (f) => f.details?.skus, found: [['ID13-V1', 'ID13-V2']] },
  'shopify-variant-of-other-product': { label: (f) => `${f.sku} ${f.details?.against}`, found: ['ID13-C1 parent listing', 'ID13-COL colour product', 'ID13-OWN own ids'] },
  'shared-account-listing-without-claim': { label: sku, found: ['ID14-NOCLAIM'] },
  'claim-without-listing': { label: sku, found: ['ID14-GONE'] },
  'listing-on-account-not-usable': { label: (f) => `${f.sku} ${f.details?.access}`, found: ['ID15-READ read only', 'ID15-REVOKED revoked'] },
  'listing-without-account': { label: sku, found: ['ID16-NOACC'] },
  'gtin-invalid': { label: (f) => `${f.sku} ${f.details?.field} ${f.details?.reason}`, found: ['ID17-ALPHA upc not numeric', 'ID17-BAD gtin check digit mismatch', 'ID17-LEN ean length 5 (must be 8, 12, 13 or 14 digits)'] },
  'gtin-ean-upc-disagree': { label: sku, found: ['ID17-DIS'] },
  'listing-gtin-differs': { label: (f) => `${f.sku} ${f.details?.listingCode}`, found: [`ID17-LG ${G[7]}`] },
  'parent-carries-gtin': { label: sku, found: ['ID17-PAR'] },
  'gtin-missing-for-new-amazon-listing': { label: sku, found: ['ID17-NEW'] },
  'gtin-on-two-products': { label: (f) => f.details?.skus, found: [['ID18-A', 'ID18-B']] },
  'brand-spelled-several-ways': { label: (f) => f.key, found: ['b acmemoto'] },
  'listing-brand-differs': { label: (f) => `${f.sku} ${f.details?.listingBrand}`, found: ['ID19-AMZ Different Co', 'ID19-LB Other Brand'] },
  'listing-on-deleted-product': { label: sku, found: ['ID20-DEL'] },
  'listing-alias-without-listings': { label: sku, found: ['ID20-AL', 'ID9-AC'] },
  'ebay-index-names-gone-product': { label: (f) => f.details?.itemId, found: ['660000000001'] },
  'ebay-account-without-identity': { label: (f) => f.details?.accountId, found: ['ebayOld'] },
}

const comparable = (values: unknown[]) => values.map((v) => JSON.stringify(v)).sort()
/** I6 — the checks that read what each account holds (ChannelHeldId): nothing was swept here, so they are clean;
 * their positives and controls are in channel-held.vitest.test.ts. */
const SWEEP_KINDS = ['channel-id-not-held-by-account', 'channel-id-not-in-nexus', 'channel-sku-differs']

describe('I2 — every check finds exactly its positives in A and leaves the controls alone', () => {
  it('every registered check is covered here (the alias-SKU check below, once its column exists)', () => {
    expect(IDENTITY_CHECKS.map((c) => c.kind).filter((kind) => !EXPECTED[kind]).sort()).toEqual(['listing-sku-equals-product-sku', ...SWEEP_KINDS].sort())
  })

  it.each(Object.keys(EXPECTED))('%s', async (kind) => {
    const findings = await everyFinding(kind)
    const { label, found } = EXPECTED[kind]
    const want = kind === 'ebay-account-without-identity' ? [conn.ebayOld] : found
    expect(comparable(findings.map(label))).toEqual(comparable(want))
    // Each finding names its check and severity, and has its own key.
    expect(new Set(findings.map((f) => f.key)).size).toBe(findings.length)
    for (const finding of findings) expect(finding).toMatchObject({ check: kind, severity: identityCheck(kind)!.severity })
  })

  it('the listing-level findings name the listing, its channel and market', async () => {
    const [noAccount] = await everyFinding('listing-without-account')
    expect(noAccount).toMatchObject({ sku: 'ID16-NOACC', productId: ids['ID16-NOACC'], channel: 'EBAY', market: 'IT', details: { externalId: '990000000001' } })
    expect(noAccount.listingId).toEqual(expect.any(String))
  })
})

describe('I2 — a consistent business has no finding, and one business never sees another', () => {
  it('every check runs in CLEAN; its one finding is the Item ID A also holds (#2), and A is not named', async () => {
    const audit = await inside(CLEAN, () => auditIdentity({ examples: 3 }))
    expect(audit.failed).toEqual([])
    expect(audit.findings.map((f) => [f.check, f.count, f.examples.map((e) => [e.sku, e.details?.externalId, e.details?.heldBy])])).toEqual([
      ['channel-id-in-another-business', 1, [['CLEAN-CHILD', '110000000001', ['another business']]]],
    ])
    expect(audit.summary).toEqual({ errors: 1, warnings: 0, info: 0, checksRun: IDENTITY_CHECKS.length - 1 })
    expect(audit.skipped.map((s) => s.check)).toEqual(['listing-sku-equals-product-sku'])
  })

  it("A's findings never name CLEAN's rows (the shared Item ID is A's two families, not CLEAN's)", async () => {
    const [shared] = await everyFinding('channel-id-on-two-families')
    expect(shared.details).toMatchObject({ families: ['ID1-OTHER', 'ID1-ROOT'], familyCount: 2, listingCount: 3 })
    const text = JSON.stringify(await inside(A, () => auditIdentity({ examples: 5 })))
    expect(text).not.toContain('CLEAN-')
  })

  it('the SQL check digit is validateGtin: every sample barcode is flagged exactly when validateGtin refuses it', async () => {
    const flagged = (await everyFinding('gtin-invalid', CODES)).map((f) => f.details?.value)
    const refused = CODE_SAMPLES.filter((code) => !validateGtin(code).valid)
    expect([...flagged].sort()).toEqual([...refused].sort())
    // The samples hold both kinds, of every length.
    expect(refused.length).toBeGreaterThan(5)
    expect(CODE_SAMPLES.length - refused.length).toBeGreaterThan(5)
  })
})

// ── The tools ─────────────────────────────────────────────────────────────────────────────────────────

describe('I2 — identity-audit', () => {
  it('counts every check, shows the first examples, errors first, and says which fix tools exist yet', async () => {
    const out = await call('identity-audit', { examples: 2 })
    expect(out.ok, out.error).toBe(true)
    const data = out.data
    expect(data.failed).toEqual([])
    expect([...data.clean].sort()).toEqual([...SWEEP_KINDS].sort())
    expect(data.skipped).toEqual([{ check: 'listing-sku-equals-product-sku', reason: expect.stringContaining('not available until the listing-SKU column exists') }])
    expect(data.findings.map((f: Json) => f.check).sort()).toEqual(Object.keys(EXPECTED).sort())
    const rank = { error: 0, warning: 1, info: 2 } as Record<string, number>
    const ranks = data.findings.map((f: Json) => rank[f.severity])
    expect(ranks).toEqual([...ranks].sort((x: number, y: number) => x - y))
    for (const line of data.findings as Json[]) {
      expect(line.count).toBe(EXPECTED[line.check].found.length)
      expect(line.examples.length).toBe(Math.min(2, line.count))
      expect(line.explanation).toEqual(expect.any(String))
    }
    const byKind = Object.fromEntries((data.findings as Json[]).map((f) => [f.check, f]))
    // fix.available follows the registry: unlink-channel-id exists (I9); a person's step has no tool.
    expect(byKind['channel-id-on-two-families'].fix).toEqual({ tool: 'unlink-channel-id', available: true, how: expect.any(String) })
    expect(byKind['ebay-account-without-identity'].fix).toEqual({ tool: null, available: false, how: expect.any(String) })
    const errors = (data.findings as Json[]).filter((f) => f.severity === 'error').reduce((n, f) => n + f.count, 0)
    expect(data.summary).toMatchObject({ errors, checksRun: IDENTITY_CHECKS.length - 1 })
  })

  it('filters by check and by severity', async () => {
    const one = await call('identity-audit', { checks: ['GTIN-INVALID'], examples: 5 })
    expect(one.data.findings.map((f: Json) => [f.check, f.count, f.examples.length])).toEqual([['gtin-invalid', 3, 3]])
    const info = await call('identity-audit', { severity: 'info' })
    expect(info.data.findings.every((f: Json) => f.severity === 'info')).toBe(true)
    expect(info.data.findings.length).toBe(IDENTITY_CHECKS.filter((c) => c.severity === 'info' && !SWEEP_KINDS.includes(c.kind)).length)
  })

  it('needs both products.view and listings.view', async () => {
    const productsOnly = principal(A, [FEATURES.aiRun, FEATURES.productsView])
    await expect(callTool(productsOnly, 'identity-audit', {})).rejects.toBeInstanceOf(ToolAccessError)
    await expect(callTool(productsOnly, 'identity-issues', {})).rejects.toBeInstanceOf(ToolAccessError)
  })
})

describe('I2 — identity-issues', () => {
  async function walk(args: Json, limit: number) {
    const items: Json[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const out: Json = await call('identity-issues', { ...args, limit, ...(cursor ? { cursor } : {}) })
      expect(out.ok, out.error).toBe(true)
      expect(out.data.items.length).toBeLessThanOrEqual(limit)
      for (const item of out.data.items as Json[]) expect(out.data.checks[item.check]).toMatchObject({ title: expect.any(String), fix: expect.any(Object) })
      items.push(...out.data.items)
      cursor = out.data.nextCursor
      pages++
    } while (cursor && pages < 100)
    return { items, pages }
  }

  it('walks every finding of every check once, check by check, with no finding twice and none missed', async () => {
    const expected: string[] = []
    for (const check of IDENTITY_CHECKS.filter((c) => EXPECTED[c.kind])) {
      for (const f of await everyFinding(check.kind)) expected.push(`${f.check} ${f.key}`)
    }
    const { items, pages } = await walk({}, 4)
    const got = items.map((item) => `${item.check} ${item.key}`)
    expect(got).toEqual(expected)
    expect(new Set(got).size).toBe(got.length)
    expect(pages).toBe(Math.ceil(expected.length / 4))
  })

  it('filters by checks and by severity, and the last page says nothing more follows', async () => {
    const { items } = await walk({ checks: ['parent-is-a-variation', 'gtin-invalid'] }, 2)
    expect(items.map((i) => i.check)).toEqual(['parent-is-a-variation', 'parent-is-a-variation', 'gtin-invalid', 'gtin-invalid', 'gtin-invalid'])
    const warnings = await walk({ severity: 'warning' }, 100)
    expect(warnings.items.every((i) => i.severity === 'warning')).toBe(true)
    const last = await call('identity-issues', { checks: ['parent-deleted'] })
    expect(last.data).toMatchObject({ nextCursor: null, items: [{ sku: 'ID9-ORPH' }] })
    expect(last.data).not.toHaveProperty('more')
  })

  it('refuses a changed cursor, one made for other filters, and one from another business', async () => {
    const first = await call('identity-issues', { limit: 1 })
    const cursor = first.data.nextCursor as string
    expect(cursor).toEqual(expect.any(String))
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor, 'base64url').toString()), id: 'zzz' })).toString('base64url')
    for (const [args, who] of [
      [{ limit: 1, cursor: changed }, everything()],
      [{ limit: 1, cursor, severity: 'info' }, everything()],
      [{ limit: 1, cursor }, everything(CLEAN)],
    ] as const) {
      const out = await call('identity-issues', args, who)
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/cursor: this cursor is not valid for this list/)
    }
  })

  it('in CLEAN, the list holds only the Item ID A also holds', async () => {
    const out = await call('identity-issues', {}, everything(CLEAN))
    expect(out.data).toMatchObject({ items: [{ check: 'channel-id-in-another-business', sku: 'CLEAN-CHILD' }], nextCursor: null })
    expect(out.data.items).toHaveLength(1)
  })
})

// ── The extra-listing SKU (ProductListingAlias.sku): skipped while the column is missing, checked once it exists ──

describe('I2 — the extra-listing SKU check waits for its column', () => {
  it('without the column: skipped, with the reason, by the audit and by identity-issues', async () => {
    const audit = await call('identity-audit', { checks: ['listing-sku-equals-product-sku'] })
    expect(audit.data).toMatchObject({ findings: [], clean: [], skipped: [{ check: 'listing-sku-equals-product-sku' }] })
    const issues = await call('identity-issues', { checks: ['listing-sku-equals-product-sku'] })
    expect(issues.data).toMatchObject({ items: [], nextCursor: null, skipped: [{ check: 'listing-sku-equals-product-sku', reason: expect.stringContaining('ProductListingAlias.sku') }] })
  })

  it('with the column (as the listing-SKU migration adds it): finds an extra listing named like a product, not one with its own SKU', async () => {
    await database.db.query(`ALTER TABLE "ProductListingAlias" ADD COLUMN "sku" TEXT`)
    await database.db.query(`UPDATE "ProductListingAlias" SET sku = 'id11-taken ' WHERE id = $1`, [aliasIds.taken])
    await database.db.query(`UPDATE "ProductListingAlias" SET sku = 'ID11-OWN-SKU' WHERE id = $1`, [aliasIds.own])
    const findings = await everyFinding('listing-sku-equals-product-sku')
    expect(findings.map((f) => [f.sku, f.details?.listingSku, f.details?.productWithThatSku])).toEqual([['ID11-ALIASROOT', 'id11-taken ', 'ID11-TAKEN']])
    const audit = await call('identity-audit', { checks: ['listing-sku-equals-product-sku'] })
    expect(audit.data).toMatchObject({ skipped: [], findings: [{ check: 'listing-sku-equals-product-sku', count: 1 }] })
    // CLEAN has no extra listing: clean there.
    const clean = await call('identity-audit', { checks: ['listing-sku-equals-product-sku'] }, everything(CLEAN))
    expect(clean.data).toMatchObject({ skipped: [], findings: [], clean: ['listing-sku-equals-product-sku'] })
  })
})
