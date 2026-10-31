import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { Backorder, Ddt, DdtPreview, DdtRow, Documents, Evidence, EvidencePaper, EvidenceStatus, Freight, Labels, PackingListVersion, Parcel, ReadyOrder, Shipment, ShipmentLine, ShipmentRow, ShipmentStatus, Tracking, Voided } from '../api'
import { abilitiesOf, type ShippingAbilities } from '../model'

/**
 * Made-up shipments for the design cases of SCR-066 and SCR-067 (B-W1-46 … 49 part 2): an invented company and site
 * ("Stabilimento Demo"), customers ("Moto Demo S.r.l.", "Esempio Racing S.p.A.", "Squadra Fittizia S.r.l."), style
 * "DEMO-JKT-01" in "Nero", sizes 50 / 52 / 54, batches, DDT numbers, tracking numbers and e-mail addresses that are all
 * made up. Nothing here is a real company, person, order or number. Design-only (only fixtures and tests import it); it
 * exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-29'
export const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const uid = (block: string, n: number) => `0190f0e3-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id
export const SITE = uid('5100', 1)

// ---- roles -----------------------------------------------------------------------------------------------------------------

const COMMON = ['home.view', 'threads.read', 'threads.post', 'files.read', 'files.upload']
const SHIPPING_ALL = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'shipping.labels.void', 'print.view', 'print.labels', 'print.documents']
/** B-W2a-48 templates (SHIPPING_DAILY_ADDS): finance the freight and the evidence, the warehouse the evidence; the owner both. */
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...COMMON, ...SHIPPING_ALL, 'shipping.freight.manage', 'shipping.evidence.manage', 'orders.view', 'orders.manage', 'workorders.view', 'invoices.view', 'money.price', 'money.cost', 'money.margin'],
  warehouse: [...COMMON, ...SHIPPING_ALL, 'shipping.evidence.manage', 'orders.view', 'workorders.view', 'inventory.stock.view'],
  /** Sales follows its orders' shipments read-only (shipping.view). */
  sales: [...COMMON, 'shipping.view', 'orders.view', 'orders.manage', 'parties.view', 'money.price', 'money.margin'],
  finance: [...COMMON, 'shipping.view', 'shipping.freight.manage', 'shipping.evidence.manage', 'orders.view', 'invoices.view', 'payments.view', 'money.price', 'money.cost'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): ShippingAbilities => abilitiesOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'warehouse'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- the list ---------------------------------------------------------------------------------------------------------------

const PARTIES = [
  { id: uid('6600', 1), name: 'Moto Demo S.r.l.', city: 'Milano' },
  { id: uid('6600', 2), name: 'Esempio Racing S.p.A.', city: 'Bologna' },
  { id: uid('6600', 3), name: 'Squadra Fittizia S.r.l.', city: 'Torino' },
]

export const row = (n: number, status: ShipmentStatus, extra: Partial<ShipmentRow> = {}): ShipmentRow => {
  const party = PARTIES[n % PARTIES.length]!
  const packed = status !== 'DRAFT' && status !== 'CANCELLED'
  const left = status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED'
  return {
    id: uid('5200', n),
    number: `SH-${String(140 + n).padStart(5, '0')}`,
    status,
    version: 3,
    companyId: COMPANY,
    siteId: SITE,
    partyId: party.id,
    partyName: party.name,
    salesOrderId: uid('5150', n),
    salesOrderNumber: `SO-2026-${String(80 + n).padStart(4, '0')}`,
    transportBy: 'CARRIER',
    carrierCode: n % 3 === 0 ? 'gls' : 'brt',
    carrierName: n % 3 === 0 ? 'GLS' : 'BRT',
    serviceCode: n % 3 === 0 ? 'gls:business' : 'brt:express',
    shipTo: { city: party.city, country: 'IT' },
    lines: 3,
    garments: 8,
    parcels: 2,
    grossWeightKg: packed ? '14.6000' : null,
    labelled: left ? 2 : 0,
    trackingNumbers: left ? [`DEMO${n}00451`, `DEMO${n}00452`] : [],
    ddt: packed && (left || n % 2 === 0) ? { id: uid('5300', n), number: `${150 + n}/2026` } : null,
    packedAt: packed ? at(28, 15, 10) : null,
    shippedAt: left ? at(28, 16, 5) : null,
    cancelledAt: status === 'CANCELLED' ? at(27, 11) : null,
    createdAt: at(27, 9, 30),
    // B-W2a-48: the rule's freight is set when the goods leave (2 parcels × 7,00 €); the evidence only for an EU sale.
    freightCharge: left ? 1400 : null,
    currency: 'EUR',
    transportEvidence: 'NOT_NEEDED',
    ...extra,
  }
}

/** A role's rows: without the price grain the API sends no freight amount at all (the field is absent). */
export const rowsFor = (rows: readonly ShipmentRow[], role: Role): ShipmentRow[] =>
  canOf(role).price
    ? [...rows]
    : rows.map((entry) => {
        const { freightCharge: _hidden, ...rest } = entry
        return rest as ShipmentRow
      })

/** The ship-today queue: two to pack, one packed waiting for its DDT, one waiting for labels, one ready to hand over, one by own van. */
export const OPEN_ROWS: ShipmentRow[] = [
  row(1, 'DRAFT', { parcels: 0, grossWeightKg: null }),
  row(2, 'DRAFT', { parcels: 1, grossWeightKg: null, garments: 4, lines: 2 }),
  row(3, 'PACKED', { ddt: null }),
  row(4, 'PACKED', { labelled: 0 }),
  row(6, 'PACKED', { labelled: 2, trackingNumbers: ['DEMO600451', 'DEMO600452'] }),
  row(7, 'PACKED', { transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null, ddt: { id: uid('5300', 7), number: '157/2026' } }),
]
export const LEFT_ROWS: ShipmentRow[] = [
  row(8, 'SHIPPED', { shipTo: { city: 'München', country: 'DE' }, transportEvidence: 'AWAITED' }),
  row(9, 'SHIPPED', { freightCharge: 900 }),
  row(10, 'DELIVERED', { shipTo: { city: 'Lyon', country: 'FR' }, transportEvidence: 'PARTIAL', freightCharge: 0 }),
  row(11, 'RETURNED'),
  row(12, 'CANCELLED', { grossWeightKg: null, ddt: null, parcels: 0, freightCharge: null }),
]
export const ALL_ROWS = [...OPEN_ROWS, ...LEFT_ROWS]

// ---- a shipment -------------------------------------------------------------------------------------------------------------------

const SHIPMENT_ID = uid('5200', 20)
const P1 = uid('5400', 1)
const P2 = uid('5400', 2)

const line = (n: number, size: string, quantity: number, parcelId: string | null, extra: Partial<ShipmentLine> = {}): ShipmentLine => ({
  id: uid('5500', n),
  version: 2,
  parcelId,
  workOrderId: uid('5600', 1),
  workOrderNumber: 'WO-DEMO-0042',
  batchNumber: 'B-DEMO-26-041',
  workOrderSizeId: uid('5700', n),
  salesOrderLineId: uid('5800', 1),
  styleId: uid('5900', 1),
  styleCode: 'DEMO-JKT-01',
  styleName: 'Giacca moto Demo',
  colourwayId: uid('5910', 1),
  colourwayCode: 'BLK',
  colourwayName: 'Nero',
  size,
  quantity,
  serialTracked: false,
  serials: [],
  ...extra,
})

const parcel = (n: number, id: string, garments: number, extra: Partial<Parcel> = {}): Parcel => ({ id, version: 2, seq: n, grossWeightKg: '7.3000', lengthCm: '60.00', widthCm: '40.00', heightCm: '30.00', trackingNumber: null, labelledAt: null, garments, ...extra })

export function shipment(status: ShipmentStatus, extra: Partial<Shipment> = {}): Shipment {
  const packed = status !== 'DRAFT'
  return {
    id: SHIPMENT_ID,
    number: 'SH-00160',
    status,
    version: 5,
    companyId: COMPANY,
    siteId: SITE,
    partyId: PARTIES[0]!.id,
    party: { code: 'C-DEMO-01', legalName: PARTIES[0]!.name },
    salesOrderId: uid('5150', 20),
    salesOrder: { number: 'SO-2026-0088', customerRef: 'PO-MD-7731', status: status === 'DRAFT' || status === 'PACKED' ? 'READY' : 'SHIPPED' },
    shipToAddressId: uid('6610', 1),
    shipTo: { name: 'Magazzino Moto Demo', line1: 'Via del Deposito 12', postalCode: '20142', city: 'Milano', province: 'MI', country: 'IT' },
    transportBy: 'CARRIER',
    carrierCode: 'brt',
    carrierName: 'BRT',
    serviceCode: 'brt:express',
    ddtRequired: true,
    packedAt: packed ? at(29, 10, 20) : null,
    shippedAt: status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED' ? at(29, 16, 5) : null,
    deliveredAt: status === 'DELIVERED' ? at(30, 11, 42) : null,
    returnedAt: status === 'RETURNED' ? at(31, 9, 10) : null,
    cancelledAt: status === 'CANCELLED' ? at(29, 12) : null,
    cancelReason: status === 'CANCELLED' ? 'The customer moved the delivery to next month' : null,
    internalNote: null,
    createdAt: at(28, 9, 30),
    updatedAt: at(29, 10, 20),
    lines: [line(1, '50', 2, P1), line(2, '52', 4, packed ? P1 : P2), line(3, '54', 2, P2)],
    parcels: [parcel(1, P1, packed ? 6 : 2), parcel(2, P2, packed ? 2 : 6, { grossWeightKg: packed ? '3.1000' : null })],
    garments: 8,
    packingProblems: packed ? [] : ['every parcel weighed (parcel 2 not weighed)'],
    freight: freight(status === 'SHIPPED' || status === 'DELIVERED' || status === 'RETURNED' ? 1400 : null),
    transportEvidence: { status: 'NOT_NEEDED', completedAt: null },
    ...extra,
  }
}

/** B-W2a-48: the freight as the API answers it (the rule: 7,00 € per parcel, 2 parcels). */
export function freight(charge: number | null, over: Partial<Freight> = {}): Freight {
  return { charge, currency: 'EUR', byHand: false, byRule: { charge: 1400, basis: 'PER_PARCEL', words: '' }, ...over }
}

/** A role's shipment: without the price grain the freight's amounts are absent (never 0). */
export function pricedFor(value: Shipment, role: Role): Shipment {
  if (canOf(role).price) return value
  const { charge: _charge, ...rest } = value.freight
  const { charge: _rule, ...rule } = rest.byRule
  return { ...value, freight: { ...rest, byRule: rule } as Freight }
}

/** A DRAFT still being packed: two garments of size 54 are in no carton yet. */
export const draftLoose = (): Shipment =>
  shipment('DRAFT', {
    lines: [line(1, '50', 2, P1), line(2, '52', 4, P1), line(3, '54', 2, null)],
    parcels: [parcel(1, P1, 6), parcel(2, P2, 0, { grossWeightKg: null })],
    packingProblems: ['every garment in a parcel (2 not packed)', 'every parcel weighed (parcel 2 not weighed)', 'garments in every parcel (parcel 2 is empty: remove it)'],
  })

export const labelled = (status: ShipmentStatus): Shipment => {
  const value = shipment(status)
  return { ...value, parcels: value.parcels.map((entry, index) => ({ ...entry, trackingNumber: `DEMO2000045${index + 1}`, labelledAt: at(29, 11, 5 + index) })) }
}

export const serialShipment = (): Shipment =>
  shipment('DRAFT', {
    lines: [line(1, '52', 2, P1, { serialTracked: true, serials: [{ id: uid('5510', 1), serial: 'SN-DM-0001A7-K' }, { id: uid('5510', 2), serial: 'SN-DM-0001A8-M' }] })],
    parcels: [parcel(1, P1, 2)],
    garments: 2,
    packingProblems: [],
  })

export const ownVan = (status: ShipmentStatus = 'PACKED'): Shipment => shipment(status, { transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null })

// ---- the DDT ----------------------------------------------------------------------------------------------------------------------

const SENDER = { name: 'Demo Pelletteria S.r.l.', address: { line1: 'Via dell’Industria 1', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT' }, vatNumber: 'IT00000000000' }
const RECIPIENT = { name: 'Moto Demo S.r.l.', address: { line1: 'Via del Cliente 3', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }, vatNumber: 'IT11111111111' }

export const DRAFT_PRINTED = {
  documentDate: TODAY,
  reason: 'SALE',
  reasonText: null,
  transportBy: 'CARRIER' as const,
  carrier: { name: 'BRT' },
  startAt: at(29, 15),
  appearance: 'Scatole di cartone',
  packages: 2,
  grossWeightKg: '10.4000',
  netWeightKg: null,
  freight: 'FREE' as const,
  sender: SENDER,
  recipient: RECIPIENT,
  destination: { name: 'Magazzino Moto Demo', line1: 'Via del Deposito 12', postalCode: '20142', city: 'Milano', province: 'MI', country: 'IT' },
  lines: [
    { seq: 1, code: 'DEMO-JKT-01', description: 'Giacca moto Demo · Nero · tg. 50 · DPI cat. II EN 17092-3 AA', quantity: '2', uom: 'PZ', size: '50', batchNumber: 'B-DEMO-26-041', serials: [] },
    { seq: 2, code: 'DEMO-JKT-01', description: 'Giacca moto Demo · Nero · tg. 52 · DPI cat. II EN 17092-3 AA', quantity: '4', uom: 'PZ', size: '52', batchNumber: 'B-DEMO-26-041', serials: [] },
    { seq: 3, code: 'DEMO-JKT-01', description: 'Giacca moto Demo · Nero · tg. 54 · DPI cat. II EN 17092-3 AA', quantity: '2', uom: 'PZ', size: '54', batchNumber: 'B-DEMO-26-041', serials: [] },
  ],
  documentRefs: [
    { kind: 'SALES_ORDER', number: 'SO-2026-0088', date: '2026-10-20' },
    { kind: 'CUSTOMER_ORDER', number: 'PO-MD-7731', date: null },
  ],
  remarks: null,
}

export const PREVIEW_OK: DdtPreview = { draft: DRAFT_PRINTED, problems: [], expectedNumber: '158/2026', language: 'it' }
export const PREVIEW_HELD: DdtPreview = {
  draft: DRAFT_PRINTED,
  problems: [
    { path: 'shipment/status', message: 'The shipment is DRAFT: a DDT is issued once it is PACKED.' },
    { path: 'company/reaNumber', message: 'The company has no REA number: add it in Admin › Companies (c.c. art. 2250).' },
  ],
  expectedNumber: '158/2026',
  language: 'it',
}

export const DDT_ID = uid('5300', 20)
export const DDT_LIVE: Ddt = { id: DDT_ID, number: '158/2026', status: 'LIVE', ...DRAFT_PRINTED, shipmentId: SHIPMENT_ID, shipmentNumber: 'SH-00160', issuedAt: at(29, 10, 40), cancellation: null, fileId: uid('5310', 1) }
export const DDT_ROW: DdtRow = { id: DDT_ID, number: '158/2026', documentDate: TODAY, status: 'LIVE', issuedAt: at(29, 10, 40), cancelledAt: null, fileId: uid('5310', 1) }
export const DDT_ANNULLED: DdtRow = { id: uid('5300', 21), number: '155/2026', documentDate: '2026-10-28', status: 'CANCELLED', issuedAt: at(28, 17), cancelledAt: at(29, 9, 15), fileId: uid('5310', 2) }

export const PDF = samplePdf(['DDT 158/2026', 'Demo Pelletteria S.r.l. → Moto Demo S.r.l.', 'Giacca moto Demo · 8 PZ · 2 colli · 10,4 kg'])
export const SAMPLE_PDF = samplePdf(['ESEMPIO / SAMPLE', 'DDT — bozza', 'Giacca moto Demo · 8 PZ · 2 colli'])

// ---- labels, tracking, documents ------------------------------------------------------------------------------------------------

export function labels(value: Shipment, print: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED' | null = null): Labels {
  return {
    labelPrinterId: uid('5320', 1),
    cutOff: { time: '17:00', at: at(29, 16), passed: false },
    toLabel: value.parcels.filter((entry) => !entry.trackingNumber).length,
    parcels: value.parcels.map((entry) => ({
      parcelId: entry.id,
      seq: entry.seq,
      version: entry.version,
      grossWeightKg: entry.grossWeightKg,
      trackingNumber: entry.trackingNumber,
      labelledAt: entry.labelledAt,
      files: entry.trackingNumber ? [{ fileId: uid('5330', entry.seq), format: 'PDF' as const, name: `label-${entry.seq}.pdf` }] : [],
      print: entry.trackingNumber && print ? { jobId: uid('5340', entry.seq), status: print, createdAt: at(29, 11, 10) } : null,
    })),
  }
}

export function tracking(value: Shipment, delivered = false): Tracking {
  const [first, second] = value.parcels
  return {
    shipment: { status: value.status, carrierName: value.carrierName, shippedAt: value.shippedAt, deliveredAt: value.deliveredAt, returnedAt: value.returnedAt },
    parcels: value.parcels.map((entry) => ({ parcelId: entry.id, seq: entry.seq, trackingNumber: entry.trackingNumber, labelledAt: entry.labelledAt, status: delivered ? 'DELIVERED' : 'IN_TRANSIT', lastEventAt: at(30, delivered ? 11 : 8, 42) })),
    events: [
      ...(delivered
        ? [
            { id: uid('5350', 6), parcelId: first!.id, seq: 1, status: 'DELIVERED' as const, description: 'Consegnato al destinatario', location: 'Milano', occurredAt: at(30, 11, 42), source: 'WEBHOOK' as const },
            { id: uid('5350', 5), parcelId: second!.id, seq: 2, status: 'DELIVERED' as const, description: 'Consegnato al destinatario', location: 'Milano', occurredAt: at(30, 11, 40), source: 'POLL' as const },
            { id: uid('5350', 4), parcelId: first!.id, seq: 1, status: 'OUT_FOR_DELIVERY' as const, description: 'In consegna', location: 'Milano', occurredAt: at(30, 7, 50), source: 'WEBHOOK' as const },
          ]
        : []),
      { id: uid('5350', 3), parcelId: first!.id, seq: 1, status: 'IN_TRANSIT' as const, description: 'Partito dal deposito', location: 'Bologna', occurredAt: at(29, 21, 5), source: 'WEBHOOK' as const },
      { id: uid('5350', 2), parcelId: second!.id, seq: 2, status: 'IN_TRANSIT' as const, description: 'Partito dal deposito', location: 'Bologna', occurredAt: at(29, 21, 6), source: 'WEBHOOK' as const },
      { id: uid('5350', 1), parcelId: first!.id, seq: 1, status: 'LABEL_CREATED' as const, description: null, location: null, occurredAt: at(29, 11, 5), source: 'WEBHOOK' as const },
    ],
    problem: null,
  }
}

const STYLE = { id: uid('5900', 1), code: 'DEMO-JKT-01', name: 'Giacca moto Demo', revision: 2 }
const travelFile = (n: number, name: string) => ({ id: uid('5360', n), originalName: name, sizeBytes: 182_400 })

export function documents(state: 'missing' | 'onFile' | 'attached' | 'fallback', links: Documents['links'] = []): Documents {
  const doc = (kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION', n: number) => ({
    key: `${kind}:${STYLE.id}`,
    kind,
    state: state === 'missing' ? ('MISSING' as const) : state === 'attached' ? ('ATTACHED' as const) : ('ON_FILE' as const),
    byLink: true,
    style: STYLE,
    wantedLanguage: 'it',
    language: state === 'missing' ? null : state === 'fallback' && kind === 'USER_INFORMATION' ? 'en' : 'it',
    fallback: state === 'fallback' && kind === 'USER_INFORMATION',
    number: kind === 'DECLARATION_OF_CONFORMITY' ? 'DOC-DEMO-JKT-01-R2' : null,
    date: '2026-09-15',
    source: state === 'missing' ? null : travelFile(n, `${kind.toLowerCase()}.pdf`),
    copy: state === 'attached' ? travelFile(n + 10, `${kind.toLowerCase()}-copy.pdf`) : null,
    message: '',
  })
  const missing = state === 'missing'
  return {
    languages: ['it', 'en'],
    documents: [
      { key: 'DDT', kind: 'DDT', state: 'NOT_REQUIRED', byLink: true, style: null, wantedLanguage: 'it', language: 'it', fallback: false, number: null, date: null, source: null, copy: null, message: '' },
      doc('DECLARATION_OF_CONFORMITY', 1),
      doc('USER_INFORMATION', 2),
      { key: 'PACKING_LIST', kind: 'PACKING_LIST', state: 'ON_FILE', byLink: false, style: null, wantedLanguage: 'it', language: 'it', fallback: false, number: null, date: null, source: null, copy: null, message: '' },
    ],
    checks: [],
    blockers: missing
      ? [
          { code: 'DECLARATION_OF_CONFORMITY', state: 'BLOCKED', blocks: ['SHIPPING'], message: 'DEMO-JKT-01 has no issued Declaration of Conformity in Italian, English or Italian for revision 2.', problems: [] },
          { code: 'USER_INFORMATION', state: 'BLOCKED', blocks: ['SHIPPING'], message: 'DEMO-JKT-01 has no user information for revision 2.', problems: [] },
        ]
      : [],
    warnings: state === 'fallback' ? [{ path: 'documents/USER_INFORMATION/DEMO-JKT-01', message: 'The user information of DEMO-JKT-01 travels in English: the order is in Italian.' }] : [],
    counts: { attached: state === 'attached' ? 2 : 0, toAttach: state === 'onFile' || state === 'fallback' ? 2 : 0, missing: missing ? 2 : 0 },
    recipients: [
      { contactId: uid('6620', 1), name: 'Anna Esempio', email: 'ordini@moto-demo.example.com' },
      { contactId: uid('6620', 2), name: 'Bruno Qualità', email: 'qualita@moto-demo.example.com' },
    ],
    links,
  }
}

export const LINKS: Documents['links'] = [
  { id: uid('5370', 1), email: 'ordini@moto-demo.example.com', state: 'LIVE', expiresAt: '2027-10-29T16:05:00.000Z', maxUses: 100, uses: 3, lastUsedAt: at(30, 9, 12), revokedAt: null, createdAt: at(29, 16, 6), automatic: true },
  { id: uid('5370', 2), email: 'qualita@moto-demo.example.com', state: 'REVOKED', expiresAt: '2027-10-29T16:05:00.000Z', maxUses: 100, uses: 0, lastUsedAt: null, revokedAt: at(30, 10), createdAt: at(29, 16, 6), automatic: true },
]

// ---- New shipment: what can still ship ------------------------------------------------------------------------------------------

const cell = (n: number, size: string, shippable: number, extra: Partial<ReadyOrder['cells'][number]> = {}) => ({
  workOrderSizeId: uid('5700', 30 + n),
  workOrderId: uid('5600', 2),
  workOrderNumber: 'WO-DEMO-0051',
  batchNumber: 'B-DEMO-26-052',
  siteId: SITE,
  salesOrderLineId: uid('5800', 2),
  lineSeq: 1,
  styleCode: 'DEMO-JKT-01',
  styleName: 'Giacca moto Demo',
  colourwayCode: 'BLK',
  colourwayName: 'Nero',
  size,
  pieces: shippable + 2,
  released: shippable + 1,
  reversed: 0,
  onShipments: 1,
  shippable,
  serialTracked: false,
  ...extra,
})

export const READY: ReadyOrder[] = [
  { salesOrderId: uid('5150', 30), number: 'SO-2026-0091', customerRef: 'PO-ER-552', status: 'IN_PRODUCTION', companyId: COMPANY, partyId: PARTIES[1]!.id, party: { code: 'C-DEMO-02', legalName: PARTIES[1]!.name }, cells: [cell(1, '50', 3), cell(2, '52', 5), cell(3, '54', 2)] },
  { salesOrderId: uid('5150', 31), number: 'SO-2026-0093', customerRef: null, status: 'READY', companyId: COMPANY, partyId: PARTIES[2]!.id, party: { code: 'C-DEMO-03', legalName: PARTIES[2]!.name }, cells: [cell(4, '48', 4, { styleCode: 'DEMO-PNT-02', styleName: 'Pantalone Demo', serialTracked: true })] },
]

// ---- the record panels on a shipment ---------------------------------------------------------------------------------------------

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

export function panelsModel(): RecordPanelsViewModel {
  return { ...conversation, record: { type: 'Shipment', id: SHIPMENT_ID, companyId: COMPANY, siteId: SITE }, title: 'SH-00160 · Moto Demo S.r.l.', party: null }
}

// ---- B-W2a-71 (every day): the backorder, the packing list's versions, the evidence, a void's outcome ----------------------

const size = (name: string, ordered: number, shipped: number, open: number, thisShipment: number, netReleased: number) => {
  const backorder = Math.max(0, ordered - shipped - open - thisShipment)
  const readyNow = Math.min(backorder, Math.max(0, netReleased - shipped - open - thisShipment))
  return { size: name, ordered, closedShort: false, closed: 0, shipped, open, thisShipment, netReleased, onShipments: shipped + open + thisShipment, backorder, readyNow, inProduction: backorder - readyNow }
}

const totalsOf = (sizes: ReturnType<typeof size>[]) => {
  const sum = (pick: (entry: ReturnType<typeof size>) => number) => sizes.reduce((total, entry) => total + pick(entry), 0)
  return { ordered: sum((e) => e.ordered), closed: sum((e) => e.closed), shipped: sum((e) => e.shipped), open: sum((e) => e.open), thisShipment: sum((e) => e.thisShipment), backorder: sum((e) => e.backorder), readyNow: sum((e) => e.readyNow), inProduction: sum((e) => e.inProduction) }
}

/** SO-2026-0088 on SH-00160: partial (2 still to ship: 1 released and ready, 1 still to make), complete, or a line closed short. */
export function backorder(kind: 'partial' | 'complete' | 'closed' = 'partial'): Backorder {
  const jackets = kind === 'partial' ? [size('50', 4, 1, 0, 2, 4), size('52', 6, 2, 0, 4, 6), size('54', 3, 0, 0, 2, 2)] : [size('50', 3, 1, 0, 2, 3), size('52', 6, 2, 0, 4, 6), size('54', 2, 0, 0, 2, 2)]
  const lines: Backorder['lines'] = [
    { lineId: uid('5800', 1), seq: 10, styleCode: 'DEMO-JKT-01', styleName: 'Giacca moto Demo', colourwayCode: 'BLK', colourwayName: 'Nero', closedShort: false, closeShortReason: null, sizes: jackets, totals: totalsOf(jackets) },
  ]
  if (kind === 'closed') {
    const pants = [{ ...size('48', 2, 0, 0, 0, 0), closedShort: true, closed: 2, backorder: 0, readyNow: 0, inProduction: 0 }]
    lines.push({ lineId: uid('5800', 2), seq: 20, styleCode: 'DEMO-PNT-02', styleName: 'Pantalone Demo', colourwayCode: 'BLK', colourwayName: 'Nero', closedShort: true, closeShortReason: 'Il cliente non li vuole più', sizes: pants, totals: totalsOf(pants) })
  }
  const all = lines.flatMap((line) => line.sizes)
  return {
    order: { salesOrderId: uid('5150', 20), number: 'SO-2026-0088', status: 'PARTLY_SHIPPED', customerRef: 'PO-MD-7731', promiseDate: '2026-11-06' },
    shipmentId: SHIPMENT_ID,
    lines,
    totals: totalsOf(all),
    shipments: [
      { id: uid('5200', 19), number: 'SH-00152', status: 'DELIVERED', shippedAt: at(20, 15) },
      { id: SHIPMENT_ID, number: 'SH-00160', status: 'PACKED', shippedAt: null },
    ],
  }
}

export const PACKING_LISTS: PackingListVersion[] = [
  { fileId: uid('5380', 2), version: 2, number: 'SH-00160/2', language: 'it', current: true, parcels: 2, garments: 8, createdAt: at(29, 10, 25) },
  { fileId: uid('5380', 1), version: 1, number: 'SH-00160/1', language: 'it', current: false, parcels: 2, garments: 7, createdAt: at(29, 9, 50) },
]

const paper = (n: number, kind: EvidencePaper['kind'], name: string, day: number): EvidencePaper => ({ fileId: uid('5390', n), kind, originalName: name, contentType: 'application/pdf', sizeBytes: 148_000 + n * 9_000, status: 'AVAILABLE', createdAt: at(day, 9, 30, 11) })

/** The intra-EU transport evidence of SH-00160 when it goes to Germany (a zero-rated EU sale). */
export function evidence(status: EvidenceStatus, over: Partial<Evidence> = {}): Evidence {
  const papers = status === 'AWAITED' || status === 'NOT_NEEDED' ? [] : status === 'PARTIAL' ? [paper(1, 'POD', 'POD-DEMO20000451.pdf', 3)] : [paper(1, 'POD', 'POD-DEMO20000451.pdf', 3), paper(2, 'CMR', 'CMR-firmato-SH-00160.pdf', 4)]
  return {
    shipmentId: SHIPMENT_ID,
    number: 'SH-00160',
    shipmentStatus: 'DELIVERED',
    version: 9,
    status,
    completedAt: status === 'COMPLETE' ? at(5, 10, 0, 11) : null,
    completedById: status === 'COMPLETE' ? uid('6630', 1) : null,
    note: status === 'COMPLETE' ? 'POD del corriere e CMR firmato dal destinatario: coerenti.' : null,
    neededBySale: status !== 'NOT_NEEDED',
    papers,
    ...over,
  }
}

/** SH-00160 gone to Germany (Germany: a zero-rated intra-EU sale). */
export const toGermany = (status: ShipmentStatus, evidenceStatus: EvidenceStatus): Shipment => {
  const value = labelled(status)
  return { ...value, shipTo: { name: 'Lager Demo GmbH', line1: 'Musterstraße 5', postalCode: '80331', city: 'München', country: 'DE' }, transportEvidence: { status: evidenceStatus, completedAt: evidenceStatus === 'COMPLETE' ? at(5, 10, 0, 11) : null } }
}

export function voidedOf(value: Shipment, keptSeq: number | null = null): Voided {
  const after = { ...value, parcels: value.parcels.map((entry) => (entry.seq === keptSeq ? entry : { ...entry, trackingNumber: null, labelledAt: null })) }
  return {
    ...labels(after),
    outcomes: value.parcels.map((entry) => (entry.seq === keptSeq ? { parcelId: entry.id, seq: entry.seq, ok: false, carrier: null, problem: 'The carrier refuses: the parcel is already in its depot.' } : { parcelId: entry.id, seq: entry.seq, ok: true, carrier: entry.seq === 1 ? ('CANCELLED' as const) : ('QUEUED' as const), problem: null })),
    problem: keptSeq ? '1 of 2 labels were voided; see each parcel.' : null,
  }
}

/** Labels bought and the carrier has none of the parcels yet (each one's latest event: label created); `collected` parcels are on their way. */
export function trackingLabelled(value: Shipment, collected: readonly number[] = []): Tracking {
  return {
    ...tracking(value),
    parcels: value.parcels.map((entry) => ({ parcelId: entry.id, seq: entry.seq, trackingNumber: entry.trackingNumber, labelledAt: entry.labelledAt, status: collected.includes(entry.seq) ? 'IN_TRANSIT' : 'LABEL_CREATED', lastEventAt: at(29, 11, 5) })),
  }
}
