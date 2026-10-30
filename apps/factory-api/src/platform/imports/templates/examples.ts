import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import type { TemplateExample } from '@nexus/factory-domain/imports/templates'
import { openingTemplate } from '@nexus/factory-domain/inventory/opening/importer'
import { openingStockImporter } from '@nexus/factory-domain/inventory/opening/importer'

/**
 * The made-up example rows of each importer's template (B-W2a-41; PLT-177): one or two rows a person can copy, never
 * real business data. Values are written neutrally (decimals with a point, dates as 2026-12-31): the template writes them
 * the way the import is told to read them. Opening stock keeps its own examples (B-W1-35, already in its number format).
 * An importer without examples gets a template with its header and the column explanations only.
 * `templates.vitest.test.ts` reads every example row through its importer: each one parses without a problem.
 */
export const TEMPLATE_EXAMPLES: Readonly<Record<string, readonly TemplateExample[]>> = Object.freeze<Record<string, readonly TemplateExample[]>>({
  'parties.parties': [
    { code: 'CLI-001', legalName: 'Moto Esempio S.r.l.', kind: 'ORGANISATION', roles: 'cliente', country: 'IT', currency: 'EUR', language: 'it', addressLine1: 'Via dei Tigli 4', postalCode: '40100', city: 'Bologna', province: 'BO', contactName: 'Ufficio acquisti', contactEmail: 'acquisti@moto-esempio.example' },
    { code: 'FOR-001', legalName: 'Conceria Esempio S.p.A.', kind: 'ORGANISATION', roles: 'fornitore', country: 'IT', currency: 'EUR', language: 'it', city: 'Santa Croce sull\'Arno', province: 'PI', contactEmail: 'ordini@conceria-esempio.example' },
  ],
  'product.materials': [
    { code: 'LEA-100', name: 'Bovine full grain 1.2 mm', kind: 'LEATHER', sourcing: 'BUY', tracking: 'HIDE', baseUom: 'M2', grade: 'A', thicknessMinMm: '1.1', thicknessMaxMm: '1.3', standardCost: '18.50' },
    { code: 'THR-40', name: 'Polyester thread 40', kind: 'THREAD', sourcing: 'BUY', tracking: 'NONE', baseUom: 'CONE', standardCost: '3.20' },
  ],
  'inventory.locations': [
    { site: 'A1', code: 'MAG-01', name: 'Leather store', kind: 'WAREHOUSE' },
    { site: 'A1', code: 'MAG-01-A', name: 'Rack A', kind: 'BIN', parent: 'MAG-01' },
  ],
  'product.bom': [{ style: 'JK-210', seq: '10', material: 'LEA-100', placement: 'Front panel', qty: '1.25', uom: 'M2', wastagePct: '8' }],
  'product.operations': [{ code: 'SEW-010', name: 'Sew the shoulders', nameIt: 'Cucitura spalle', nameEn: 'Sew the shoulders', workCentreKind: 'SEWING', standardMinutes: '4.5' }],
  'inventory.hideList': [
    { order: 'PO-2026-00012', tanneryNumber: 'T-4471', area: '5.20', unit: 'M2', grade: 'A' },
    { order: 'PO-2026-00012', tanneryNumber: 'T-4472', area: '4.85', unit: 'M2', grade: 'B' },
  ],
})

/** The examples of one importer for one number format: `formatted` when they are written for it already. */
export function examplesOf(importerKey: string, numberFormat: NumberFormat): { readonly examples: readonly TemplateExample[]; readonly formatted: boolean } {
  if (importerKey === openingStockImporter.key) {
    const template = openingTemplate(numberFormat)
    const names = template.columns.map((column) => column.name)
    return {
      examples: template.rows.map((row) => Object.fromEntries(names.flatMap((name, index) => (row[index] ? [[name, row[index]!]] : [])))),
      formatted: true,
    }
  }
  return { examples: TEMPLATE_EXAMPLES[importerKey] ?? [], formatted: false }
}
