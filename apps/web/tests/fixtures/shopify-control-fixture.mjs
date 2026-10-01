// @ts-check
/**
 * Synthetic Shopify family for `tests/sheet-shopify-control.spec.ts` (lane01). Made-up ids and values only (the repository
 * is public); no store is contacted: the local API that serves this fixture must answer Shopify reads from `storeSchema`
 * and `storeSnapshot` below (the lead's synthetic-provider harness), never from a real store.
 *
 *   E2E_DATABASE_URL=postgresql://…@127.0.0.1:55530/nexus_pse_test node tests/fixtures/shopify-control-seed.mjs
 *
 * LOCAL ONLY: `privateSheetDatabaseConfig` refuses anything but the private sheet database. Idempotent: it rewrites only
 * its own `e2e_shopify_control_*` rows. `resetShopifyControlDraft` restores the starting draft between browser modes —
 * the legacy contradictory pin cannot be recreated through the UI (that is the point of the undo refusal).
 */
import { LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'

export const WORKSPACE = LEGACY_WORKSPACE_ID
export const ACCOUNT = 'e2e_shopify_control_store'
export const FAMILY = 'e2e_shopify_control_family'
export const NOTE = 'metafield:PRODUCT:custom.note'
export const LABEL = 'metafield:PRODUCT:custom.label'
/** The grid column ids of the two metafields (the sheet's mapping keys). */
/** @param {string} key */
export const column = key => ['shopify_metafield', ACCOUNT, 'PRODUCT', 'custom', key, 'single_line_text_field'].map(encodeURIComponent).join(':')
export const members = [
  { id: 'gid://shopify/Product/10', nexusId: FAMILY, title: 'Ridge rain jacket', handle: 'e2e-ridge-jacket', sku: 'E2E-SHOPIFY-CONTROL' },
  { id: 'gid://shopify/Product/20', nexusId: 'e2e_shopify_control_blue', title: 'Ridge jacket blue medium', handle: 'e2e-ridge-blue', sku: 'E2E-SHOPIFY-CONTROL-BLUE' },
  { id: 'gid://shopify/Product/30', nexusId: 'e2e_shopify_control_red', title: 'Ridge jacket red large', handle: 'e2e-ridge-red', sku: 'E2E-SHOPIFY-CONTROL-RED' },
]
/** @param {string} key @param {string} name @param {string} type @param {Array<{ name: string; value: string }>} [validations] @param {boolean} [required] */
const definition = (key, name, type, validations = [], required = false) => ({
  id: `gid://shopify/MetafieldDefinition/${100 + ['note', 'label', 'count', 'flag'].indexOf(key)}`, namespace: 'custom', key, name, ownerType: 'PRODUCT', type, validations, required,
  description: 'Synthetic store field for local sheet checks.', access: { admin: null, storefront: null },
})
export const storeSchema = {
  revision: 'e2e-shopify-control-schema-1', currency: 'EUR', metaobjectDefinitions: [],
  definitions: [definition('note', 'Care note', 'single_line_text_field', [{ name: 'max', value: '12' }], true), definition('label', 'Shared label', 'single_line_text_field'),
    definition('count', 'Pack count', 'number_integer', [{ name: 'min', value: '0' }]), definition('flag', 'Waterproof', 'boolean')],
  types: ['single_line_text_field', 'number_integer', 'boolean'].map(name => ({ name, category: 'SYNTHETIC' })),
  locales: [{ locale: 'en', primary: true, published: true }, { locale: 'it', primary: false, published: true }],
}
/** What the synthetic store "holds": the provider values the sheet compares drafts against. */
/** @param {string} [locale] */
export function storeSnapshot(locale) {
  return { currency: 'EUR', timezone: 'Europe/Rome', rows: members.map((member, index) => {
    const fields = storeSchema.definitions.map((d, fieldIndex) => ({ id: `gid://shopify/Metafield/${index * 10 + fieldIndex + 1}`, ownerId: member.id, namespace: d.namespace, key: d.key,
      type: d.type, compareDigest: `e2e-${index}-${fieldIndex}`,
      value: d.key === 'note' ? 'Gentle wash' : d.key === 'label' ? ['Original', 'Shared source', 'Other'][index] : d.key === 'count' ? String(index + 1) : 'false' }))
    return { id: member.id, productId: member.id, kind: 'PRODUCT', title: member.title, handle: member.handle, image: null, media: [], fields,
      values: { title: member.title, descriptionHtml: 'A lined rain jacket for daily use.', vendor: 'E2E Synthetic', tags: '[]', status: 'DRAFT', category: null, productType: 'Rain jacket' },
      ...(locale === 'it' ? { locale, translations: Object.fromEntries(fields.filter(f => f.type === 'single_line_text_field').map(f => [`metafield:PRODUCT:${f.namespace}.${f.key}`, {
        resourceId: f.id, fieldId: `metafield:PRODUCT:${f.namespace}.${f.key}`, key: 'value', locale, digest: f.compareDigest, value: f.key === 'note' ? 'Lavare piano' : 'Etichetta',
        sourceValue: f.value, outdated: false }])) } : {}) }
  }) }
}
/**
 * The starting draft: Italian note pins, and a "Shared label" rule (source Product/20) whose follower Product/10 still
 * keeps a saved pin — the legacy contradictory state the pop-up names and undo refuses. Product/30 simply follows.
 */
export const startingDraft = () => ({ version: 1, relationship: null, members: members.map(({ id, title, handle }) => ({ id, title, handle, image: null })), edits: [], baselineLinks: [],
  informationOnly: true, nativeEdits: [], mediaEdits: [],
  sheetValues: [...members.map(member => ({ ownerId: member.id, fieldId: NOTE, type: 'single_line_text_field', locale: 'it', value: 'Lavare piano' })),
    { ownerId: members[0].id, fieldId: LABEL, type: 'single_line_text_field', locale: '', value: 'Saved separate label' }],
  sharedFields: [{ namespace: 'custom', key: 'label', sourceProductId: members[1].id, excludedProductIds: [],
    baseline: storeSnapshot().rows.flatMap(row => row.fields.filter(f => f.key === 'label')) }],
})

/** @param {number} index */
const listingId = index => `e2e_shopify_control_listing_${index}`

/**
 * Create or rewrite the synthetic family inside `db` (an open pg client, in a transaction the caller owns).
 * @param {import('pg').Client} db
 */
export async function seedShopifyControl(db) {
  await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
  if (!(await db.query(`SELECT 1 FROM "Marketplace" WHERE channel='SHOPIFY' AND code='GLOBAL' AND "workspaceId"=$1`, [WORKSPACE])).rowCount)
    await db.query(`INSERT INTO "Marketplace" (id,"workspaceId",channel,code,name,region,currency,language,languages,"isActive","updatedAt") VALUES ('e2e_shopify_control_market',$1,'SHOPIFY','GLOBAL','Synthetic Shopify','GLOBAL','EUR','en',ARRAY['en','it'],true,now())`, [WORKSPACE])
  await db.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","isActive","isPrimary","displayName","externalAccountId","updatedAt") VALUES ($1,$2,'SHOPIFY',true,false,'E2E synthetic Shopify (no credentials)',$1,now()) ON CONFLICT (id) DO NOTHING`, [ACCOUNT, WORKSPACE])
  for (const [index, member] of members.entries()) {
    await db.query(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","isParent","parentId","bulletPoints",keywords,"updatedAt") VALUES ($1,$2,$3,$4,89.95,$5,$6,ARRAY[]::text[],ARRAY[]::text[],now()) ON CONFLICT (id) DO NOTHING`,
      [member.nexusId, WORKSPACE, member.sku, member.title, index === 0, index === 0 ? null : FAMILY])
    await db.query(`INSERT INTO "ChannelListing" (id,"workspaceId","productId",channel,"channelMarket",marketplace,region,"channelConnectionId","externalListingId","listingStatus","isPublished","platformAttributes","updatedAt") VALUES ($1,$2,$3,'SHOPIFY','SHOPIFY_GLOBAL','GLOBAL','GLOBAL',$4,$5,'DRAFT',false,'{}'::jsonb,now()) ON CONFLICT (id) DO NOTHING`,
      [listingId(index), WORKSPACE, member.nexusId, ACCOUNT, member.id.split('/').at(-1)])
  }
  await resetShopifyControlDraft(db)
}

/**
 * Restore the starting draft on the family listing (and nothing else).
 * @param {import('pg').Client} db
 */
export async function resetShopifyControlDraft(db) {
  await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
  const updated = await db.query(`UPDATE "ChannelListing" SET "platformAttributes" = jsonb_build_object('_nexusLinkedProducts', $2::jsonb), version = version + 1, "updatedAt" = now() WHERE id = $1 AND "productId" = $3 AND "channelConnectionId" = $4`,
    [listingId(0), JSON.stringify(startingDraft()), FAMILY, ACCOUNT])
  if (updated.rowCount !== 1) throw new Error('Seed the synthetic Shopify family first (tests/fixtures/shopify-control-seed.mjs).')
  await db.query(`UPDATE "ChannelListing" SET "platformAttributes" = '{}'::jsonb, version = version + 1, "updatedAt" = now() WHERE id = ANY($1) AND "channelConnectionId" = $2`, [[listingId(1), listingId(2)], ACCOUNT])
}

export const familyListingId = listingId(0)
