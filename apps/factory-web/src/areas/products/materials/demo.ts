import { asMoney } from '@nexus/factory-domain/money/marked'
import type { Lot } from '../../quality/_shared/lots'
import { at, COMPANY_ID, uid } from '../library/demo'
import type { CoveringCertificate, LibraryColour, MaterialRow, MaterialStock, MaterialView, SupplierRow } from './api'

/** A made-up cost figure, branded with its grain as the contract types it. */
const cost = (value: string | null) => asMoney('cost', value)

/**
 * Design-only made-up materials (SCR-047/048): an invented factory's leathers, textiles, thread, hardware, a protector
 * and a label. Suppliers, codes and prices are invented ("Demo"). `withoutCost` strips the money fields as the API does
 * for a person without the cost grain.
 */

const SUPPLIERS = {
  tannery: { id: uid('4701', 1), code: 'SUP-DEMO-01', name: 'Conceria Demo S.r.l.' },
  mill: { id: uid('4701', 2), code: 'SUP-DEMO-02', name: 'Tessitura Esempio S.p.A.' },
  trims: { id: uid('4701', 3), code: 'SUP-DEMO-03', name: 'Accessori Demo S.r.l.' },
  protectors: { id: uid('4701', 4), code: 'SUP-DEMO-04', name: 'Protezioni Esempio S.r.l.' },
}

export const SUPPLIER_ROWS: SupplierRow[] = Object.values(SUPPLIERS).map((supplier) => ({ id: supplier.id, code: supplier.code, legalName: supplier.name, tradeName: null, status: 'ACTIVE' }))

const row = (n: number, fields: Partial<MaterialRow> & Pick<MaterialRow, 'code' | 'name' | 'kind' | 'baseUom'>): MaterialRow => ({
  id: uid('4702', n),
  companyId: COMPANY_ID,
  nameI18n: null,
  sourcing: 'BUY',
  tracking: 'NONE',
  purchaseUom: fields.baseUom,
  consumptionUom: fields.baseUom,
  defaultSupplier: null,
  supplierArticleCode: null,
  isPpeComponent: false,
  requiresCrViTest: false,
  crViLimitMgKg: null,
  standardCost: cost(null),
  currency: 'EUR',
  colourCount: 0,
  status: 'ACTIVE',
  version: 3,
  updatedAt: at(27, 14, 10),
  ...fields,
})

export const ROWS: MaterialRow[] = [
  row(1, { code: 'DEMO-PL-NAP12', name: 'Pelle bovina pieno fiore 1,2 mm', kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'HIDE', consumptionUom: 'DM2', tracking: 'HIDE', defaultSupplier: SUPPLIERS.tannery, supplierArticleCode: 'NAP-12-DEMO', requiresCrViTest: true, crViLimitMgKg: '3', standardCost: cost('2.4'), colourCount: 3 }),
  row(2, { code: 'DEMO-PL-CNG10', name: 'Pelle di canguro 1,0 mm', kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'HIDE', consumptionUom: 'DM2', tracking: 'HIDE', defaultSupplier: SUPPLIERS.tannery, supplierArticleCode: 'KAN-10-DEMO', requiresCrViTest: true, crViLimitMgKg: '2', colourCount: 1 }),
  row(3, { code: 'DEMO-TX-CORD5', name: 'Cordura 500 denari', kind: 'TEXTILE', baseUom: 'M', purchaseUom: 'ROLL', tracking: 'LOT', defaultSupplier: SUPPLIERS.mill, supplierArticleCode: 'C500-DEMO', standardCost: cost('9.8'), colourCount: 2 }),
  row(4, { code: 'DEMO-LN-MESH', name: 'Fodera in rete 3D', kind: 'LINING', baseUom: 'M', purchaseUom: 'ROLL', defaultSupplier: SUPPLIERS.mill, standardCost: cost('4.15'), colourCount: 1 }),
  row(5, { code: 'DEMO-TH-40', name: 'Filo poliestere 40', kind: 'THREAD', baseUom: 'M', purchaseUom: 'CONE', defaultSupplier: SUPPLIERS.trims, standardCost: cost('0.012'), colourCount: 4 }),
  row(6, { code: 'DEMO-HW-ZIP8', name: 'Zip divisibile n. 8', kind: 'HARDWARE', baseUom: 'PCS', defaultSupplier: SUPPLIERS.trims, supplierArticleCode: 'Z8-DEMO', standardCost: cost('1.35'), colourCount: 1 }),
  row(7, { code: 'DEMO-PR-SH2', name: 'Protezione spalla livello 2', kind: 'PROTECTOR', baseUom: 'PCS', tracking: 'LOT', isPpeComponent: true, defaultSupplier: SUPPLIERS.protectors, supplierArticleCode: 'SH2-DEMO', standardCost: cost('6.5') }),
  row(8, { code: 'DEMO-LB-PPE', name: 'Etichetta DPI tessuta', kind: 'LABEL', baseUom: 'PCS', sourcing: 'MAKE_OR_BUY' }),
  row(9, { code: 'DEMO-TX-OLD', name: 'Tessuto stagione passata', kind: 'TEXTILE', baseUom: 'M', status: 'ARCHIVED', standardCost: cost('7.2') }),
]

/** The rows as a person without the cost grain receives them (no standard cost field at all). */
export const withoutCost = <T extends { standardCost?: unknown; standardCostPerPurchaseUnit?: unknown; standardCostPerConsumptionUnit?: unknown }>(value: T): T => {
  const { standardCost: _a, standardCostPerPurchaseUnit: _b, standardCostPerConsumptionUnit: _c, ...rest } = value
  return rest as T
}

export const LIBRARY_COLOURS: LibraryColour[] = [
  { id: uid('4703', 1), code: 'BLK', name: 'Nero', hex: '#1d1d1f', status: 'ACTIVE' },
  { id: uid('4703', 2), code: 'RED', name: 'Rosso corsa', hex: '#b3261e', status: 'ACTIVE' },
  { id: uid('4703', 3), code: 'WHT', name: 'Bianco', hex: '#f4f4f2', status: 'ACTIVE' },
]

/** The leather's record: hide 52.5 ft², cut in dm², three colours (one archived), the cost per hide and per dm². */
export const LEATHER: MaterialView = {
  ...ROWS[0]!,
  units: {
    base: { uom: 'FT2', factor: '1', fixed: true },
    purchase: { uom: 'HIDE', factor: '52.5', fixed: false },
    consumption: { uom: 'DM2', factor: '0.10763910', fixed: true },
  },
  standardCostPerPurchaseUnit: cost('126'),
  standardCostPerConsumptionUnit: cost('0.2583'),
  animalSpecies: 'Bovino',
  tannage: 'CHROME',
  grade: 'TR1',
  finish: 'Pieno fiore, rifinizione semianilina',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  composition: null,
  animalOrigin: true,
  attributes: { Origine: 'Italia (esempio)' },
  colours: [
    { id: uid('4704', 1), code: 'BLK', name: 'Nero', supplierColourCode: 'N-01', colourId: LIBRARY_COLOURS[0]!.id, status: 'ACTIVE', version: 1, createdAt: at(2), updatedAt: at(2) },
    { id: uid('4704', 2), code: 'RED', name: 'Rosso corsa', supplierColourCode: 'R-07', colourId: LIBRARY_COLOURS[1]!.id, status: 'ACTIVE', version: 2, createdAt: at(2), updatedAt: at(9) },
    { id: uid('4704', 3), code: 'WHT', name: 'Bianco', supplierColourCode: 'B-02', colourId: LIBRARY_COLOURS[2]!.id, status: 'ACTIVE', version: 1, createdAt: at(3), updatedAt: at(3) },
    { id: uid('4704', 4), code: 'BLU', name: 'Blu notte', supplierColourCode: 'BL-3', colourId: null, status: 'ARCHIVED', version: 3, createdAt: at(1), updatedAt: at(20) },
  ],
  warnings: [],
  createdAt: at(1, 8),
  createdById: uid('4705', 1),
}

/** The protector's record: a PPE component traced by lot, covered by a made-up EN 1621 certificate. */
export const PROTECTOR: MaterialView = {
  ...ROWS[6]!,
  units: { base: { uom: 'PCS', factor: '1', fixed: true }, purchase: { uom: 'PCS', factor: '1', fixed: true }, consumption: { uom: 'PCS', factor: '1', fixed: true } },
  standardCostPerPurchaseUnit: cost('6.5'),
  standardCostPerConsumptionUnit: cost('6.5'),
  animalSpecies: null,
  tannage: null,
  grade: null,
  finish: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  composition: null,
  animalOrigin: false,
  attributes: null,
  colours: [],
  warnings: [],
  createdAt: at(4),
  createdById: uid('4705', 1),
}

/** The textile's record: composition per fibre, no Cr VI rule, a warning for the missing supplier. */
export const TEXTILE: MaterialView = {
  ...ROWS[3]!,
  defaultSupplier: null,
  units: { base: { uom: 'M', factor: '1', fixed: true }, purchase: { uom: 'ROLL', factor: '50', fixed: false }, consumption: { uom: 'M', factor: '1', fixed: true } },
  standardCostPerPurchaseUnit: cost('207.5'),
  standardCostPerConsumptionUnit: cost('4.15'),
  animalSpecies: null,
  tannage: null,
  grade: null,
  finish: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  composition: [
    { fibre: 'Poliestere', percent: '88' },
    { fibre: 'Elastan', percent: '12' },
  ],
  animalOrigin: false,
  attributes: { Peso: '220 g/m²' },
  colours: [{ id: uid('4704', 9), code: 'BLK', name: 'Nero', supplierColourCode: null, colourId: LIBRARY_COLOURS[0]!.id, status: 'ACTIVE', version: 1, createdAt: at(5), updatedAt: at(5) }],
  warnings: [{ code: 'NO_DEFAULT_SUPPLIER', message: 'No default supplier.' }],
  createdAt: at(5),
  createdById: uid('4705', 1),
}

export const CERTIFICATES: CoveringCertificate[] = [{ id: uid('5001', 2), number: 'CERT-DEMO-1621-07', standard: 'EN 1621-1:2012', ppeClass: '2', validTo: '2029-03-11', status: 'VALID', daysToExpiry: 863 }]

const lot = (n: number, fields: Partial<Lot>): Lot => ({
  id: uid('5401', n),
  code: `LOT-DEMO-${String(n).padStart(4, '0')}`,
  companyId: COMPANY_ID,
  siteId: uid('2222', 1),
  item: { id: LEATHER.id, code: LEATHER.code, name: LEATHER.name, kind: 'LEATHER', isPpeComponent: false },
  itemColourId: LEATHER.colours[0]!.id,
  supplierId: SUPPLIERS.tannery.id,
  supplierLotRef: `T-${n}`,
  dyeBatch: null,
  shade: null,
  receivedAt: at(10 + n),
  receivedById: null,
  receipt: null,
  qualityStatus: 'RELEASED',
  qualityNote: null,
  qualityDecidedAt: at(12 + n),
  qualityDecidedById: null,
  hold: null,
  crVi: { required: true, status: 'PASS', limitMgKg: '3', valueMgKg: '1.2', evidence: 'LOT_REPORT', testedOn: `2026-10-${String(11 + n).padStart(2, '0')}` },
  words: 'Released.',
  version: 2,
  ...fields,
})

export const LOTS: Lot[] = [
  lot(1, {}),
  lot(2, { qualityStatus: 'QUARANTINE', crVi: { required: true, status: 'PENDING', limitMgKg: '3', valueMgKg: null, evidence: null, testedOn: null }, words: 'Waiting for its Cr VI evidence.' }),
  lot(3, { qualityStatus: 'BLOCKED', crVi: { required: true, status: 'FAIL', limitMgKg: '3', valueMgKg: '4.1', evidence: 'LOT_REPORT', testedOn: '2026-10-14' }, words: 'Cr VI above the limit.' }),
]

export const STOCK: MaterialStock = {
  rows: [
    { siteId: uid('2222', 1), siteCode: 'DEMO-1', location: { id: uid('5501', 1), code: 'MAG-PELLI', name: 'Magazzino pelli' }, colour: { id: LEATHER.colours[0]!.id, code: 'BLK', name: 'Nero' }, lot: { id: LOTS[0]!.id, code: LOTS[0]!.code, qualityStatus: 'RELEASED' }, hide: { id: uid('5502', 1), code: 'H-DEMO-0001' }, onHand: '51.8', held: '0', available: '51.8' },
    { siteId: uid('2222', 1), siteCode: 'DEMO-1', location: { id: uid('5501', 1), code: 'MAG-PELLI', name: 'Magazzino pelli' }, colour: { id: LEATHER.colours[0]!.id, code: 'BLK', name: 'Nero' }, lot: { id: LOTS[0]!.id, code: LOTS[0]!.code, qualityStatus: 'RELEASED' }, hide: { id: uid('5502', 2), code: 'H-DEMO-0002' }, onHand: '53.1', held: '0', available: '53.1' },
    { siteId: uid('2222', 1), siteCode: 'DEMO-1', location: { id: uid('5501', 2), code: 'QUAR', name: 'Quarantena' }, colour: { id: LEATHER.colours[1]!.id, code: 'RED', name: 'Rosso corsa' }, lot: { id: LOTS[1]!.id, code: LOTS[1]!.code, qualityStatus: 'QUARANTINE' }, hide: { id: uid('5502', 3), code: 'H-DEMO-0003' }, onHand: '52.4', held: '52.4', available: '0' },
  ],
  totals: [
    { itemColourId: LEATHER.colours[0]!.id, onHand: '104.9', held: '0', available: '104.9', hides: 2, heldHides: 0, locations: 1 },
    { itemColourId: LEATHER.colours[1]!.id, onHand: '52.4', held: '52.4', available: '0', hides: 1, heldHides: 1, locations: 1 },
  ],
  truncated: false,
}
