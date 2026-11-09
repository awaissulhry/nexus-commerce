import type { NumberFormat } from '@nexus/factory-domain/imports/cells'
import type { TemplateExample } from '@nexus/factory-domain/imports/templates'
import { openingTemplate } from '@nexus/factory-domain/inventory/opening/importer'
import { openingStockImporter } from '@nexus/factory-domain/inventory/opening/importer'
// B-W2b-190: the customer portal's order sheet (its own made-up rows, shared with the portal's template).
import { ORDER_TEMPLATE_EXAMPLES } from '@nexus/factory-domain/sales/portal-ordering/upload'
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
