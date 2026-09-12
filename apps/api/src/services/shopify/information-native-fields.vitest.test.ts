import { describe, expect, it } from 'vitest'
import { applyNativeEdit, readInformationNativeOwners } from './information-gateway.js'
import type { NativeEdit } from '@nexus/shared/shopify-information'
const pid = 'gid://shopify/Product/1', vid = 'gid://shopify/ProductVariant/2'
function setup() {
  const product: any = { id: pid, title: 'Original', handle: 'original', descriptionHtml: '<p>Old</p>', tags: ['old'], status: 'DRAFT', vendor: 'Original brand', productType: 'Coat', templateSuffix: '', category: { id: 'gid://shopify/TaxonomyCategory/aa-1' }, seo: { title: 'Old SEO', description: 'Old description' } }
  const variant: any = { id: vid, product: { id: pid }, price: '10.00', compareAtPrice: '20.00', barcode: '0001', taxable: true, inventoryPolicy: 'DENY', unitPriceMeasurement: { quantityUnit: 'ML', quantityValue: 100, referenceUnit: 'L', referenceValue: 1 }, inventoryItem: { sku: '0001-A', tracked: true, requiresShipping: true, harmonizedSystemCode: '001234', countryCodeOfOrigin: 'IT', unitCost: { amount: '5.00' }, measurement: { weight: { value: 1, unit: 'KILOGRAMS' } } } }
  const writes: any[] = []
  const gql = async (query: string, vars: any) => {
    if (query.includes('NexusInformationNativeOwners')) return { nodes: vars.ids.map((id: string) => id === pid ? structuredClone(product) : id === vid ? structuredClone(variant) : null) }
    if (query.includes('NexusInformationHandle')) return { productByIdentifier: null }
    if (query.includes('NexusInformationProductUpdate')) { writes.push(vars); const { id, redirectNewHandle, deleteConflictingConstrainedMetafields, ...patch } = vars.product; Object.assign(product, patch, ...(patch.seo ? [{ seo: { ...product.seo, ...patch.seo } }] : [])); if ('category' in patch) product.category = patch.category === null ? null : { id: patch.category }; return { productUpdate: { userErrors: [] } } }
    if (query.includes('NexusInformationVariantUpdate')) { expect(query).toContain('allowPartialUpdates:false'); writes.push(vars); const { id, inventoryItem, ...patch } = vars.variants[0]; Object.assign(variant, patch); if (inventoryItem) { Object.assign(variant.inventoryItem, inventoryItem); if ('cost' in inventoryItem) variant.inventoryItem.unitCost = inventoryItem.cost === null ? null : { amount: inventoryItem.cost } } return { productVariantsBulkUpdate: { userErrors: [] } } }
    throw new Error(query)
  }
  return { gql: gql as any, writes, product, variant }
}
const productCases: [NativeEdit['field'], string | null, object][] = [
  ['title', 'New name', { title: 'New name' }], ['descriptionHtml', '<p>New</p>', { descriptionHtml: '<p>New</p>' }], ['tags', '[]', { tags: [] }], ['vendor', '', { vendor: '' }], ['productType', 'New type', { productType: 'New type' }], ['status', 'ACTIVE', { status: 'ACTIVE' }], ['category', null, { category: null, deleteConflictingConstrainedMetafields: false }], ['templateSuffix', 'custom', { templateSuffix: 'custom' }], ['handle', 'new-handle', { handle: 'new-handle', redirectNewHandle: true }], ['seo.title', null, { seo: { title: null } }], ['seo.description', '', { seo: { description: '' } }],
]
const variantCases: [NativeEdit['field'], string | null, object][] = [
  ['price', '0.00', { price: '0.00' }], ['compareAtPrice', null, { compareAtPrice: null }], ['barcode', '000002', { barcode: '000002' }], ['taxable', 'false', { taxable: false }], ['inventoryPolicy', 'CONTINUE', { inventoryPolicy: 'CONTINUE' }], ['sku', '00002-B', { inventoryItem: { sku: '00002-B' } }], ['tracked', 'false', { inventoryItem: { tracked: false } }], ['requiresShipping', 'false', { inventoryItem: { requiresShipping: false } }], ['harmonizedSystemCode', null, { inventoryItem: { harmonizedSystemCode: null } }], ['countryCodeOfOrigin', 'US', { inventoryItem: { countryCodeOfOrigin: 'US' } }], ['cost', '0.00', { inventoryItem: { cost: '0.00' } }], ['weight', '{"value":0,"unit":"GRAMS"}', { inventoryItem: { measurement: { weight: { value: 0, unit: 'GRAMS' } } } }], ['unitPriceMeasurement', '{"quantityValue":200,"quantityUnit":"ML","referenceValue":1,"referenceUnit":"L"}', { unitPriceMeasurement: { quantityValue: 200, quantityUnit: 'ML', referenceValue: 1, referenceUnit: 'L' } }],
]
describe('Native field-to-mutation contracts on Shopify 2026-07', () => {
  for (const [field, nextValue, patch] of productCases) it(`writes only product ${field} and verifies readback`, async () => {
    const s = setup(), [row] = await readInformationNativeOwners(s.gql, [pid]); await applyNativeEdit(s.gql, { productId: pid, ownerId: pid, ownerLabel: 'Product', field, value: row.values[field], nextValue })
    expect(s.writes).toEqual([{ product: { id: pid, ...patch } }])
  })
  for (const [field, nextValue, patch] of variantCases) it(`writes only variant ${field} and verifies readback`, async () => {
    const s = setup(), [row] = await readInformationNativeOwners(s.gql, [vid]); await applyNativeEdit(s.gql, { productId: pid, ownerId: vid, ownerLabel: 'Variant', field, value: row.values[field], nextValue })
    expect(s.writes).toEqual([{ id: pid, variants: [{ id: vid, ...patch }] }])
  })
})
