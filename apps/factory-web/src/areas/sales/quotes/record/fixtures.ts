import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { ApprovalRow, PartyDetail, QuoteDetail, QuoteLine, QuoteVersionRow, SendCheck, StyleDetail, StyleRow } from '../api'
import type { Grains, QuoteAbilities } from '../model'
import type { QuoteRecordViewModel } from './record-model'
import { sendItems } from './send-model'
import { QuoteRecordView } from './view/QuoteRecordView'

/**
 * SCR-035 the quote record — made-up data only (PLAN §3.1): an invented company, customer, jacket and people; every
 * price and cost invented and worked out by hand (BLK 8 × 450 = 3,600.00; RED 6 × 440 = 2,640.00; net 6,240.00, VAT 22 %
 * 1,372.80, total 7,612.80, deposit 30 % 2,283.84; cost 4,084.97, margin 2,155.03 = 34.5 %). Each case is one state the
 * Owner reviews, per role: the Owner (every grain), Sales (prices and margin %, no cost), Finance (approves).
 */

export const PEOPLE = {
  sales: '0190f0e2-5555-7000-8000-000000000001',
  owner: '0190f0e2-5555-7000-8000-000000000002',
  finance: '0190f0e2-5555-7000-8000-000000000003',
}
export const PREFIX = '/w/DEMO'
export const COMPANY_ID = '0190f0e2-1111-7000-8000-000000000001'
export const QUOTE_ID = '0190f0e2-9999-7000-8000-000000000142'
const PARTY_ID = '0190f0e2-6666-7000-8000-000000000001'
const STYLE_ID = '0190f0e2-7777-7000-8000-000000000001'
const BLK = '0190f0e2-7777-7000-8000-000000000011'
const RED = '0190f0e2-7777-7000-8000-000000000012'
const REV = '0190f0e2-7777-7000-8000-000000000021'
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

export const GRAINS: Record<'owner' | 'sales' | 'finance' | 'priceOnly', Grains> = {
  owner: { price: true, cost: true, margin: true },
  sales: { price: true, cost: false, margin: true },
  finance: { price: true, cost: true, margin: true },
  priceOnly: { price: true, cost: false, margin: false },
}
export const CAN: Record<'owner' | 'sales' | 'finance' | 'viewer', QuoteAbilities> = {
  owner: { view: true, manage: true, approve: true, send: true },
  sales: { view: true, manage: true, approve: false, send: true },
  finance: { view: true, manage: false, approve: true, send: false },
  viewer: { view: true, manage: false, approve: false, send: false },
}

const covered = { outcome: 'covered' as const, certificateNumber: 'CERT-DEMO-0001', reasons: [] }
const refused = { outcome: 'refused' as const, certificateNumber: null, reasons: ['No valid certificate covers size 56.'] }

function line(id: string, seq: number, colourwayId: string, code: string, name: string, sizes: Array<[string, number]>, unit: string, net: number, cost: number, marginPct: string, belowFloor = false): QuoteLine {
  const quantity = sizes.reduce((sum, [, qty]) => sum + qty, 0)
  return {
    id,
    seq,
    kind: 'SIZE_GRID',
    styleId: STYLE_ID,
    style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo', status: 'ACTIVE' },
    styleRevisionId: REV,
    styleRevision: { revision: 1, status: 'DRAFT' },
    colourwayId,
    colourway: { code, name },
    description: `DEMO-JKT-01 Giacca pelle demo — ${name}`,
    note: null,
    quantity,
    listUnitPrice: null,
    unitPrice: unit,
    discountPct: null,
    netAmount: net,
    vatRatePct: '22.00',
    vatNature: null,
    vatAmount: Math.round(net * 0.22),
    unitCost: (cost / 100 / quantity).toFixed(3),
    costAmount: cost,
    costComplete: true,
    costMissing: [],
    marginAmount: net - cost,
    marginPct,
    belowFloor,
    sizes: sizes.map(([size, qty]) => ({ size, quantity: qty, unitPrice: null, certificate: size === '56' ? refused : covered })),
    version: 2,
  }
}

const LINES: QuoteLine[] = [
  line('0190f0e2-8888-7000-8000-000000000001', 10, BLK, 'BLK', 'Nero', [['50', 2], ['52', 4], ['54', 2]], '450', 360000, 232822, '35.3272'),
  line('0190f0e2-8888-7000-8000-000000000002', 20, RED, 'RED', 'Rosso', [['50', 1], ['52', 3], ['54', 2]], '440', 264000, 175675, '33.4564'),
]

type QuoteOverrides = Omit<Partial<QuoteDetail>, 'current'> & { current?: Partial<QuoteDetail['current']> }

export function quote(overrides: QuoteOverrides = {}): QuoteDetail {
  const { current, ...rest } = overrides
  return {
    id: QUOTE_ID,
    number: 'Q-2026-0142',
    companyId: COMPANY_ID,
    partyId: PARTY_ID,
    party: { code: 'C-DEMO-01', legalName: 'Squadra Corse Fittizia S.r.l.', status: 'ACTIVE' },
    contactId: '0190f0e2-6666-7000-8000-000000000101',
    contact: { name: 'Anna Esempio', email: 'anna@squadra-fittizia.example.com' },
    customerRef: 'RFQ-0042',
    status: 'DRAFT',
    currentRevision: 1,
    internalNote: null,
    version: 7,
    createdById: PEOPLE.sales,
    createdAt: at(27, 9),
    updatedAt: at(29, 8, 42),
    lines: LINES,
    approval: {
      needed: false,
      marginFloorPct: '20',
      discountLimitPct: '15',
      rules: [
        { reason: 'MARGIN_FLOOR', known: true, broken: false, message: '', lines: [] },
        { reason: 'DISCOUNT_LIMIT', known: true, broken: false, message: '', lines: [] },
      ],
      requests: [],
    },
    issues: [
      { code: 'COST_ESTIMATE', severity: 'INFO', path: 'lines/0', message: '', lineId: LINES[0]!.id, size: null },
      { code: 'CERTIFICATE', severity: 'WARNING', path: 'lines/1', message: '', lineId: LINES[1]!.id, size: '56' },
    ],
    canAskApproval: false,
    sendBlockers: [],
    ...rest,
    current: {
      id: '0190f0e2-9999-7000-8000-100000000001',
      revision: 1,
      status: 'DRAFT',
      currency: 'EUR',
      language: 'it',
      taxMode: 'IT_B2B',
      priceBasis: 'NET',
      billToAddressId: '0190f0e2-6666-7000-8000-000000000201',
      shipToAddressId: '0190f0e2-6666-7000-8000-000000000202',
      validUntil: '2026-11-28',
      firmOffer: false,
      promiseDate: '2027-02-15',
      paymentTerms: 'Bonifico 30 giorni data fattura',
      termsText: null,
      termsVersion: '2026-1',
      depositPct: '30',
      depositKind: 'ACCONTO',
      depositAmount: 228384,
      noWithdrawal: false,
      netAmount: 624000,
      vatAmount: 137280,
      grossAmount: 761280,
      vat: [{ rate: '22.00', nature: null, taxable: 624000, vat: 137280 }],
      costAmount: 408497,
      costComplete: true,
      marginAmount: 215503,
      marginPct: '34.5357',
      marginFloorPct: '20',
      marginFloorBreached: false,
      changeNote: null,
      version: 5,
      createdAt: at(27, 9),
      updatedAt: at(29, 8, 42),
      ...current,
    },
  }
}

/** What the API answers a person without the cost grain (Sales, S2): no cost, no margin amount. */
export function withoutCost(detail: QuoteDetail): QuoteDetail {
  const { costAmount: _c, marginAmount: _m, ...current } = detail.current
  return {
    ...detail,
    current: current as QuoteDetail['current'],
    lines: detail.lines.map(({ unitCost: _u, costAmount: _ca, marginAmount: _ma, ...rest }) => rest as QuoteLine),
  }
}

/** A quote under the 20 % floor: BLK at 300 (margin 3.1 %), so it needs an approval. */
export function belowFloor(overrides: QuoteOverrides = {}): QuoteDetail {
  const low = line(LINES[0]!.id, 10, BLK, 'BLK', 'Nero', [['50', 2], ['52', 4], ['54', 2]], '300', 240000, 232822, '2.9908', true)
  return quote({
    lines: [low, LINES[1]!],
    approval: {
      needed: true,
      marginFloorPct: '20',
      discountLimitPct: '15',
      rules: [
        { reason: 'MARGIN_FLOOR', known: true, broken: true, message: '', lines: [10] },
        { reason: 'DISCOUNT_LIMIT', known: true, broken: false, message: '', lines: [] },
      ],
      requests: [],
    },
    issues: [{ code: 'APPROVAL_NEEDED', severity: 'INFO', path: 'approval', message: '', lineId: null, size: null }],
    canAskApproval: true,
    ...overrides,
    current: { netAmount: 504000, vatAmount: 110880, grossAmount: 614880, depositAmount: 184464, vat: [{ rate: '22.00', nature: null, taxable: 504000, vat: 110880 }], marginAmount: 95503, marginPct: '18.9490', marginFloorBreached: true, ...overrides.current },
  })
}

const request = (status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN', by: string, extra: Partial<QuoteDetail['approval']['requests'][number]> = {}) => ({
  id: '0190f0e2-9999-7000-8000-200000000001',
  status,
  reasons: ['MARGIN_FLOOR' as const],
  requestNote: 'Primo ordine di una squadra nuova: prezzo d\'ingresso.',
  createdById: by,
  createdAt: at(29, 9, 5),
  decidedById: status === 'PENDING' ? null : PEOPLE.finance,
  decidedAt: status === 'PENDING' ? null : at(29, 10, 12),
  decisionNote: status === 'REJECTED' ? 'Margine troppo basso: proviamo 380 sul nero.' : null,
  ...extra,
})

export function pending(by = PEOPLE.sales): QuoteDetail {
  const base = belowFloor()
  return { ...base, status: 'PENDING_APPROVAL', current: { ...base.current, status: 'PENDING_APPROVAL' }, canAskApproval: false, approval: { ...base.approval, requests: [request('PENDING', by)] }, sendBlockers: [{ code: 'APPROVAL_NEEDED', severity: 'BLOCKS_SEND', path: 'approval', message: '', lineId: null, size: null }] }
}

export const approvalRow = (overrides: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: '0190f0e2-9999-7000-8000-200000000001',
  quoteId: QUOTE_ID,
  number: 'Q-2026-0142',
  companyId: COMPANY_ID,
  partyId: PARTY_ID,
  partyName: 'Squadra Corse Fittizia S.r.l.',
  quoteVersion: 7,
  revision: 1,
  current: true,
  status: 'PENDING',
  reasons: ['MARGIN_FLOOR'],
  requestNote: 'Primo ordine di una squadra nuova: prezzo d\'ingresso.',
  askedBy: { id: PEOPLE.sales, name: 'Sara Vendite', you: false },
  askedAt: at(29, 9, 5),
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  currency: 'EUR',
  netAmount: 504000,
  grossAmount: 614880,
  marginPct: '18.9490',
  marginFloorPct: '20',
  validUntil: '2026-11-28',
  mayDecide: true,
  held: null,
  ...overrides,
})

const sentAt = at(29, 11, 2)
const document = { fileId: '0190f0e2-9999-7000-8000-300000000001', name: 'Preventivo Q-2026-0142 v1.pdf', sha256: '3f9a1c0e7b2d4a6f8e1c3b5d7f9a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a', sizeBytes: 48211, status: 'AVAILABLE' }

export function version(overrides: Partial<QuoteVersionRow> = {}): QuoteVersionRow {
  return {
    id: '0190f0e2-9999-7000-8000-100000000001',
    revision: 1,
    documentNumber: 'Q-2026-0142 v1',
    status: 'DRAFT',
    currency: 'EUR',
    netAmount: 624000,
    grossAmount: 761280,
    depositAmount: 228384,
    validUntil: '2026-11-28',
    firmOffer: false,
    changeNote: null,
    createdAt: at(27, 9),
    createdById: PEOPLE.sales,
    sentAt: null,
    sentById: null,
    closedAt: null,
    decisionNote: null,
    documentSha256: null,
    termsVersion: '2026-1',
    document: null,
    links: [],
    acceptance: null,
    deposit: null,
    ...overrides,
  }
}

export const SENT_VERSION = version({ status: 'SENT', sentAt, sentById: PEOPLE.sales, documentSha256: document.sha256, document, links: [{ id: '0190f0e2-9999-7000-8000-400000000001', email: 'anna@squadra-fittizia.example.com', state: 'LIVE', expiresAt: '2026-12-12T22:59:59.000Z', uses: 0, maxUses: 1, lastUsedAt: null, revokedAt: null, createdAt: sentAt }] })
export const ACCEPTED_VERSION = version({
  ...SENT_VERSION,
  status: 'ACCEPTED',
  closedAt: at(30, 16, 20),
  links: [{ ...SENT_VERSION.links[0]!, state: 'USED_UP', uses: 1, lastUsedAt: at(30, 16, 20) }],
  acceptance: { id: '0190f0e2-9999-7000-8000-500000000001', channel: 'LINK', signerName: 'Anna Esempio', emailCheck: 'MATCHED', documentSha256: document.sha256, documentMatches: true, termsVersion: '2026-1', noWithdrawalAccepted: false, acceptedAt: at(30, 16, 20) },
  deposit: { id: '0190f0e2-9999-7000-8000-600000000001', kind: 'ACCONTO', depositPct: '30', currency: 'EUR', amount: 228384, dueDate: '2026-11-06', fiscalDocument: 'TD02', fiscalRule: 'ACCONTO_TD02', status: 'OPEN', paidAt: null, createdAt: at(30, 16, 20) },
})

export const STYLE: StyleDetail = {
  id: STYLE_ID,
  code: 'DEMO-JKT-01',
  name: 'Giacca pelle demo',
  season: 'FW27',
  sizes: ['46', '48', '50', '52', '54', '56'],
  ppeClass: 'AA',
  ppeCategory: 'II',
  mtmAllowed: false,
  status: 'ACTIVE',
  revisionState: 'DRAFT',
  colourways: [
    { id: BLK, code: 'BLK', name: 'Nero', colour: { hex: '#1d1d1f' }, status: 'ACTIVE', offeredSizes: ['46', '48', '50', '52', '54', '56'] },
    { id: RED, code: 'RED', name: 'Rosso', colour: { hex: '#b3261e' }, status: 'ACTIVE', offeredSizes: ['48', '50', '52', '54', '56'] },
    { id: '0190f0e2-7777-7000-8000-000000000013', code: 'WHT', name: 'Bianco', colour: { hex: '#f4f4f2' }, status: 'ACTIVE', offeredSizes: ['48', '50', '52', '54'] },
  ],
  matrix: { sizes: ['46', '48', '50', '52', '54', '56'].map((code) => ({ code, label: code })) },
}

export const STYLE_ROWS: StyleRow[] = [
  { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca pelle demo', season: 'FW27', sizes: STYLE.sizes, ppeClass: 'AA', ppeCategory: 'II', mtmAllowed: false, status: 'ACTIVE', revisionState: 'DRAFT' },
  { id: '0190f0e2-7777-7000-8000-000000000002', code: 'DEMO-TRS-02', name: 'Pantalone pelle demo', season: 'FW27', sizes: ['46', '48', '50', '52', '54'], ppeClass: 'AA', ppeCategory: 'II', mtmAllowed: true, status: 'ACTIVE', revisionState: 'RELEASED' },
]

export const PARTY: PartyDetail = {
  id: PARTY_ID,
  code: 'C-DEMO-01',
  legalName: 'Squadra Corse Fittizia S.r.l.',
  tradeName: 'Squadra Corse Fittizia',
  status: 'ACTIVE',
  country: 'IT',
  taxMode: 'IT_B2B',
  vatNumber: 'IT00000000000',
  city: 'Milano',
  vies: { state: 'NOT_APPLICABLE' },
  paymentTerms: 'Bonifico 30 giorni data fattura',
  addresses: [
    { id: '0190f0e2-6666-7000-8000-000000000201', kinds: ['BILL_TO'], name: 'Sede', line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', isDefaultBillTo: true, isDefaultShipTo: false, status: 'ACTIVE' },
    { id: '0190f0e2-6666-7000-8000-000000000202', kinds: ['SHIP_TO'], name: 'Magazzino', line1: 'Via Fittizia 22', postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT', isDefaultBillTo: false, isDefaultShipTo: true, status: 'ACTIVE' },
  ],
  contacts: [
    { id: '0190f0e2-6666-7000-8000-000000000101', name: 'Anna Esempio', email: 'anna@squadra-fittizia.example.com', roles: ['ORDERS'], status: 'ACTIVE' },
    { id: '0190f0e2-6666-7000-8000-000000000102', name: 'Luca Fittizio', email: null, roles: ['TECHNICAL'], status: 'ACTIVE' },
  ],
  taxIdentities: [{ id: '0190f0e2-6666-7000-8000-000000000301', taxMode: 'IT_B2B', vatNumber: 'IT00000000000', fiscalCode: '00000000000', sdiRecipientCode: 'XXXXXXX', pec: null, current: true }],
  warnings: [],
}

const PDF = samplePdf(['Preventivo Q-2026-0142 v1 - ESEMPIO', 'Officina Demo S.r.l. - documento di prova', 'Squadra Corse Fittizia S.r.l.', 'DEMO-JKT-01 Nero  50x2 52x4 54x2   8 x 450,00 = 3.600,00', 'DEMO-JKT-01 Rosso 50x1 52x3 54x2   6 x 440,00 = 2.640,00', 'Imponibile 6.240,00  IVA 22% 1.372,80  Totale 7.612,80', 'Acconto 30% 2.283,84'])

const panels = panelsScreen.cases.find((item) => item.id === 'conversation')!.model
const PANELS = { ...panels, record: { type: 'Quote', id: QUOTE_ID, companyId: COMPANY_ID, siteId: null }, title: 'Q-2026-0142 · Squadra Corse Fittizia S.r.l.' }

export function model(overrides: Partial<QuoteRecordViewModel> = {}): QuoteRecordViewModel {
  return {
    prefix: PREFIX,
    me: PEOPLE.sales,
    tab: 'lines',
    grains: GRAINS.owner,
    can: CAN.owner,
    quote: { status: 'ready', value: quote() },
    styles: { [STYLE_ID]: STYLE },
    drafts: {},
    pendingColourways: {},
    prices: {},
    save: { state: 'saved', at: at(29, 8, 42) },
    composer: { query: '', results: null, problem: null, chosen: null, picked: [] },
    versions: { items: [version()], people: { [PEOPLE.sales]: 'Sara Vendite', [PEOPLE.finance]: 'Fiona Conti' }, problem: null },
    approvals: { items: [], problem: null },
    party: { value: PARTY, problem: null },
    previewLanguage: 'it',
    document: { src: PDF, openHref: null, problem: null, frozen: false },
    send: null,
    dialog: null,
    busy: false,
    notice: null,
    changed: null,
    today: '2026-10-29',
    dockOpen: false,
    panelsPreview: PANELS,
    ...overrides,
  }
}

const ready = (detail: QuoteDetail) => ({ status: 'ready' as const, value: detail })

/**
 * The send dialog's model as the record container builds it, with the quote's words from the real catalogue in the
 * language asked (the design index shows each language with its own words).
 */
export function sendModel(overrides: Partial<DocumentSendModel> = {}, locale: Locale = 'it', checks: SendCheck['checks'] = [{ code: 'CERTIFICATE', severity: 'WARNING', path: 'lines', message: '', lineId: null, size: '56' }]): DocumentSendModel {
  const t = createTranslator(locale, CATALOGUE[locale].sales ?? {})
  return {
    title: t('send.title', { number: 'Q-2026-0142', revision: 1 }),
    documentLabel: t('docs.pdfTitle', { number: 'Q-2026-0142', revision: 1 }),
    recipient: { name: 'Anna Esempio', email: 'anna@squadra-fittizia.example.com' },
    language: 'it',
    how: { kind: 'acceptLink', until: '2026-12-12T22:59:59.000Z' },
    freezeNote: t('send.freeze', { revision: 1, next: 2 }),
    recipientCan: [t('send.can.accept'), t('send.can.deposit')],
    fields: { cc: '', subject: 'Preventivo Q-2026-0142 v1', message: '' },
    checks: { status: 'ready', items: sendItems({ checks }, t, (tab) => `${PREFIX}/sales/quotes/${QUOTE_ID}?tab=${tab}`) },
    preview: { src: PDF, openHref: null, problem: null, fileName: 'Q-2026-0142-v1.pdf' },
    sending: false,
    problem: null,
    result: null,
    canSend: true,
    ...overrides,
  }
}

const sentQuote = quote({ status: 'SENT', current: { status: 'SENT' } })
const acceptedQuote = quote({ status: 'ACCEPTED', current: { status: 'ACCEPTED' } })

export const designScreen = defineDesignScreen<QuoteRecordViewModel>({
  screen: 'SCR-035',
  title: 'Quote record: lines, price & margin, terms, versions, approval, documents',
  view: QuoteRecordView,
  cases: [
    { id: 'owner-lines', label: 'Owner · Lines (draft, every grain)', model: model(), note: 'Style block: colours × sizes typed from the keyboard (autosaved), each colour line\'s price, net, unit cost and margin %; size 56 without certificate is a warning; the summary rail with margin € and %.' },
    { id: 'sales-lines', label: 'Sales · Lines (margin %, no cost: S2)', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(quote())) }), note: 'Sales sees prices and the margin % against the floor, never a cost or a margin amount.' },
    { id: 'sales-composer', label: 'Sales · Add a style (search results)', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(quote({ lines: [], issues: [{ code: 'NO_LINES', severity: 'BLOCKS', path: 'lines', message: '', lineId: null, size: null }], current: { netAmount: 0, vatAmount: 0, grossAmount: 0, depositAmount: 0, vat: [], marginPct: null } }))), composer: { query: 'demo', results: STYLE_ROWS, problem: null, chosen: null, picked: [] } }), note: 'A new draft: type a style, each result shows Released / Estimate, PPE class and made-to-measure.' },
    { id: 'sales-composer-colours', label: 'Sales · Add a style (colours ticked)', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(quote({ lines: [] }))), composer: { query: 'demo', results: STYLE_ROWS, problem: null, chosen: STYLE, picked: [STYLE.colourways[0]!.id, STYLE.colourways[1]!.id] } }), note: 'The style picked: its colours (all on by default; off = not quoted), the estimate note, Add.' },
    { id: 'new-block', label: 'Owner · A new block, no pieces yet', model: model({ quote: ready(quote({ lines: [] })), pendingColourways: { [STYLE_ID]: [STYLE.colourways[0]!.id, STYLE.colourways[2]!.id] } }), note: 'Rows for the chosen colours; a size the colourway is not made in reads "not offered"; the line exists once it has pieces.' },
    { id: 'saving', label: 'Owner · Saving a cell, then a failed save', model: model({ save: { state: 'failed', at: at(29, 8, 42) }, drafts: { [STYLE_ID]: { [BLK]: { '50': 2, '52': 6, '54': 2 }, [RED]: { '50': 1, '52': 3, '54': 2 } } }, notice: { key: 'problem.write.unavailable', tone: 'danger' } }), note: 'The band says "A change was not saved — Retry"; the typed grid stays as typed.' },
    { id: 'below-floor-sales', label: 'Sales · Under the margin floor (held with reason)', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(belowFloor())) }), note: 'Send is held "Needs approval first: margin under the floor"; the primary is Ask for approval (a).' },
    { id: 'ask-dialog', label: 'Sales · Ask for approval', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(belowFloor())), dialog: 'ask' }) },
    { id: 'pending-requester', label: 'Sales · Waiting for approval (asked by me)', model: model({ grains: GRAINS.sales, can: CAN.sales, tab: 'approval', quote: ready(withoutCost(pending())), approvals: { items: [approvalRow({ askedBy: { id: PEOPLE.sales, name: 'Sara Vendite', you: true }, mayDecide: false, held: 'OWN_REQUEST' })], problem: null } }), note: 'Lines frozen; Withdraw request; the request with its note.' },
    { id: 'pending-approver', label: 'Finance · Waiting for approval (approver)', model: model({ me: PEOPLE.finance, grains: GRAINS.finance, can: CAN.finance, tab: 'approval', quote: ready(pending()), approvals: { items: [approvalRow()], problem: null } }), note: 'Approve / Reject in the band and on the tab; margin 18.9 % against the 20 % floor.' },
    { id: 'pending-own-owner', label: 'Owner · Asked by me: held (four eyes)', model: model({ me: PEOPLE.owner, tab: 'approval', quote: ready(pending(PEOPLE.owner)), approvals: { items: [approvalRow({ askedBy: { id: PEOPLE.owner, name: 'Olga Titolare', you: true }, mayDecide: false, held: 'OWN_REQUEST' })], problem: null } }), note: 'The Owner may approve, but never a request they asked: Approve is held with the reason.' },
    { id: 'reject-dialog', label: 'Finance · Reject (a reason is required)', model: model({ me: PEOPLE.finance, grains: GRAINS.finance, can: CAN.finance, tab: 'approval', quote: ready(pending()), dialog: 'reject' }) },
    { id: 'approved', label: 'Sales · Approved, ready to send', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost({ ...belowFloor(), status: 'APPROVED', current: { ...belowFloor().current, status: 'APPROVED' }, approval: { ...belowFloor().approval, requests: [request('APPROVED', PEOPLE.sales, { decisionNote: 'Ok per il primo ordine.' })] } })), approvals: { items: [approvalRow({ status: 'APPROVED', decidedBy: { id: PEOPLE.finance, name: 'Fiona Conti', you: false }, decidedAt: at(29, 10, 12), decisionNote: 'Ok per il primo ordine.', mayDecide: false, held: 'NOT_WAITING' })], problem: null } }) },
    { id: 'send-dialog', label: 'Sales · Send to customer (ready)', model: model({ grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(quote())), send: sendModel() }), note: 'The shared send part (SCR-037) on the quote: recipient, copies, subject, checks, what freezes, the PDF.' },
    { id: 'price-owner', label: 'Owner · Price & margin', model: model({ tab: 'price' }) },
    { id: 'price-sales', label: 'Sales · Price & margin (no cost columns)', model: model({ tab: 'price', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(belowFloor())) }) },
    { id: 'price-only', label: 'A role with prices only', model: model({ tab: 'price', grains: GRAINS.priceOnly, can: CAN.viewer, quote: ready(withoutCost(quote({ current: { marginPct: undefined, marginFloorPct: undefined, marginFloorBreached: undefined } }))) }), note: 'Without the margin grain: no margin figures at all, said once.' },
    { id: 'terms-edit', label: 'Sales · Terms & delivery (draft, explicit save)', model: model({ tab: 'terms', grains: GRAINS.sales, can: CAN.sales, quote: ready(withoutCost(quote())) }), note: 'Change a field and the EditModeBar appears (⌘S, Discard).' },
    { id: 'terms-read-only', label: 'Terms & delivery (sent: read only)', model: model({ tab: 'terms', quote: ready(sentQuote) }) },
    { id: 'versions', label: 'Versions (v2 draft, v1 sent)', model: model({ tab: 'versions', quote: ready(quote({ currentRevision: 2, current: { revision: 2, changeNote: 'Aggiunto il colore rosso.' } })), versions: { items: [version({ id: '0190f0e2-9999-7000-8000-100000000002', revision: 2, documentNumber: 'Q-2026-0142 v2', changeNote: 'Aggiunto il colore rosso.', createdAt: at(30, 9) }), SENT_VERSION], people: { [PEOPLE.sales]: 'Sara Vendite' }, problem: null } }) },
    { id: 'sent', label: 'Sent · read only, Make version 2', model: model({ quote: ready(sentQuote), versions: { items: [SENT_VERSION], people: { [PEOPLE.sales]: 'Sara Vendite' }, problem: null } }), note: 'Validity countdown in the band; the grid is drawn as text; the primary is Make version 2.' },
    { id: 'documents-draft', label: 'Documents · draft preview', model: model({ tab: 'documents' }) },
    { id: 'documents-sent', label: 'Documents · sent: link live', model: model({ tab: 'documents', quote: ready(sentQuote), document: { src: PDF, openHref: null, problem: null, frozen: true }, versions: { items: [SENT_VERSION], people: {}, problem: null } }) },
    { id: 'accepted', label: 'Accepted · evidence and deposit', model: model({ tab: 'documents', quote: ready(acceptedQuote), document: { src: PDF, openHref: null, problem: null, frozen: true }, versions: { items: [ACCEPTED_VERSION], people: {}, problem: null } }) },
    { id: 'documents-needs', label: 'Documents · the PDF still needs addresses', model: model({ tab: 'documents', document: { src: null, openHref: null, problem: 'docs.problem.needs', frozen: false } }) },
    { id: 'activity', label: 'Activity (thread, files, history)', model: model({ tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside the tab (wide screens, ⌘J)', model: model({ dockOpen: true }), note: 'Owner O1: at 1280 px and wider; narrower, the button opens Activity.' },
    { id: 'changed', label: 'Changed by someone else (unsaved work kept)', model: model({ changed: { at: at(29, 9, 30) }, drafts: { [STYLE_ID]: { [BLK]: { '50': 3, '52': 4, '54': 2 } } } }) },
    { id: 'viewer', label: 'A viewer: read only', model: model({ can: CAN.viewer, grains: GRAINS.priceOnly, quote: ready(withoutCost(quote({ current: { marginPct: undefined, marginFloorPct: undefined, marginFloorBreached: undefined } }))) }) },
    { id: 'loading', label: 'Loading', model: model({ quote: { status: 'loading' } }) },
    { id: 'error', label: 'Error', model: model({ quote: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'not-found', label: 'Not found', model: model({ quote: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No permission', model: model({ quote: { status: 'forbidden' } }) },
  ],
})
