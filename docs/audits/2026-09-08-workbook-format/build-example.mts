import { writeFile } from 'node:fs/promises'
import { writeCatalogWorkbook, type WorkbookScope, type WorkbookField } from '../../../apps/api/src/services/pim/catalog-workbook.ts'
import type { TransferRow } from '@nexus/shared/catalog-transfer'

// Synthetic product values; this exercises the production export writer.
const fields: WorkbookField[] = [
  { field: 'name', label: 'Product name', type: 'text', required: 'required', help: 'Use the product’s verified name.' },
  { field: 'brand', label: 'Brand', type: 'text' },
  { field: 'color', label: 'Color', type: 'text', options: ['Navy blue', 'Black', 'Red', 'Olive green', 'Crème'] },
  { field: 'size', label: 'Size', type: 'text', options: ['S', 'M', 'L', 'XL'] },
  { field: 'materials', label: 'Materials', type: 'list', options: ['Cotton', 'Recycled polyester', 'Elastane'], help: 'Use a JSON list, for example ["Cotton","Elastane"].' },
  { field: 'gtin', label: 'GTIN', type: 'text', maxLength: 14, help: 'Preserve leading zeros.' },
  { field: 'weight', label: 'Product weight', type: 'measure', unitOptions: ['grams', 'kilograms'], help: 'Use a number and unit, for example {"value":520,"unit":"grams"}.' },
]
const scope = (sheet: string, patch: Partial<WorkbookScope> = {}): WorkbookScope => ({ sheet, entity: 'Products', channel: '', accountId: '', marketplace: '', locale: '', category: '', fields, rows: [], ...patch })
const rows = (s: WorkbookScope, sku: string, values: Record<string, unknown>, aliasKey = '') => Object.entries(values).map(([field, value]): TransferRow => ({ row: 2, entity: s.entity, sku, channel: s.channel, accountId: s.accountId, marketplace: s.marketplace, locale: s.locale, aliasKey, field, value, action: 'SET', version: 7 }))
const products = scope('Products')
for (const size of ['S', 'M', 'L']) products.rows.push(...rows(products, `000104-${size}`, {
  name: 'Example lightweight rain jacket', brand: 'Example brand', color: 'Navy blue', size, materials: ['Recycled polyester', 'Elastane'], gtin: `00012345678${size === 'S' ? '11' : size === 'M' ? '28' : '35'}`, weight: { value: 520, unit: 'grams' },
}))
const content = scope('Content it', { locale: 'it', fields: [{ field: 'name', label: 'Italian title', type: 'text' }, { field: 'description', label: 'Italian description', type: 'text' }] })
content.rows = rows(content, '000104-M', { name: 'Giacca antipioggia leggera', description: 'Esempio di descrizione del prodotto.\nControllare i dettagli prima di importare.' })
const listings = scope('Amazon Italy', { entity: 'Overrides', channel: 'AMAZON', accountId: 'example-account', marketplace: 'IT', category: 'COAT', fields: [
  { field: 'item_name', label: 'Listing title', type: 'text', required: 'required', maxLength: 200 },
  { field: 'color', label: 'Listing color', type: 'text', options: ['Blue', 'Black', 'Red', 'Green', 'White'] },
  { field: 'size', label: 'Listing size', type: 'text', options: ['Small', 'Medium', 'Large'] },
  { field: 'country_of_origin', label: 'Country of origin', type: 'text', options: ['IT', 'PT', 'TR', 'VN'], help: 'Use the verified country code.' },
  { field: 'package_weight', label: 'Package weight', type: 'measure', unitOptions: ['grams', 'kilograms'] },
] })
for (const [alias, title] of [['', 'Giacca antipioggia leggera'], ['summer', 'Giacca leggera per l’estate'], ['outlet', 'Giacca antipioggia outlet']]) listings.rows.push(...rows(listings, '000104-M', { item_name: title, color: 'Blue', size: 'Medium', country_of_origin: 'PT', package_weight: { value: 620, unit: 'grams' } }, alias))
const scopes = [products, content, listings]
const baseline = { id: 'synthetic-format-example', scopes, aliasLabels: { '': 'Primary listing', summer: 'Summer listing', outlet: 'Outlet listing' } }
const bytes = await writeCatalogWorkbook(scopes, true, baseline)
await writeFile(new URL('./example-editing-workbook.xlsx', import.meta.url), bytes)
console.log(JSON.stringify({ bytes: bytes.length, scopes: scopes.length, attributes: scopes.reduce((sum, s) => sum + s.rows.length, 0), synthetic: true }))
