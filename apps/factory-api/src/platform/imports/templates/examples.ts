import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import type { TemplateExample } from '@nexus/factory-domain/imports/templates'
import { openingTemplate } from '@nexus/factory-domain/inventory/opening/importer'
import { openingStockImporter } from '@nexus/factory-domain/inventory/opening/importer'
// B-W2b-190: the customer portal's order sheet (its own made-up rows, shared with the portal's template).
import { ORDER_TEMPLATE_EXAMPLES } from '@nexus/factory-domain/sales/portal-ordering/upload'
// B-W2b-303: sales orders typed in a sheet (made-up customers, styles and PO numbers).
import { ORDER_IMPORT_EXAMPLES } from '@nexus/factory-domain/sales/order-import/importer'
// B-W2b-209: a made-up Nexus Commerce product export (one family, its own row and four SKUs).
import { COMMERCE_TEMPLATE_EXAMPLES } from '@nexus/factory-domain/product/commerce-import/sample'

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
    // W2b (B-W2b-311): a supplier's kinds, status, lead time and origin.
    { code: 'FOR-002', legalName: 'Laboratorio Esempio S.n.c.', kind: 'ORGANISATION', roles: 'fornitore; terzista', country: 'IT', currency: 'EUR', language: 'it', supplierKinds: 'conceria; terzista', supplierStatus: 'approvato', leadTimeDays: '21', originCountry: 'IT', originRegion: 'Toscana', hideOriginCountries: 'IT; ES', tannages: 'vegetale' },
  ],
  'product.materials': [
    { code: 'LEA-100', name: 'Bovine full grain 1.2 mm', kind: 'LEATHER', sourcing: 'BUY', tracking: 'HIDE', baseUom: 'M2', grade: 'A', thicknessMinMm: '1.1', thicknessMaxMm: '1.3', standardCost: '18.50' },
    { code: 'THR-40', name: 'Polyester thread 40', kind: 'THREAD', sourcing: 'BUY', tracking: 'NONE', baseUom: 'CONE', standardCost: '3.20' },
  ],
  // W2b (B-W2b-311): a supplier's price list (approved sources).
  'purchasing.supplierPrices': [
    { supplier: 'FOR-001', material: 'LEA-100', colour: '*', supplierArticleCode: 'VACCHETTA-12', purchaseUom: 'M2', unitPrice: '18.50', currency: 'EUR', minOrderQty: '50', orderMultiple: '5', leadTimeDays: '21', preference: 'principale' },
    { supplier: 'FOR-001', material: 'THR-40', colour: 'BLK', supplierColourCode: 'NERO 900', unitPrice: '3.10', minOrderQty: '12', preference: 'riserva' },
  ],
  'inventory.locations': [
    { site: 'A1', code: 'MAG-01', name: 'Leather store', kind: 'WAREHOUSE' },
    { site: 'A1', code: 'MAG-01-A', name: 'Rack A', kind: 'BIN', parent: 'MAG-01' },
  ],
  'product.bom': [{ style: 'JK-210', seq: '10', material: 'LEA-100', placement: 'Front panel', qty: '1.25', uom: 'M2', wastagePct: '8' }],
  'product.operations': [{ code: 'SEW-010', name: 'Sew the shoulders', nameIt: 'Cucitura spalle', nameEn: 'Sew the shoulders', workCentreKind: 'SEWING', standardMinutes: '4.5' }],
  // W2b (B-W2b-25): the machines import (Plant).
  'plant.machines': [
    { assetNumber: 'SEW-L2-07', site: 'A1', machineClass: 'LOCKSTITCH', make: 'Esempio', modelName: 'LS-200', year: '2021', station: 'SEW-02', workCentre: 'SEW', purchaseCost: '1850.00' },
    { assetNumber: 'CUT-T-02', site: 'A1', machineClass: 'CUTTING_TABLE', note: 'Next to the leather store' },
  ],
  'inventory.hideList': [
    { order: 'PO-2026-00012', tanneryNumber: 'T-4471', area: '5.20', unit: 'M2', grade: 'A' },
    { order: 'PO-2026-00012', tanneryNumber: 'T-4472', area: '4.85', unit: 'M2', grade: 'B' },
  ],
  'planning.itemParameters': [
    { site: 'A1', item: 'LEA-100', colour: '*', method: 'ORDERS', source: 'BUY', supplier: 'FOR-001', safetyLeadTimeDays: '2' },
    { site: 'A1', item: 'THR-40', colour: 'NER', method: 'REORDER_POINT', reorderPoint: '24', lotSize: '48', orderMultiple: '12', buyLeadTimeDays: '7' },
  ],
  // B-W2b-26: made-up people only (never a real name or code).
  'people.employees': [
    { employeeCode: '0142', firstName: 'Esempio', lastName: 'Persona Uno', kind: 'EMPLOYEE', site: 'A1', homeLine: 'L1', department: 'Sewing', jobRole: 'Machinist', contract: 'FULL_TIME', weeklyHours: '40', startDate: '2026-03-02', language: 'it' },
    { employeeCode: 'INT-07', firstName: 'Esempio', lastName: 'Persona Due', kind: 'AGENCY', agency: 'AGE-001', site: 'A1', contract: 'PART_TIME', weeklyHours: '20', startDate: '2026-11-02', endDate: '2027-01-29', language: 'ro' },
  ],
  // B-W2b-190
  'sales.portalOrderLines': ORDER_TEMPLATE_EXAMPLES,
  // B-W2b-303
  'sales.orders': ORDER_IMPORT_EXAMPLES,
  // B-W2b-182: a tannery's packing list on a sent ship notice (made-up numbers).
  'purchasing.packingList': [
    { notice: 'ASN-2026-0001', hideNumber: '2231-001', area: '21.40', unit: 'FT2', line: '10', grade: 'A', thicknessMm: '1.20', dyeBatch: '2231' },
    { notice: 'ASN-2026-0001', hideNumber: '2231-002', area: '19.85', unit: 'FT2', line: '10', grade: 'A', thicknessMm: '1.25', dyeBatch: '2231' },
  ],
  // B-W2b-209
  'product.commerceStyles': COMMERCE_TEMPLATE_EXAMPLES,
  // B-W2b-224: the point of measure library and grade rule steps (made-up points and increments).
  'product.pointsOfMeasure': [
    { code: 'CHEST_W', name: 'Chest width', nameIt: 'Mezzo torace', kind: 'GARMENT', bodyZone: 'UPPER', uom: 'CM', defaultTolerance: '1', howTo: 'Flat, 2 cm below the armhole, side to side.', bodyPoint: 'chest' },
    { code: 'chest', name: 'Chest girth', nameIt: 'Circonferenza torace', kind: 'BODY', bodyZone: 'UPPER', uom: 'CM', howTo: 'Around the fullest part of the chest.' },
  ],
  'product.gradeRules': [
    { rule: 'GR-JKT-EU', point: 'CHEST_W', step: '*', increment: '2', ruleName: 'Jacket EU', scale: 'EU-46-58', baseSize: '52', format: 'RELATIVE' },
    { rule: 'GR-JKT-EU', point: 'BACK_LEN', step: '52-54', increment: '1.5' },
  ],
  // B-W2b-250: the substance list (public CAS and EC numbers; a made-up note) and its rules (a made-up brand RSL line).
  'compliance.substances': [
    { identifier: '117-81-7', name: 'Bis(2-ethylhexyl) phthalate (DEHP)', ecNumber: '204-211-0', lists: 'SVHC, AFIRM_RSL', svhcAddedOn: '2008-10-28', note: 'Example row: a plasticiser in coated parts.' },
    { identifier: 'Nonylphenol ethoxylates', group: 'NPE', lists: 'REACH_ANNEX_XVII', annexXviiEntries: '46a' },
  ],
  'compliance.substanceRules': [
    { key: 'BRAND-RSL-EX-01', code: 'OTHER', name: 'DMF in coated materials, the brand\'s limit', substance: '68-12-2', limit: '10', unit: 'MG_KG', bound: 'AT_MOST', evidence: 'EITHER', source: 'CUSTOMER', customer: 'CLI-001', legalReference: 'Example brand RSL 2026, line 14' },
    { key: 'AFIRM-EX-PFAS', code: 'PFAS', name: 'PFAS in water-repellent finishes', group: 'PFAS_AFIRM', materialKinds: 'TEXTILE, MEMBRANE', markets: 'FR', evidence: 'DECLARATION', source: 'INDUSTRY', legalReference: 'Example industry RSL' },
  ],
  // B-W2b-325: a price list's prices (made-up list and style codes): every colourway with its breaks, a colourway's own
  // price, and an announced increase from a day.
  'sales.priceLists': [
    { list: 'PL-CLIENTE', style: 'JK-210', colourway: '*', validFrom: '-', validTo: '2027-01-31', unitPrice: '435', breaks: '10=425; 50=415' },
    { list: 'PL-CLIENTE', style: 'JK-210', colourway: '*', validFrom: '2027-02-01', validTo: '-', unitPrice: '449.50', breaks: '100=3%' },
    { list: 'PL-CLIENTE', style: 'JK-210', colourway: 'RED', validFrom: '-', unitPrice: '455' },
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
