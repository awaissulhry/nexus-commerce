import { createElement, useEffect, useState } from 'react'
import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import type { MaterialDetail, MaterialOption } from '../../../../_shared/buying/api'
import type { Source } from '../api'
import { newAddDraft, say, sourcesCan, type AddDraft, type ApprovedSourcesActions, type ApprovedSourcesModel, type SourcesDialog, type SupplierPricesModel } from '../model'
import { ApprovedSourcesView } from '../view/ApprovedSourcesView'

/**
 * Design-only made-up data for the approved sources (SCR-057 Items & prices, SCR-048 Supplier prices): "Demo" names,
 * DEMO- codes, invented prices and dates. Nothing here is a real supplier, material, price or order.
 */

export const PREFIX = '/w/DEMO'
const COMPANY = { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name }
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 9, day, hour, 0)).toISOString()

/** The supplier of the record cases (parties fixtures: CONCERIA-DEMO, party 21) and two other made-up suppliers. */
export const SUPPLIER = { id: uid('6666', 21), code: 'CONCERIA-DEMO', name: 'Conceria Demo' }
const OTHERS = {
  second: { id: uid('6666', 31), code: 'CONCERIA-DUE', name: 'Conceria Esempio Due' },
  third: { id: uid('6666', 32), code: 'PELLAMI-PROVA', name: 'Pellami Prova' },
}

export const MATERIAL = {
  leather: { id: uid('4701', 1), code: 'DEMO-PL-NAP12', name: 'Pelle bovina pieno fiore 1,2 mm', kind: 'LEATHER', status: 'ACTIVE', baseUom: 'FT2' as const, purchaseUom: 'HIDE' as const },
  cordura: { id: uid('4701', 3), code: 'DEMO-TX-CORD5', name: 'Cordura 500 denari', kind: 'TEXTILE', status: 'ACTIVE', baseUom: 'M' as const, purchaseUom: 'ROLL' as const },
  lining: { id: uid('4701', 4), code: 'DEMO-LN-MESH', name: 'Fodera in rete 3D', kind: 'LINING', status: 'ACTIVE', baseUom: 'M' as const, purchaseUom: 'ROLL' as const },
  thread: { id: uid('4701', 5), code: 'DEMO-TH-40', name: 'Filo poliestere 40', kind: 'THREAD', status: 'ACTIVE', baseUom: 'M' as const, purchaseUom: 'CONE' as const },
}
const BLACK = { id: uid('4702', 1), code: 'NERO', name: 'Nero' }

function source(n: number, over: Partial<Source> & Pick<Source, 'item' | 'itemId'>): Source {
  return {
    id: uid('5151', n),
    companyId: COMPANY.id,
    company: { code: COMPANY.code, name: COMPANY.name },
    partyId: SUPPLIER.id,
    supplier: { code: SUPPLIER.code, name: SUPPLIER.name, status: 'ACTIVE' },
    itemColourId: null,
    colour: null,
    supplierArticleCode: null,
    supplierColourCode: null,
    description: null,
    purchaseUom: over.item.purchaseUom,
    purchaseFactor: '1',
    baseUom: over.item.baseUom,
    unitUsable: true,
    unitPrice: null,
    currency: 'EUR',
    minOrderQty: null,
    orderMultiple: null,
    leadTimeDays: null,
    supplierLeadTimeDays: 14,
    preference: 'BACKUP',
    status: 'ACTIVE',
    note: null,
    lastPurchase: null,
    version: 3,
    createdAt: at(2),
    updatedAt: at(20),
    createdById: null,
    ...over,
  }
}

/** Conceria Demo's approved sources: a colour's own PRIMARY, every colour of every company, a roll, an unusable unit, one archived. */
export const SOURCES: Source[] = [
  source(1, {
    itemId: MATERIAL.leather.id,
    item: MATERIAL.leather,
    itemColourId: BLACK.id,
    colour: BLACK,
    supplierArticleCode: 'CD-NAP12',
    supplierColourCode: 'NERO-01',
    description: 'Nappa pieno fiore 1,2 mm',
    purchaseUom: 'HIDE',
    purchaseFactor: '52.5',
    unitPrice: '126.000000',
    minOrderQty: '20',
    orderMultiple: '10',
    leadTimeDays: 21,
    preference: 'PRIMARY',
    lastPurchase: { purchaseOrderId: uid('8181', 7), number: 'PO-2026-0007', status: 'CONFIRMED', orderDate: '2026-10-12', quantity: '40', uom: 'HIDE', unitPrice: '125.500000', currency: 'EUR' },
  }),
  source(2, {
    itemId: MATERIAL.leather.id,
    item: MATERIAL.leather,
    companyId: null,
    company: null,
    supplierArticleCode: 'CD-NAP12-X',
    purchaseUom: 'FT2',
    unitPrice: '2.450000',
  }),
  source(3, {
    itemId: MATERIAL.cordura.id,
    item: MATERIAL.cordura,
    supplierArticleCode: 'C500-DEMO',
    purchaseUom: 'ROLL',
    purchaseFactor: '50',
    unitPrice: '410.000000',
    minOrderQty: '2',
    orderMultiple: '1',
    leadTimeDays: 10,
    preference: 'PRIMARY',
    lastPurchase: { purchaseOrderId: uid('8181', 5), number: 'PO-2026-0005', status: 'RECEIVED', orderDate: '2026-09-28', quantity: '4', uom: 'ROLL', unitPrice: '405.000000', currency: 'EUR' },
  }),
  source(4, { itemId: MATERIAL.lining.id, item: MATERIAL.lining, supplierArticleCode: 'MESH-3D', purchaseUom: 'ROLL', purchaseFactor: '40', unitUsable: false, unitPrice: '180.000000', leadTimeDays: 7 }),
  source(5, { itemId: MATERIAL.thread.id, item: MATERIAL.thread, supplierArticleCode: 'TH40', purchaseUom: 'CONE', purchaseFactor: '5000', unitPrice: '3.900000', status: 'ARCHIVED', note: 'Replaced by a thread mill.' }),
]
export const ACTIVE_SOURCES = SOURCES.filter((row) => row.status === 'ACTIVE')

/** A source as a person without the cost grain receives it: no price, no last purchase price (the API drops them). */
export const withoutCost = (rows: readonly Source[]): Source[] =>
  rows.map(({ unitPrice, lastPurchase, ...rest }) => (void unitPrice, { ...rest, lastPurchase: lastPurchase ? (({ unitPrice: _price, ...last }) => last)(lastPurchase) : null }))

/** The material record's Supplier prices: every approved supplier of DEMO-PL-NAP12 (its id in the materials demo). */
export function materialSources(itemId: string): Source[] {
  const item = { ...MATERIAL.leather, id: itemId }
  return [
    { ...SOURCES[0]!, itemId, item },
    { ...SOURCES[1]!, itemId, item },
    source(11, {
      itemId,
      item,
      partyId: OTHERS.second.id,
      supplier: { code: OTHERS.second.code, name: OTHERS.second.name, status: 'ACTIVE' },
      supplierArticleCode: 'CED-1200',
      purchaseUom: 'HIDE',
      purchaseFactor: '52.5',
      unitPrice: '131.500000',
      minOrderQty: '10',
      leadTimeDays: 28,
      lastPurchase: { purchaseOrderId: uid('8181', 3), number: 'PO-2026-0003', status: 'RECEIVED', orderDate: '2026-08-30', quantity: '20', uom: 'HIDE', unitPrice: '129.000000', currency: 'EUR' },
    }),
    source(12, { itemId, item, partyId: OTHERS.third.id, supplier: { code: OTHERS.third.code, name: OTHERS.third.name, status: 'ACTIVE' }, purchaseUom: 'FT2', unitPrice: null, leadTimeDays: null, supplierLeadTimeDays: null }),
  ]
}

/** The made-up material search of Add a source, and one material read whole (colours, units). */
export const MATERIAL_OPTIONS: MaterialOption[] = [
  { id: uid('4701', 2), code: 'DEMO-PL-CNG10', name: 'Pelle di canguro 1,0 mm', kind: 'LEATHER', tracking: 'HIDE', baseUom: 'FT2', purchaseUom: 'HIDE', defaultSupplier: null, requiresCrViTest: true, colourCount: 1, status: 'ACTIVE' },
  { id: uid('4701', 6), code: 'DEMO-HW-ZIP8', name: 'Zip divisibile n. 8', kind: 'HARDWARE', tracking: 'NONE', baseUom: 'PCS', purchaseUom: 'PCS', defaultSupplier: null, requiresCrViTest: false, colourCount: 1, status: 'ACTIVE' },
]
export const KANGAROO: MaterialDetail = {
  ...MATERIAL_OPTIONS[0]!,
  colours: [
    { id: uid('4702', 11), code: 'NERO', name: 'Nero', supplierColourCode: null, status: 'ACTIVE' },
    { id: uid('4702', 12), code: 'BLU', name: 'Blu notte', supplierColourCode: null, status: 'ACTIVE' },
  ],
  units: { base: { uom: 'FT2', factor: '1', fixed: true }, purchase: { uom: 'HIDE', factor: '24', fixed: false }, consumption: { uom: 'DM2', factor: '0.107639', fixed: true } },
}

export const CAN = sourcesCan(['purchasing.view', 'purchasing.sources.manage', 'money.cost', 'product.materials.view'])

/** The tab's model with Conceria Demo's sources (the Owner). */
export function sourcesModel(over: Partial<ApprovedSourcesModel> = {}): ApprovedSourcesModel {
  return {
    prefix: PREFIX,
    can: CAN,
    supplier: { id: SUPPLIER.id, name: SUPPLIER.name, companyId: null, currency: 'EUR', status: 'ACTIVE' },
    company: { id: COMPANY.id, code: COMPANY.code },
    view: 'active',
    q: '',
    read: { status: 'ready', rows: ACTIVE_SOURCES, more: false },
    cells: {},
    selected: [],
    dialog: null,
    notice: null,
    bulk: null,
    updates: 0,
    live: 'live',
    ...over,
  }
}

export const addDraft = (over: Partial<AddDraft> = {}): SourcesDialog => ({ kind: 'add', draft: { ...newAddDraft('EUR'), ...over } })
export const changed = say('notice.changed', { material: MATERIAL.leather.code })

/** The material record's section model (the Owner). */
export function pricesModel(itemId: string, over: Partial<SupplierPricesModel> = {}): SupplierPricesModel {
  return { prefix: PREFIX, can: { view: true, cost: true }, read: { status: 'ready', rows: materialSources(itemId), more: false }, defaultSupplier: { id: SUPPLIER.id, code: SUPPLIER.code, name: SUPPLIER.name }, ...over }
}

/**
 * The tab in the design index: the picked rows, the view, the dialogs and the search keep their own state, so ticking rows,
 * the header box, shift-click and x show the bulk actions as on the page; everything else stays as the case's model says.
 */
export function DesignSources({ model }: { model: ApprovedSourcesModel }) {
  const [selected, setSelected] = useState<readonly string[]>(model.selected)
  const [dialog, setDialog] = useState<SourcesDialog | null>(model.dialog)
  const [q, setQ] = useState(model.q)
  useEffect(() => setSelected(model.selected), [model.selected])
  useEffect(() => setDialog(model.dialog), [model.dialog])
  const actions: ApprovedSourcesActions = {
    onSelect: (ids) => setSelected(ids),
    onDialog: setDialog,
    onSearch: setQ,
    add: { onChange: (draft) => setDialog({ kind: 'add', draft }) },
  }
  return createElement(ApprovedSourcesView, { model: { ...model, selected, dialog, q }, actions })
}
