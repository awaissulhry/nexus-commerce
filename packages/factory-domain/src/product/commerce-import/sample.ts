import type { TemplateExample } from '../../imports/templates'

/**
 * A made-up Nexus Commerce product export (B-W2b-209): one family with its own row and four SKUs, as Commerce writes it
 * (Parent SKU blank on the family's row; colour and size on each SKU). Every code, name and barcode is invented: the
 * barcodes use the GS1 prefix 200, which is for in-store numbers and never a company's. The import template's example
 * rows (apps/factory-api platform/imports/templates/examples.ts) and the tests read it.
 */
export const COMMERCE_TEMPLATE_EXAMPLES: readonly TemplateExample[] = Object.freeze<TemplateExample[]>([
  { sku: 'DEMO-TOUR', name: 'Giacca Touring Demo', productType: 'Giacche moto', season: 'FW27' },
  { sku: 'DEMO-TOUR-NER-50', family: 'DEMO-TOUR', name: 'Giacca Touring Demo - Nero - 50', colour: 'Nero', size: '50', gtin: '2009001000017' },
  { sku: 'DEMO-TOUR-NER-52', family: 'DEMO-TOUR', name: 'Giacca Touring Demo - Nero - 52', colour: 'Nero', size: '52', gtin: '2009001000024' },
  { sku: 'DEMO-TOUR-GRA-50', family: 'DEMO-TOUR', name: 'Giacca Touring Demo - Grigio antracite - 50', colour: 'Grigio antracite', size: '50', gtin: '2009001000031' },
  { sku: 'DEMO-TOUR-GRA-52', family: 'DEMO-TOUR', name: 'Giacca Touring Demo - Grigio antracite - 52', colour: 'Grigio antracite', size: '52' },
])

/** The headers a Commerce product export writes for those columns (the sheet's own words, matched by the aliases). */
export const COMMERCE_EXPORT_HEADERS = Object.freeze({
  sku: 'SKU',
  family: 'Parent SKU',
  name: 'Name',
  colour: 'Color',
  size: 'Size',
  gtin: 'EAN',
  productType: 'Category',
  season: 'Season',
})
