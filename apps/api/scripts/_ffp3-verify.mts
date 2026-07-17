// FFP.3 verification — parent stripping, per-type pruning, minimal DELETE,
// blank-productType fallback (no network, no DB writes).
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const { AmazonFlatFileService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/amazon/flat-file.service.js')
const { AmazonService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketplaces/amazon.service.js')
const { CategorySchemaService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/categories/schema-sync.service.js')
const svc = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

const applicable = new Map<string, Set<string>>([
  ['OUTERWEAR', new Set(['item_sku', 'product_type', 'record_action', 'item_name', 'brand',
    'purchasable_offer__our_price', 'fulfillment_availability__quantity', 'fabric_type',
    'parentage_level', 'parent_sku', 'variation_theme'])],
])

const rows = [
  { _rowId: 'p', item_sku: 'PARENT', record_action: 'partial_update', product_type: 'OUTERWEAR',
    parentage_level: 'parent', variation_theme: 'SIZE', item_name: 'Parent title',
    'purchasable_offer__our_price': '49.9', 'fulfillment_availability__quantity': '7',
    'fulfillment_availability__fulfillment_channel_code': 'DEFAULT', fabric_type: 'Cordura' },
  { _rowId: 'c', item_sku: 'CHILD', record_action: 'partial_update', product_type: 'OUTERWEAR',
    parentage_level: 'child', parent_sku: 'PARENT', item_name: 'Child title',
    'purchasable_offer__our_price': '49.9', 'fulfillment_availability__quantity': '7',
    'fulfillment_availability__fulfillment_channel_code': 'DEFAULT',
    occasion_type_1: 'casual', fabric_type: 'Cordura' },
  { _rowId: 'b', item_sku: 'BLANK-PT', record_action: 'partial_update', item_name: 'No PT' },
  { _rowId: 'd', item_sku: 'DEL', record_action: 'delete', product_type: 'OUTERWEAR' },
]
const body = JSON.parse(svc.buildJsonFeedBody(rows as never, 'IT', 'SELLER123', {}, {
  applicableByType: applicable, defaultProductType: 'OUTERWEAR',
}))
const bySku = new Map(body.messages.map((m: { sku: string }) => [m.sku, m]))

console.log('[parent stripping]')
const parent = bySku.get('PARENT') as { attributes: Record<string, unknown> }
check('parent has NO purchasable_offer', !('purchasable_offer' in parent.attributes))
check('parent has NO fulfillment_availability', !('fulfillment_availability' in parent.attributes))
check('parent keeps parentage_level', JSON.stringify(parent.attributes.parentage_level ?? '').includes('parent'))
check('parent keeps variation_theme', 'variation_theme' in parent.attributes)
check('parent keeps product facts (fabric_type)', 'fabric_type' in parent.attributes)

console.log('[child untouched]')
const child = bySku.get('CHILD') as { attributes: Record<string, unknown> }
check('child keeps purchasable_offer', 'purchasable_offer' in child.attributes)
check('child keeps fulfillment_availability', 'fulfillment_availability' in child.attributes)
check('child keeps child_parent_sku_relationship', 'child_parent_sku_relationship' in child.attributes)

console.log('[per-type pruning]')
check('non-applicable occasion_type_1 pruned from child', !('occasion_type_1' in child.attributes))

console.log('[productType fallback + minimal delete]')
const blank = bySku.get('BLANK-PT') as { productType: string }
check('blank product_type falls back to batch type', blank.productType === 'OUTERWEAR', blank.productType)
const del = bySku.get('DEL') as Record<string, unknown>
check('DELETE = {messageId, sku, operationType} only', Object.keys(del).sort().join(',') === 'messageId,operationType,sku', Object.keys(del).join(','))

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
