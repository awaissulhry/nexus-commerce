import type { Editor, EditorField, ListValue, Picklist, RecordKey, RecordType } from './api'

/**
 * Made-up data of Admin › Fields & lists (SCR-164) and of the record's custom-fields section (SCR-520), for the design
 * cases and the tests (PLAN §3.1): invented lists, fields, companies and records — never a real customer, supplier,
 * person or number.
 */

export const DEMO_NOW = Date.parse('2026-11-14T09:30:00Z')
export const DEMO_READ_AT = '2026-11-14T09:29:40Z'
export const DEMO_COMPANY = '0190f0e2-4310-7000-8000-000000000001'
export const DEMO_COMPANIES = [
  { id: DEMO_COMPANY, name: 'Pelletteria Demo' },
  { id: '0190f0e2-4310-7000-8000-000000000002', name: 'Demo Outlet' },
] as const

const id = (n: number) => `0190f0e2-4310-7000-8000-${String(n).padStart(12, '0')}`

const RECORD_WORDS: Readonly<Record<RecordKey, [string, string, string, string]>> = {
  CUSTOMER: ['Party', 'Cliente', 'Customer', 'sales.customers'],
  SUPPLIER: ['Party', 'Fornitore', 'Supplier', 'purchasing.suppliers'],
  QUOTE: ['Quote', 'Preventivo', 'Quote', 'sales.quotes'],
  ORDER: ['SalesOrder', 'Ordine', 'Order', 'sales.orders'],
  STYLE: ['Style', 'Modello', 'Style', 'products.styles'],
  MATERIAL: ['Item', 'Materiale', 'Material', 'products.materials'],
  PURCHASE_ORDER: ['PurchaseOrder', 'Ordine di acquisto', 'Purchase order', 'purchasing.orders'],
  LOT: ['Lot', 'Lotto', 'Lot', 'warehouse.lots'],
  WORK_ORDER: ['WorkOrder', 'Ordine di lavoro', 'Work order', 'production.work-orders'],
}

const COUNTS: Partial<Record<RecordKey, number>> = { CUSTOMER: 2, SUPPLIER: 2, ORDER: 10, STYLE: 1 }

export const DEMO_RECORDS: RecordType[] = (Object.keys(RECORD_WORDS) as RecordKey[]).map((key) => {
  const [model, labelIt, labelEn, listKey] = RECORD_WORDS[key]
  return {
    key,
    model,
    labelIt,
    labelEn,
    fieldCount: COUNTS[key] ?? 0,
    sharedWith: key === 'CUSTOMER' ? ['SUPPLIER'] : key === 'SUPPLIER' ? ['CUSTOMER'] : [],
    listKey,
    importer: `fields.${key.toLowerCase()}`,
  }
})

const value = (n: number, code: string, labelIt: string, labelEn: string, sortOrder: number, extra: Partial<ListValue> = {}): ListValue => ({
  id: id(n),
  code,
  labelIt,
  labelEn,
  colour: null,
  icon: null,
  sortOrder,
  description: null,
  active: true,
  version: 1,
  ...extra,
})

export const DEMO_BOX: Picklist = {
  id: id(101),
  companyId: null,
  code: 'box_type',
  labelIt: 'Tipo di scatola',
  labelEn: 'Box type',
  status: 'ACTIVE',
  version: 3,
  fieldCount: 1,
  values: [
    value(111, 'PLAIN', 'Semplice', 'Plain', 10, { colour: '#1f6fde', icon: 'box', description: 'The standard brown box.' }),
    value(112, 'WOODEN', 'Legno', 'Wooden', 20, { colour: '#8d6e63', icon: 'package' }),
    value(113, 'GIFT', 'Regalo', 'Gift', 30, { colour: '#c026d3', icon: 'gift', active: false, version: 2, description: 'No longer offered: kept on older orders.' }),
  ],
}

export const DEMO_WINDOWS: Picklist = {
  id: id(102),
  companyId: DEMO_COMPANY,
  code: 'delivery_window',
  labelIt: 'Fascia di consegna',
  labelEn: 'Delivery window',
  status: 'ACTIVE',
  version: 1,
  fieldCount: 1,
  values: [value(121, 'MORNING', 'Mattina', 'Morning', 10, { icon: 'sun', colour: '#b87503' }), value(122, 'AFTERNOON', 'Pomeriggio', 'Afternoon', 20, { icon: 'clock' })],
}

export const DEMO_GRADES: Picklist = {
  id: id(103),
  companyId: null,
  code: 'leather_grade',
  labelIt: 'Qualità della pelle',
  labelEn: 'Leather grade',
  status: 'ARCHIVED',
  version: 4,
  fieldCount: 0,
  values: [value(131, 'A', 'Prima scelta', 'First choice', 10, { icon: 'award' }), value(132, 'B', 'Seconda scelta', 'Second choice', 20)],
}

export const DEMO_PICKLISTS: Picklist[] = [DEMO_BOX, DEMO_WINDOWS, DEMO_GRADES]

const listOf = (list: Picklist) => ({ id: list.id, code: list.code, labelIt: list.labelIt, labelEn: list.labelEn, values: list.values })

let place = 0
const field = (n: number, code: string, type: EditorField['type'], labelIt: string, labelEn: string, section: string, extra: Partial<EditorField> = {}): EditorField => {
  place += 10
  const grain = extra.grain ?? null
  return {
    id: id(n),
    companyId: null,
    code,
    columnId: grain ? `cf:${grain}:${code}` : `cf:${code}`,
    type,
    labelIt,
    labelEn,
    section,
    sortOrder: place,
    required: false,
    unit: null,
    audience: 'INTERNAL',
    grain: null,
    shownInPortal: false,
    status: 'ACTIVE',
    version: 1,
    picklist: null,
    linkTo: null,
    linkRecordType: null,
    valueCount: 0,
    createdAt: '2026-10-02T08:00:00Z',
    updatedAt: '2026-11-10T15:12:00Z',
    ...extra,
  }
}

/** The fields of Orders: one of every type, three sections, one archived. */
export const DEMO_ORDER_FIELDS: EditorField[] = [
  field(201, 'box_type', 'SELECT', 'Tipo di scatola', 'Box type', 'packing', { required: true, shownInPortal: true, picklist: listOf(DEMO_BOX), valueCount: 12, version: 3 }),
  field(202, 'gift_note', 'TEXT', 'Biglietto', 'Gift note', 'packing', { valueCount: 3 }),
  field(203, 'carton_weight', 'NUMBER', 'Peso del cartone', 'Carton weight', 'packing', { unit: 'kg', valueCount: 7 }),
  field(204, 'lining_wanted', 'YES_NO', 'Fodera richiesta', 'Lining wanted', 'packing', { valueCount: 9 }),
  field(205, 'fair_date', 'DATE', 'Data della fiera', 'Fair date', 'terms', { valueCount: 4 }),
  field(206, 'agreed_discount', 'MONEY', 'Sconto concordato', 'Agreed discount', 'terms', { audience: 'MONEY', grain: 'price', shownInPortal: true, valueCount: 5 }),
  field(207, 'delivery_windows', 'MULTI_SELECT', 'Fasce di consegna', 'Delivery windows', 'terms', { picklist: listOf(DEMO_WINDOWS), companyId: DEMO_COMPANY, valueCount: 2 }),
  field(208, 'reference_style', 'LINK', 'Modello di riferimento', 'Reference style', 'custom', { linkTo: 'Style', linkRecordType: 'STYLE', valueCount: 6 }),
  field(209, 'signed_copy', 'FILE', 'Copia firmata', 'Signed copy', 'custom', { valueCount: 1 }),
  field(210, 'buyer_mobile', 'TEXT', 'Cellulare del compratore', 'Buyer mobile', 'custom', { audience: 'PERSONAL', valueCount: 2 }),
  field(211, 'old_route', 'TEXT', 'Vecchio percorso', 'Old route', 'custom', { status: 'ARCHIVED', valueCount: 14, version: 2 }),
]

export const DEMO_CUSTOMER_FIELDS: EditorField[] = [
  field(221, 'fair_stand', 'TEXT', 'Stand in fiera', 'Fair stand', 'custom', { valueCount: 8 }),
  field(222, 'credit_note', 'TEXT', 'Nota sul credito', 'Credit note', 'custom', { valueCount: 1 }),
]

export function demoEditor(overrides: Partial<Editor> = {}): Editor {
  return {
    records: DEMO_RECORDS,
    recordType: 'ORDER',
    fields: DEMO_ORDER_FIELDS,
    picklists: DEMO_PICKLISTS,
    canManage: true,
    ...overrides,
  }
}
