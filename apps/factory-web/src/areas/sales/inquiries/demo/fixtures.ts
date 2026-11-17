import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
// B-TH-217: the reading pane's thread in the design cases (RecordThread v1 on made-up messages).
import { DEMO_NOW, demoThread, OFFICE_PEOPLE } from '../../../../lib/record-thread/demo-data'
import { RecordThread, type RecordThreadActions, type RecordThreadModel } from '../../../../lib/record-thread/RecordThread'
import { BRAND_ALPHA } from '../../../../lib/testing/two-brands'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Assignees, CatalogueRecord, IncomingList, IncomingRow, InquiryRow, InquiryView, MailDraft, PartyOption, StyleDetail, StyleOption, WaitingPage } from '../api'
import { incomingRowOf, inquiriesCan, type InquiriesCan, type ListTile } from '../model'

/**
 * Design-only made-up data of Sales › Inquiries (SCR-105 and the inquiry's full page): "Demo" customers, prospects, styles and
 * people at example.com, example numbers (INQ-DEMO-…), made-up prices and sizes. Nothing here is a real company, person,
 * mail or order.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const NOW = '2026-11-12T09:42:00.000Z'
const OTHER = '0190f0e2-3333-7000-8000-000000000002'
const THIRD = '0190f0e2-3333-7000-8000-000000000003'

/** A made-up uuid in a family. */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()

/** A role's permissions as a session holds them: its permissions and a `money.<grain>` per grain. */
const template = (key: string): string[] => {
  const role = templateOf(key)
  return [...(role?.permissions ?? []), ...(role?.grains ?? []).map((grain) => `money.${grain}`), 'home.view']
}

/** The role cases the design names: sales (answers, quotes), a reader (no change, no price), nobody. */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...template('sales'), 'sales.inquiries.view', 'sales.inquiries.manage', 'quotes.manage', 'quotes.view', 'money.price', 'parties.view', 'product.styles.view', 'threads.read', 'files.read', 'files.upload', 'email.send', 'email.triage', 'orders.manage', 'orders.view', 'product.styles.manage'], // B-TH-228: + orders, styles
  sales: template('sales'),
  reader: template('read_only'),
  warehouse: template('warehouse'),
  // B-TH-216 (B-TH-014): the production manager reads Incoming and holds none of its sales actions.
  production: template('production_manager'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): InquiriesCan => inquiriesCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- customers, styles, people -------------------------------------------------------------------------------------------

const BRAND = { id: uid('5201', 1), code: 'DEMO-BRAND', name: 'Demo Moto Brand' }
const SHOP = { id: uid('5201', 2), code: 'DEMO-SHOP', name: 'Demo Rider Shop' }

export const CUSTOMERS: PartyOption[] = [
  { id: BRAND.id, code: BRAND.code, legalName: 'Demo Moto Brand S.r.l.', tradeName: BRAND.name },
  { id: SHOP.id, code: SHOP.code, legalName: 'Demo Rider Shop', tradeName: null },
]

export const CONTACTS = [
  { id: uid('5202', 1), name: 'Bea Esempio', email: 'buyer@brand-demo.example.com', status: 'ACTIVE' },
  { id: uid('5202', 2), name: 'Carlo Prova', email: null, status: 'ACTIVE' },
]

const JACKET = { id: uid('5101', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket' }
const PANTS = { id: uid('5101', 2), code: 'DEMO-PNT-02', name: 'Demo rain trousers' }
const BLACK = { id: uid('5301', 1), code: 'BLK', name: 'Black' }
const SAND = { id: uid('5301', 2), code: 'SND', name: 'Sand' }

export const STYLE_OPTIONS: StyleOption[] = [
  { ...JACKET, sizes: ['46', '48', '50', '52', '54', '56'], status: 'ACTIVE' },
  { ...PANTS, sizes: ['S', 'M', 'L', 'XL'], status: 'ACTIVE' },
]

export const JACKET_DETAIL: StyleDetail = {
  ...STYLE_OPTIONS[0]!,
  colourways: [
    { ...BLACK, status: 'ACTIVE', offeredSizes: [] },
    { ...SAND, status: 'ACTIVE', offeredSizes: ['48', '50', '52', '54'] },
  ],
}
export const PANTS_DETAIL: StyleDetail = { ...STYLE_OPTIONS[1]!, colourways: [{ id: uid('5301', 3), code: 'NVY', name: 'Navy', status: 'ACTIVE', offeredSizes: [] }] }

export const ASSIGNEES: Assignees = {
  people: [
    { id: OTHER, name: 'Marco Demo', me: false },
    { id: ME, name: DEMO_USER.displayName, me: true },
    { id: THIRD, name: 'Lucia Prova', me: false },
  ],
  complete: true,
}

// ---- the rows ---------------------------------------------------------------------------------------------------------------

type Price = InquiryRow['targetUnitPrice']
const price = (value: string | null): Price => value as Price

function row(n: number, over: Partial<InquiryRow>): InquiryRow {
  return {
    id: uid('5401', n),
    number: `INQ-DEMO-${String(n).padStart(4, '0')}`,
    companyId: COMPANY_ID,
    source: 'PHONE',
    status: 'NEW',
    receivedAt: at(10, 8, 30),
    party: null,
    fromWords: '—',
    prospect: false,
    summary: '',
    products: [],
    pieces: 0,
    sizes: '',
    targetUnitPrice: price(null),
    currency: 'EUR',
    wantedDate: null,
    waiting: { for: 'US', workingMinutes: 60, overdue: false },
    assigneeId: null,
    assignee: null,
    mine: false,
    quote: null,
    declineReason: null,
    closedAt: null,
    version: 1,
    // B-TH-216: the Picture and Files cells.
    picture: null,
    styleCount: 0,
    fileCounts: { photos: 0, documents: 0 },
    ...over,
  }
}

// ---- B-TH-216 (Sales › Incoming): the people who keep requests (office names) and the style pictures of the rows ----
const MARCO = { id: OTHER, name: 'Marco Demo' }
const YOU = { id: ME, name: DEMO_USER.displayName }
const picture = (style: { id: string; code: string; name: string }, n: number) => ({ styleId: style.id, styleCode: style.code, styleName: style.name, fileId: uid('5801', n), contentType: 'image/webp', small: true })

/** A small made-up garment drawing as a row's picture (the page reads the store's small previews). */
const garment = (fill: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#eef1f5"/><path fill="${fill}" d="M30 18 L42 12 Q50 19 58 12 L70 18 L85 35 L77 45 L70 40 L70 87 L30 87 L30 40 L23 45 L15 35 Z"/><path stroke="#ffffff" stroke-opacity=".5" d="M50 17 V87"/></svg>`)}`

const party = (one: { id: string; code: string; name: string }) => ({ id: one.id, code: one.code, name: one.name })

export const ROWS: InquiryRow[] = [
  row(1, { source: 'PHONE', receivedAt: at(9, 14, 10), party: party(SHOP), fromWords: SHOP.name, summary: '60 rain trousers for the spring, sizes S to XL', products: [PANTS.code], pieces: 60, sizes: 'S:10 M:20 L:20 XL:10', targetUnitPrice: price('38.000000'), wantedDate: '2027-02-15', waiting: { for: 'US', workingMinutes: 620, overdue: true }, picture: picture(PANTS, 1), styleCount: 1 }),
  row(2, {
    source: 'MAIL',
    status: 'ASSIGNED',
    receivedAt: at(11, 10, 5),
    party: party(BRAND),
    fromWords: BRAND.name,
    summary: 'RFQ SS27: touring jacket in black and sand, private label',
    products: [JACKET.code, PANTS.code, 'Summer gloves with knuckle'],
    pieces: 120,
    sizes: '50:25 52:30 54:25 S:10 M:20 L:10',
    targetUnitPrice: price('145.000000'),
    wantedDate: '2027-01-20',
    waiting: { for: 'US', workingMinutes: 135, overdue: false },
    assigneeId: ME,
    assignee: YOU,
    mine: true,
    version: 3,
    picture: picture(JACKET, 2),
    styleCount: 2,
    fileCounts: { photos: 1, documents: 2 },
  }),
  row(3, { source: 'FAIR', status: 'NEED_INFO', receivedAt: at(5, 16, 0), fromWords: 'Demo Track Club', prospect: true, summary: 'Team suits for 12 riders, their own colours', products: ['One-piece track suit'], pieces: 12, waiting: { for: 'CUSTOMER', workingMinutes: 1500, overdue: false }, assigneeId: OTHER, assignee: MARCO, version: 4, fileCounts: { photos: 3, documents: 0 } }),
  row(4, { source: 'OFFICE', receivedAt: at(12, 9, 10), fromWords: 'Demo Moto Club', prospect: true, summary: 'Club jackets with an embroidered logo', products: [], pieces: 0, waiting: { for: 'US', workingMinutes: 32, overdue: false }, fileCounts: { photos: 0, documents: 1 } }),
  row(5, { source: 'PORTAL', status: 'QUOTED', receivedAt: at(3, 11, 0), party: party(BRAND), fromWords: BRAND.name, summary: 'Reorder of the AW26 jacket, 80 pieces', products: [JACKET.code], pieces: 80, sizes: '48:10 50:20 52:30 54:20', targetUnitPrice: price('139.500000'), waiting: { for: null, workingMinutes: null, overdue: false }, assigneeId: OTHER, assignee: MARCO, quote: { id: uid('5501', 12), number: 'QT-DEMO-00012' }, closedAt: at(10, 15, 0), version: 6, picture: picture(JACKET, 3), styleCount: 1 }),
  row(6, { source: 'MAIL', status: 'DECLINED', receivedAt: at(2, 9, 0), party: party(SHOP), fromWords: SHOP.name, summary: '500 promotional caps by next week', products: ['Promotional cap'], pieces: 500, waiting: { for: null, workingMinutes: null, overdue: false }, declineReason: 'NOT_OUR_PRODUCT', closedAt: at(2, 11, 0), version: 3 }),
]

/** B-TH-216: each row's small preview in the design cases (by row id). */
export const DEMO_PICTURES: Readonly<Record<string, string>> = Object.fromEntries(ROWS.filter((one) => one.picture?.small).map((one, index) => [one.id, garment(['#36506b', '#8a5a2b', '#2f6b4f'][index % 3]!)]))

// ---- B-TH-233 (Incoming over every door): a catalogue order and a change request beside the requests, the Customer replies ----

const CATALOGUE_ID = uid('5402', 1)
const CHANGE_ID = uid('5403', 1)
const ORDER = { id: uid('5502', 7), number: 'SO-DEMO-00007' }

/** A catalogue order Demo Rider Shop sent from its portal (made-up lines), waiting for the office's answer. */
export const CATALOGUE_ROW: IncomingRow = {
  key: `CATALOGUE_ORDER:${CATALOGUE_ID}`,
  kind: 'CATALOGUE_ORDER',
  id: CATALOGUE_ID,
  number: 'POR-DEMO-0003',
  companyId: COMPANY_ID,
  receivedAt: at(11, 16, 20),
  party: party(SHOP),
  fromWords: SHOP.name,
  prospect: false,
  summary: 'Reorder from the catalogue: rain trousers and touring jackets',
  pieces: 34,
  wantedDate: '2027-01-29',
  state: 'SENT',
  stateWords: { it: 'Richiesta inviata', en: 'Request sent' },
  open: true,
  waiting: { for: 'US', workingMinutes: 540, overdue: true },
  version: 2,
  opens: { place: 'INCOMING', id: CATALOGUE_ID },
  request: null,
  catalogueOrder: { status: 'SENT', source: 'REORDER', customerRef: 'SHOP-PO-118', lines: 2, styles: [PANTS.code, JACKET.code], requestedDate: '2027-01-29', decidedAt: null, salesOrder: null, quote: null },
  changeRequest: null,
}

/** A change request Demo Moto Brand asked on one of its confirmed orders: answered in Home › Approvals (agreement T3). */
export const CHANGE_ROW: IncomingRow = {
  key: `CHANGE_REQUEST:${CHANGE_ID}`,
  kind: 'CHANGE_REQUEST',
  id: CHANGE_ID,
  number: ORDER.number,
  companyId: COMPANY_ID,
  receivedAt: at(12, 8, 50),
  party: party(BRAND),
  fromWords: BRAND.name,
  prospect: false,
  summary: `Change · ${ORDER.number} · 1 line, 2 sizes`,
  pieces: null,
  wantedDate: '2027-02-10',
  state: 'OPEN',
  stateWords: { it: 'Modifica · Aperta', en: 'Change · Open' },
  open: true,
  waiting: { for: 'US', workingMinutes: 75, overdue: false },
  version: 1,
  opens: { place: 'APPROVALS', id: CHANGE_ID },
  request: null,
  catalogueOrder: null,
  changeRequest: { kind: 'CHANGE', status: 'OPEN', order: ORDER, reasonCode: null, requestedDate: '2027-02-10', lines: 1, sizes: 2, answeredAt: null },
}

/** Every row of every kind (the requests as Incoming reads them). */
export const INCOMING_ROWS: IncomingRow[] = [...ROWS.map(incomingRowOf), CATALOGUE_ROW, CHANGE_ROW]
const OPEN_KEYS = new Set(INCOMING_ROWS.filter((one) => one.open).map((one) => one.key))

const counts = (rows: readonly IncomingRow[]): Record<ListTile, number | null> => ({
  NEW: rows.filter((one) => one.state === 'NEW' || one.state === 'SENT' || one.state === 'OPEN').length,
  WAITING_US: rows.filter((one) => one.waiting.overdue).length,
  WAITING_CUSTOMER: rows.filter((one) => one.state === 'NEED_INFO').length,
  QUOTED_THIS_WEEK: 1,
  MINE: rows.filter((one) => one.request?.mine && one.open).length,
  OPEN: rows.filter((one) => one.open).length,
  QUOTED: rows.filter((one) => one.state === 'QUOTED').length,
  ORDERED: rows.filter((one) => one.state === 'ORDERED').length,
  DECLINED: rows.filter((one) => one.state === 'DECLINED' && one.request?.declineReason !== 'NOT_AN_ORDER').length,
  NOT_AN_ORDER: rows.filter((one) => one.request?.declineReason === 'NOT_AN_ORDER').length,
  LOST: 0,
  ALL: rows.length,
  CUSTOMER_REPLIES: REPLIES.length,
})

/** The list as the API answers it: the rows of a tile (requests given as their own rows are read as Incoming rows), the counts of every tile. */
export function listOf(rows: ReadonlyArray<InquiryRow | IncomingRow> = INCOMING_ROWS.filter((one) => OPEN_KEYS.has(one.key)), complete = true, next: string | null = null): IncomingList {
  const read = rows.map((one) => ('kind' in one ? one : incomingRowOf(one)))
  const kinds = { REQUEST: read.filter((one) => one.kind === 'REQUEST').length, CATALOGUE_ORDER: read.filter((one) => one.kind === 'CATALOGUE_ORDER').length, CHANGE_REQUEST: read.filter((one) => one.kind === 'CHANGE_REQUEST').length }
  return { rows: read, counts: counts(INCOMING_ROWS), kinds, next, complete }
}

/** "Customer replies": conversations on the customers' other records whose last shared message is theirs (made-up words). */
const REPLIES: WaitingPage['rows'] = [
  {
    recordType: 'SalesOrder',
    recordId: ORDER.id,
    label: ORDER.number,
    companyId: COMPANY_ID,
    party: party(BRAND),
    lastMessage: { id: uid('5901', 1), at: at(11, 17, 5), channel: 'PORTAL', authorName: 'Bea Esempio', excerpt: 'Could the sand jackets ship a week earlier? Our launch moved to 3 February.' },
    waiting: { since: at(11, 17, 5), workingMinutes: 610, calendar: true, amber: false, thresholdDays: 3 },
  },
  {
    recordType: 'Quote',
    recordId: uid('5501', 12),
    label: 'QT-DEMO-00012',
    companyId: COMPANY_ID,
    party: party(BRAND),
    lastMessage: { id: uid('5901', 2), at: at(5, 10, 0), channel: 'EMAIL', authorName: 'Bea Esempio', excerpt: 'Thanks for the quote. Is the price with or without the embroidered logo?' },
    waiting: { since: at(5, 10, 0), workingMinutes: 2400, calendar: true, amber: true, thresholdDays: 3 },
  },
  {
    recordType: 'ReturnAuthorisation',
    recordId: uid('5903', 1),
    label: 'RMA-DEMO-0002',
    companyId: COMPANY_ID,
    party: party(SHOP),
    lastMessage: { id: uid('5901', 3), at: at(12, 8, 15), channel: 'PORTAL', authorName: null, excerpt: 'Photos of the torn seam attached.' },
    waiting: { since: at(12, 8, 15), workingMinutes: 85, calendar: true, amber: false, thresholdDays: 3 },
  },
]

export const repliesOf = (rows: WaitingPage['rows'] = REPLIES, complete = true, next: string | null = null): WaitingPage => ({ rows: [...rows], count: rows.length, complete, next })

/** The catalogue order as GET /sales/order-requests/:id answers it (price grain: the shown prices). */
export const CATALOGUE_RECORD: CatalogueRecord = {
  request: {
    id: CATALOGUE_ID,
    number: CATALOGUE_ROW.number,
    status: 'SENT',
    words: { it: 'Richiesta inviata', en: 'Request sent' },
    source: 'REORDER',
    party: party(SHOP),
    customerRef: 'SHOP-PO-118',
    requestedDate: '2027-01-29',
    note: 'Same as last spring, please keep the navy trousers.',
    currency: 'EUR',
    shipTo: { id: uid('5904', 1), name: 'Demo Rider Shop · warehouse', line1: 'Via Esempio 12', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', status: 'ACTIVE', approvalStatus: 'WAITING' },
    sentAt: at(11, 16, 20),
    sentBy: 'Carlo Prova',
    decidedAt: null,
    decidedBy: null,
    refuseReason: null,
    withdrawnAt: null,
    salesOrder: null,
    quote: null,
    version: 2,
    lines: [
      { id: uid('5905', 1), seq: 10, style: PANTS, colourway: { id: uid('5301', 3), code: 'NVY', name: 'Navy' }, sizes: [{ size: 'S', quantity: 4 }, { size: 'M', quantity: 8 }, { size: 'L', quantity: 6 }, { size: 'XL', quantity: 2 }], pieces: 20, unitPriceShown: '38.000000', listPriceNow: '39.500000', amountShown: '760.000000', note: null, problems: [] },
      { id: uid('5905', 2), seq: 20, style: JACKET, colourway: SAND, sizes: [{ size: '50', quantity: 6 }, { size: '52', quantity: 8 }], pieces: 14, unitPriceShown: '145.000000', listPriceNow: '145.000000', amountShown: '2030.000000', note: null, problems: [{ code: 'SIZE_NOT_OFFERED', size: '56', words: { it: 'La taglia 56 non è più offerta in Sand', en: 'Size 56 is no longer offered in Sand' } }] },
    ],
    summary: { lines: 2, pieces: 34, netShown: '2790.000000' },
  },
  may: { order: true, quote: true, refuse: true },
}
// ---- end B-TH-233

// ---- one inquiry --------------------------------------------------------------------------------------------------------------

const file = (n: number, name: string, recordType: 'Inquiry' | 'InboundEmail', extra: Partial<InquiryView['files'][number]> = {}) => ({
  id: uid('5701', n),
  recordType,
  originalName: name,
  contentType: name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
  sizeBytes: 240_000 + n * 13_000,
  status: 'AVAILABLE',
  versionNo: 1,
  ...extra,
})

const SKETCH = file(1, 'logo-placement-sketch.jpg', 'Inquiry')
const PACK_V1 = file(2, 'demo-brand-ss27-techpack.pdf', 'InboundEmail')
const PACK_V2 = { ...PACK_V1, id: uid('5701', 3), versionNo: 2 }
const SIZE_CHART = file(4, 'demo-brand-size-chart.pdf', 'InboundEmail')

const MAIL_HTML = '<p>Hello,</p><p>for <b>SS27</b> we would like a price for the touring jacket in black and sand (private label, our logo on the chest), the rain trousers and a summer glove with knuckle armour.</p><p>Tech pack and size chart attached. Target 145 EUR for the jacket, delivery by 20 January.</p><p>Best regards,<br>Bea Esempio · Demo Moto Brand</p>'

export const VIEW: InquiryView = {
  ...ROWS[1]!,
  request: 'RFQ SS27: touring jacket in black and sand, private label\n\nFor SS27 we would like a price for the touring jacket in black and sand (private label, our logo on the chest), the rain trousers and a summer glove with knuckle armour. Target 145 EUR for the jacket, delivery by 20 January.',
  note: 'Bea prefers a call in the morning.',
  closeNote: null,
  contact: { id: CONTACTS[0]!.id, name: CONTACTS[0]!.name, email: CONTACTS[0]!.email },
  prospectDetails: null,
  assignee: { id: ME, name: DEMO_USER.displayName },
  assignedAt: at(11, 10, 30),
  lines: [
    { id: uid('5601', 1), seq: 10, style: party(JACKET), colourway: party(BLACK), colourText: null, description: 'Our logo on the chest, embroidered', sizes: { '50': 15, '52': 20, '54': 15 }, quantity: 50, note: null },
    { id: uid('5601', 2), seq: 20, style: party(JACKET), colourway: party(SAND), colourText: null, description: null, sizes: { '50': 10, '52': 10, '54': 10 }, quantity: 30, note: 'Sand only from 50' },
    { id: uid('5601', 3), seq: 30, style: party(PANTS), colourway: null, colourText: 'dark navy', description: null, sizes: {}, quantity: 20, note: null },
    { id: uid('5601', 4), seq: 40, style: null, colourway: null, colourText: 'black', description: 'Summer gloves with knuckle armour', sizes: { S: 10, M: 20, L: 10 }, quantity: 40, note: 'We have no glove style yet' },
  ],
  mail: { id: uid('5801', 1), status: 'MATCHED', receivedAt: at(11, 10, 5), from: { address: 'buyer@brand-demo.example.com', name: 'Bea Esempio' }, subject: 'RFQ SS27: touring jacket in black and sand, private label', bodyText: null, bodyHtml: MAIL_HTML, threadId: uid('5802', 1) },
  techPack: { version: 'SS27 v1', files: [{ named: PACK_V1, current: PACK_V2, newer: true }] },
  files: [SKETCH],
  mailFiles: [PACK_V1, SIZE_CHART],
  quoteDetail: null,
  closedBy: null,
  createdBy: { id: OTHER, name: 'Marco Demo' },
  createdAt: at(11, 10, 6),
  actions: {
    edit: { allowed: true, refusal: null },
    assign: { allowed: true, refusal: null },
    unassign: { allowed: true, refusal: null },
    askInfo: { allowed: true, refusal: null },
    resume: { allowed: false, refusal: { code: 'NOT_WAITING', message: 'x' } },
    decline: { allowed: true, refusal: null },
    lose: { allowed: true, refusal: null },
    quote: { allowed: true, refusal: null },
    // B-TH-228: line 30 has no colourway, line 40 no style yet → Make order held in the API's words; a style draft may be made.
    order: { allowed: false, refusal: { code: 'LINES_NOT_READY', message: 'x' } },
    styleDraft: { allowed: true, refusal: null },
  },
}

const closedActions: InquiryView['actions'] = {
  edit: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  assign: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  unassign: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  askInfo: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  resume: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  decline: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  lose: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  quote: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  // B-TH-228
  order: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
  styleDraft: { allowed: false, refusal: { code: 'CLOSED', message: 'x' } },
}

/** A prospect's inquiry from the office: nobody has it, it waits for a customer before a quote. */
export const PROSPECT_VIEW: InquiryView = {
  ...ROWS[3]!,
  request: 'Club jackets with an embroidered logo\n\nThe club president came by: about 40 jackets for the members, their logo on the back, before the season opens in March.',
  note: null,
  closeNote: null,
  contact: null,
  prospectDetails: { name: 'Gianni Esempio', company: 'Demo Moto Club', email: 'president@motoclub-demo.example.com', phone: '+39 000 000 0000', lawfulBasis: 'CONTRACT', erased: false },
  assignee: null,
  assignedAt: null,
  lines: [],
  mail: null,
  techPack: { version: null, files: [] },
  files: [],
  mailFiles: [],
  quoteDetail: null,
  closedBy: null,
  createdBy: { id: ME, name: DEMO_USER.displayName },
  createdAt: at(12, 9, 12),
  actions: { ...VIEW.actions, unassign: { allowed: false, refusal: { code: 'NOT_ASSIGNED', message: 'x' } }, quote: { allowed: false, refusal: { code: 'NEEDS_CUSTOMER', message: 'x' } }, order: { allowed: false, refusal: { code: 'NEEDS_CUSTOMER', message: 'x' } }, styleDraft: { allowed: false, refusal: { code: 'NEEDS_CUSTOMER', message: 'x' } } },
}

// ---- B-TH-228: a request whose every line is ready (a style, its colourway, pieces by size): Make order may go; a style draft made
// from another request; and the request made straight into an order (ORDERED, the order with ITS own state).
export const ORDERABLE_VIEW: InquiryView = {
  ...VIEW,
  lines: VIEW.lines.slice(0, 2).map((line, index) => ({ ...line, unitPriceShown: (index === 0 ? price('139.00') : price(null)) as InquiryView['lines'][number]['unitPriceShown'] })),
  customerRef: 'PO-DEMO-0042',
  actions: { ...VIEW.actions, order: { allowed: true, refusal: null } },
  styleDrafts: [{ id: uid('5901', 1), code: 'TJ-SS27', name: 'Touring jacket SS27', status: 'DRAFT' }],
}
// ---- end B-TH-228

/** A quoted inquiry: closed, its quote, its value (a price). */
export const QUOTED_VIEW: InquiryView = {
  ...ROWS[4]!,
  request: 'Reorder of the AW26 jacket, 80 pieces, as last season.',
  note: null,
  closeNote: null,
  contact: { id: CONTACTS[0]!.id, name: CONTACTS[0]!.name, email: CONTACTS[0]!.email },
  prospectDetails: null,
  assignee: { id: OTHER, name: 'Marco Demo' },
  assignedAt: at(3, 11, 30),
  lines: [{ id: uid('5601', 9), seq: 10, style: party(JACKET), colourway: party(BLACK), colourText: null, description: null, sizes: { '48': 10, '50': 20, '52': 30, '54': 20 }, quantity: 80, note: null }],
  mail: null,
  techPack: { version: null, files: [] },
  files: [],
  mailFiles: [],
  quoteDetail: { id: uid('5501', 12), number: 'QT-DEMO-00012', status: 'SENT', revision: 2, netAmount: 1_116_000 as never, currency: 'EUR' },
  closedBy: { id: OTHER, name: 'Marco Demo' },
  createdBy: { id: OTHER, name: 'Marco Demo' },
  createdAt: at(3, 11, 1),
  actions: closedActions,
}

/** B-TH-228: made straight into an order — the order with ITS own state (it waits for approval: never "confirmed"). */
export const ORDERED_VIEW: InquiryView = {
  ...QUOTED_VIEW,
  status: 'ORDERED',
  quote: null,
  quoteDetail: null,
  order: { id: uid('5951', 1), number: 'SO-2026-0142', status: 'PENDING_APPROVAL' },
}

/** A declined inquiry: read-only but for its note. */
export const DECLINED_VIEW: InquiryView = {
  ...ROWS[5]!,
  request: '500 promotional caps with our logo by next week.',
  note: null,
  closeNote: 'We do not make caps; suggested a promotional goods supplier.',
  contact: null,
  prospectDetails: null,
  assignee: null,
  assignedAt: null,
  lines: [{ id: uid('5601', 10), seq: 10, style: null, colourway: null, colourText: null, description: 'Promotional cap', sizes: {}, quantity: 500, note: null }],
  mail: { id: uid('5801', 2), status: 'MATCHED', receivedAt: at(2, 9, 0), from: { address: 'shop@rider-demo.example.com', name: null }, subject: 'Caps', bodyText: 'Hi, can you make 500 caps with our logo by next week?', bodyHtml: null, threadId: uid('5802', 2) },
  techPack: { version: null, files: [] },
  files: [],
  mailFiles: [],
  quoteDetail: null,
  closedBy: { id: OTHER, name: 'Marco Demo' },
  createdBy: { id: OTHER, name: 'Marco Demo' },
  createdAt: at(2, 9, 1),
  actions: closedActions,
}

/** "Make an inquiry" from a mail: the sender is a contact of the brand. */
export const MAIL_DRAFT: MailDraft = {
  inquiry: null,
  mail: { id: uid('5801', 3), status: 'TRIAGE', receivedAt: at(12, 8, 50), from: { address: 'buyer@brand-demo.example.com', name: 'Bea Esempio' }, subject: 'Price for 30 winter gloves?', bodyText: 'Hello, could you quote 30 winter gloves in black, sizes S-XL? Sketch attached. Thanks, Bea', bodyHtml: null, threadId: null },
  companyId: COMPANY_ID,
  party: party(BRAND),
  contactId: CONTACTS[0]!.id,
  matchedBy: 'CONTACT',
  prospect: null,
  request: 'Price for 30 winter gloves?\n\nHello, could you quote 30 winter gloves in black, sizes S-XL? Sketch attached. Thanks, Bea',
  attachments: [file(5, 'winter-glove-sketch.pdf', 'InboundEmail')],
  refusal: null,
}

/** The same mail once it was made into an inquiry. */
export const MAIL_TAKEN: MailDraft = { ...MAIL_DRAFT, inquiry: { id: ROWS[1]!.id, number: ROWS[1]!.number }, refusal: { code: 'MAIL_TAKEN', message: 'x' } }

// ---- the record panels of the Activity tab and of Files & specs (the panels' own made-up cases) ---------------------------------

const panelsCase = (id: string): RecordPanelsViewModel => (panelsScreen.cases.find((one) => one.id === id) ?? panelsScreen.cases[0]!).model
export const panelsOf = (view: InquiryView, which: 'conversation' | 'files'): RecordPanelsViewModel => ({
  ...panelsCase(which),
  record: { type: 'Inquiry', id: view.id, companyId: view.companyId, siteId: null },
  title: `${view.number} · ${view.party?.name ?? view.fromWords}`,
})

// ---- B-TH-217: the reading pane's thread in the design cases (made up; nothing is sent) ----------------------------------------

/** RecordThread v1 on Brand Alpha's made-up messages, the box on Office note (or, asked for info, the reply with the question). */
export function threadModel(mode: 'note' | 'reply' = 'note', body = '', prospect = false): RecordThreadModel {
  const brand = BRAND_ALPHA
  return {
    title: `${brand.numbers.request} · ${brand.tradeName}`,
    feed: { state: 'ready', messages: demoThread(brand), events: [], context: { partyName: brand.tradeName, canReadFiles: true, canReply: !prospect }, more: false, older: 'idle', now: DEMO_NOW },
    composer: {
      context: { recordType: 'Inquiry', recordLabel: brand.numbers.request, party: prospect ? null : { name: brand.tradeName }, ...(prospect ? { prospect: { name: 'Demo Track Club' } } : {}), can: { post: true, email: true, manage: true }, people: OFFICE_PEOPLE },
      draft: { mode, body, forFloor: false },
      notes: [],
      sending: false,
      files: [],
      recordFiles: [],
      canUpload: true,
      canShare: true,
      canPick: true,
      to: prospect ? [] : [{ address: brand.contact.email, name: brand.contact.name, kind: 'PARTY', organisation: brand.tradeName }],
      cc: [],
      subject: `Re: ${brand.numbers.request}`,
      contacts: [{ name: brand.contact.name, email: brand.contact.email }],
    },
  } as RecordThreadModel
}

const noop = () => undefined
const NOOP_THREAD = new Proxy({}, { get: () => noop }) as RecordThreadActions

/** The pane's thread element for a design case. */
export const demoThreadElement = (model: RecordThreadModel = threadModel()) => createElement('div', { className: 'fw-rt-pane-host' }, createElement(RecordThread, { model, actions: NOOP_THREAD }))
