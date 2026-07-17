// FFP.2 verification — buildJsonFeedBody operation mapping (no network, no DB writes).
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const { AmazonFlatFileService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/amazon/flat-file.service.js')
const { AmazonService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketplaces/amazon.service.js')
const { CategorySchemaService } = await import('/Users/awais/nexus-commerce/apps/api/src/services/categories/schema-sync.service.js')
const flatFileService = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))

const rows = [
  { _rowId: '1', item_sku: 'SKU-DEL', record_action: 'delete', product_type: 'OUTERWEAR', item_name: 'should not appear', brand: 'X' },
  { _rowId: '2', item_sku: 'SKU-PARTIAL', record_action: 'partial_update', product_type: 'OUTERWEAR', item_name: 'Partial title' },
  { _rowId: '3', item_sku: 'SKU-FULL', record_action: 'full_update', product_type: 'OUTERWEAR', item_name: 'Full title' },
  { _rowId: '4', item_sku: 'SKU-NEW', _isNew: true, record_action: 'partial_update', product_type: 'OUTERWEAR', item_name: 'New title' },
  { _rowId: '5', item_sku: 'SKU-DEFAULT', product_type: 'OUTERWEAR', item_name: 'No action title' },
]
const body = JSON.parse(flatFileService.buildJsonFeedBody(rows as never, 'IT', 'SELLER123', {}, {}))
let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}
const bySku = new Map(body.messages.map((m: { sku: string }) => [m.sku, m]))
const del = bySku.get('SKU-DEL') as Record<string, unknown>
check('delete → operationType DELETE', del?.operationType === 'DELETE')
check('delete message carries NO attributes', JSON.stringify(del?.attributes ?? {}) === '{}')
check('delete message has no requirements', !('requirements' in (del ?? {})))
const part = bySku.get('SKU-PARTIAL') as Record<string, unknown>
check('partial_update → PARTIAL_UPDATE', part?.operationType === 'PARTIAL_UPDATE')
check('partial has no requirements', !('requirements' in (part ?? {})))
const full = bySku.get('SKU-FULL') as Record<string, unknown>
check('explicit full_update → UPDATE (FFP.2)', full?.operationType === 'UPDATE', String(full?.operationType))
check('full UPDATE sets requirements', full?.requirements === 'LISTING', String(full?.requirements))
const nw = bySku.get('SKU-NEW') as Record<string, unknown>
check('_isNew → UPDATE regardless of action', nw?.operationType === 'UPDATE')
const dflt = bySku.get('SKU-DEFAULT') as Record<string, unknown>
check('no record_action → PARTIAL_UPDATE (safe default)', dflt?.operationType === 'PARTIAL_UPDATE')
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
