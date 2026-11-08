import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { KIND_WORDS, NO_WITHDRAWAL_WORDS, REQUEST_STATUS_WORDS } from '@nexus/factory-domain/sales/change-requests/rules'
import { PROGRESS_STAGE_WORDS, PROGRESS_STAGES } from '@nexus/factory-domain/sales/portal-orders/progress'
import { PROMISE_REASON_WORDS } from '@nexus/factory-domain/sales/portal-orders/promise'
import { SHIPMENT_MILESTONE_WORDS, SHIPMENT_STATUS_WORDS, TRACKING_WORDS } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { CHIP_WORDS, CUSTOMER_STATUS_WORDS, MILESTONE_WORDS, ORDER_CHIPS } from '@nexus/factory-domain/sales/portal-orders/status'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { PortalBand } from '../../shell/frame'
import { badgesOf } from '../../shell/model'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type {
  ApprovalPage,
  ChangeRequest,
  ChangeRules,
  CustomerOrderStatus,
  DocumentsRead,
  InTransitRead,
  OrderChip,
  OrderRecord,
  OrderRow,
  OrdersRead,
  ProgressRead,
  ShipmentsRead,
  Verdict,
} from './api'
import { NS } from './model'
import { orderWordsFor, type OrderWords } from './words'

/**
 * SCR-184's made-up world (B-W2b-191; PLAN §3.1): an invented maker (Pelletteria Esempio) and an invented customer (Brand
 * Alpha S.r.l., its buyer Anna Esempio), their own PO numbers BA-PO-…, our orders SO-2026-01…, a jacket and trousers by
 * size, one made-to-measure suit. Never a real company, person, address or number. Prices are made up too.
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const TODAY = dayAt(0)
export const PREFIX = '/p/BRAND-ALPHA'
export const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
export const orderWords = (locale: Locale): OrderWords => orderWordsFor(words(locale), locale)

const id = (n: number) => `0190f0e2-1910-7000-8000-${String(n).padStart(12, '0')}`
export const ORDER_ID = id(1)
const LIVE = { events: ['partner_notification.created'] }

const LEGAL = {
  it: { name: 'Pelletteria Esempio S.r.l.', lines: ['Sede legale: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Pelletteria Esempio S.r.l.', lines: ['Registered office: Via dei Conciatori Finti 1, 50100 Firenze (FI)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const
const ALL = (permission: string) => permission.startsWith('portal.') || permission === 'files.read' || permission === 'threads.read'

export function shellOf(locale: Locale, band: PortalBand, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return {
    brand: { name: 'Pelletteria Esempio', logoUrl: null, logoDarkUrl: null, accent: '#7a1f3d' },
    companyName: 'Pelletteria Esempio',
    partyName: 'Brand Alpha S.r.l.',
    person: { displayName: 'Anna Esempio', email: 'anna@brand-alpha.example' },
    nav: portalNavFor({ can: ALL, kinds: ['CUSTOMER'], everyPage: true }),
    path: '/orders',
    prefix: PREFIX,
    badges: badgesOf([{ area: 'orders', count: 1, words: { it: '1 da riconfermare', en: '1 to re-confirm' } }], locale),
    bell: { unread: 2, complete: true },
    notice: null,
    band,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: true,
    ...over,
  }
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const JACKET = { code: 'JKT-DEMO-01', name: 'Giacca Demo Touring' }
const TROUSERS = { code: 'PNT-DEMO-02', name: 'Pantalone Demo Touring' }
const SUIT = { code: 'SUIT-DEMO-03', name: 'Tuta Demo su misura' }
const BLACK = { code: 'NER', name: 'Nero' }
const SAND = { code: 'SAB', name: 'Sabbia' }

function row(n: number, status: CustomerOrderStatus, over: Partial<OrderRow> = {}): OrderRow {
  return {
    kind: 'ORDER',
    id: id(n),
    customerRef: `BA-PO-${770 + n}`,
    number: `SO-2026-01${String(40 + n).padStart(2, '0')}`,
    orderedOn: dayAt(-30 + n),
    status,
    words: CUSTOMER_STATUS_WORDS[status],
    promiseDate: dayAt(10 + n * 3),
    originalPromiseDate: dayAt(10 + n * 3),
    promiseMoved: false,
    movedLately: false,
    requestedDate: dayAt(8 + n * 3),
    pieces: { ordered: 40, shipped: 0, open: 40 },
    netAmount: 742000 + n * 10000,
    currency: 'EUR',
    nextShipment: null,
    progressPercent: null,
    ...over,
  }
}

export const ROWS: readonly OrderRow[] = [
  row(1, 'PARTLY_SHIPPED', {
    promiseDate: dayAt(12),
    originalPromiseDate: dayAt(5),
    promiseMoved: true,
    movedLately: true,
    pieces: { ordered: 46, shipped: 18, open: 28 },
    nextShipment: { id: id(101), number: 'SH-2026-0233', status: 'IN_TRANSIT', words: SHIPMENT_STATUS_WORDS.IN_TRANSIT, date: dayAt(-1), carrierName: 'Corriere Demo', expectedDeliveryAt: at(30) },
  }),
  row(2, 'IN_PRODUCTION', { pieces: { ordered: 60, shipped: 0, open: 60 } }),
  row(3, 'CONFIRMED', { customerRef: null, pieces: { ordered: 1, shipped: 0, open: 1 }, netAmount: 189000 }),
  { ...row(4, 'REQUESTED'), kind: 'REQUEST', number: 'RQ-2026-0012', orderedOn: null, promiseDate: null, originalPromiseDate: null, netAmount: null, pieces: { ordered: 24, shipped: 0, open: 24 } },
  row(5, 'READY', { pieces: { ordered: 30, shipped: 0, open: 30 }, nextShipment: { id: id(105), number: 'SH-2026-0240', status: 'PACKED', words: SHIPMENT_STATUS_WORDS.PACKED, date: dayAt(1), carrierName: 'Corriere Demo', expectedDeliveryAt: null } }),
  row(6, 'DELIVERED', { promiseDate: dayAt(-6), pieces: { ordered: 20, shipped: 20, open: 0 } }),
  row(7, 'CANCELLED', { promiseDate: null, pieces: { ordered: 12, shipped: 0, open: 0 } }),
]

const OPEN: readonly CustomerOrderStatus[] = ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED']
const inChip = (chip: OrderChip, entry: OrderRow) =>
  chip === 'ALL' ? true : chip === 'OPEN' ? OPEN.includes(entry.status) : chip === 'SHIPPED' ? entry.status === 'SHIPPED' || entry.status === 'PARTLY_SHIPPED' : chip === 'DATE_MOVED' ? entry.movedLately : entry.status === chip

export function ordersRead(chip: OrderChip = 'OPEN', rows: readonly OrderRow[] | null = null, over: Partial<OrdersRead> = {}): OrdersRead {
  const items = rows ?? ROWS.filter((entry) => inChip(chip, entry))
  const seesPrices = over.seesPrices ?? true
  return {
    asOf: at(0),
    seesPrices,
    progressShared: true,
    chip,
    chips: ORDER_CHIPS.map((entry) => ({ chip: entry, count: ROWS.filter((item) => inChip(entry, item)).length, words: CHIP_WORDS[entry] })),
    count: items.length,
    items: seesPrices ? [...items] : items.map(({ netAmount: _netAmount, ...rest }) => rest),
    live: LIVE,
    ...over,
  }
}

export function inTransitRead(over: Partial<InTransitRead> = {}): InTransitRead {
  return {
    asOf: at(0),
    items: [
      {
        shipmentId: id(101),
        number: 'SH-2026-0233',
        order: { id: ORDER_ID, number: ROWS[0]!.number!, customerRef: ROWS[0]!.customerRef },
        status: 'IN_TRANSIT',
        words: SHIPMENT_STATUS_WORDS.IN_TRANSIT,
        carrierName: 'Corriere Demo',
        shippedAt: at(-20),
        expectedDeliveryAt: at(30),
        trackingNumbers: ['DEMO00012345'],
        trackingLinks: [{ trackingNumber: 'DEMO00012345', url: 'https://tracking.example/DEMO00012345', words: { it: 'Segui sul sito del corriere', en: "Track on the carrier's site" } }],
        lastEvent: { at: at(-3), status: 'IN_TRANSIT', words: TRACKING_WORDS.IN_TRANSIT, description: 'Hub Demo', location: 'Bologna', parcelSeq: 1 },
      },
    ],
    live: LIVE,
    ...over,
  }
}

// ── one order ────────────────────────────────────────────────────────────────────────────────────────────────────────
const sizes = (run: Record<string, [number, number]>) => Object.entries(run).map(([size, [ordered, shipped]]) => ({ size, ordered, shipped, open: ordered - shipped, closedShort: 0, unitPrice: '185.000000' }))

export function orderRecord(over: Partial<OrderRecord['order']> = {}, rest: Partial<OrderRecord> = {}): OrderRecord {
  return {
    asOf: at(0),
    seesPrices: true,
    order: {
      id: ORDER_ID,
      customerRef: 'BA-PO-771',
      number: 'SO-2026-0141',
      status: 'PARTLY_SHIPPED',
      words: CUSTOMER_STATUS_WORDS.PARTLY_SHIPPED,
      orderDate: dayAt(-29),
      requestedDate: dayAt(5),
      promiseDate: dayAt(12),
      originalPromiseDate: dayAt(5),
      promiseMoved: true,
      currency: 'EUR',
      language: 'it',
      shipTo: { name: 'Brand Alpha S.r.l. — Magazzino', line1: 'Via Esempio 10', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', contactName: 'Ufficio ricevimento' },
      paymentTerms: '30% acconto, saldo 30 gg data fattura',
      noWithdrawal: false,
      depositRequired: true,
      netAmount: 752000,
      vatAmount: 165440,
      grossAmount: 917440,
      reconfirmNeeded: false,
      cancelledOn: null,
      version: 4,
      ...over,
    },
    milestones: [
      { key: 'REQUESTED', words: MILESTONE_WORDS.REQUESTED, state: 'DONE', date: dayAt(-31), expected: null, current: false },
      { key: 'CONFIRMED', words: MILESTONE_WORDS.CONFIRMED, state: 'DONE', date: dayAt(-29), expected: null, current: false },
      { key: 'IN_PRODUCTION', words: MILESTONE_WORDS.IN_PRODUCTION, state: 'DONE', date: dayAt(-18), expected: null, current: false },
      { key: 'READY', words: MILESTONE_WORDS.READY, state: 'PARTLY', date: dayAt(-2), expected: null, current: false },
      { key: 'SHIPPED', words: MILESTONE_WORDS.SHIPPED, state: 'PARTLY', date: dayAt(-1), expected: dayAt(12), current: true },
      { key: 'DELIVERED', words: MILESTONE_WORDS.DELIVERED, state: 'TODO', date: null, expected: dayAt(14), current: false },
    ],
    promiseHistory: [
      { on: dayAt(-4), from: dayAt(8), to: dayAt(12), lines: [1], reason: { code: 'MATERIAL_LATE', words: PROMISE_REASON_WORDS.MATERIAL_LATE } },
      { on: dayAt(-12), from: dayAt(5), to: dayAt(8), lines: [1, 2], reason: { code: 'CAPACITY', words: PROMISE_REASON_WORDS.CAPACITY } },
    ],
    deposits: [{ id: id(301), kind: 'ACCONTO', status: 'PAID', amount: 275232, currency: 'EUR', dueDate: dayAt(-25), paidAt: at(-26 * 24) }],
    lines: [
      {
        id: id(201),
        seq: 1,
        kind: 'SIZE_GRID',
        style: JACKET,
        colourway: BLACK,
        description: null,
        measurement: null,
        baseSize: null,
        quantity: 30,
        unitPrice: '185.000000',
        netAmount: 555000,
        vatAmount: 122100,
        requestedDate: null,
        promiseDate: dayAt(12),
        closedShort: null,
        sizes: sizes({ '46': [4, 4], '48': [8, 6], '50': [10, 6], '52': [6, 2], '54': [2, 0] }),
        pieces: { ordered: 30, shipped: 18, open: 12 },
      },
      {
        id: id(202),
        seq: 2,
        kind: 'SIZE_GRID',
        style: TROUSERS,
        colourway: SAND,
        description: null,
        measurement: null,
        baseSize: null,
        quantity: 16,
        unitPrice: '123.125000',
        netAmount: 197000,
        vatAmount: 43340,
        requestedDate: null,
        promiseDate: dayAt(9),
        closedShort: null,
        sizes: Object.entries({ '46': 2, '48': 4, '50': 6, '52': 4 }).map(([size, ordered]) => ({ size, ordered, shipped: 0, open: ordered, closedShort: 0, unitPrice: '123.125000' })),
        pieces: { ordered: 16, shipped: 0, open: 16 },
      },
    ],
    pieces: { ordered: 46, shipped: 18, open: 28, closedShort: 0 },
    progressShared: true,
    shipments: { shown: 1, onTheWay: 1 },
    live: LIVE,
    ...rest,
  }
}

/** A record as a role without the price grain reads it: every price key left out. */
export function withoutPrices(record: OrderRecord): OrderRecord {
  const { netAmount: _n, vatAmount: _v, grossAmount: _g, ...order } = record.order
  return {
    ...record,
    seesPrices: false,
    order,
    deposits: record.deposits.map(({ amount: _amount, ...deposit }) => deposit),
    lines: record.lines.map(({ unitPrice: _u, netAmount: _ln, vatAmount: _lv, ...line }) => ({ ...line, sizes: line.sizes.map(({ unitPrice: _su, ...size }) => size) })),
  }
}

/** A made-to-measure order for a rider: no right of withdrawal. */
export function mtmRecord(): OrderRecord {
  const base = orderRecord({ id: id(3), number: 'SO-2026-0143', customerRef: null, status: 'CONFIRMED', words: CUSTOMER_STATUS_WORDS.CONFIRMED, noWithdrawal: true, promiseMoved: false, originalPromiseDate: dayAt(19), promiseDate: dayAt(19), netAmount: 189000, vatAmount: 41580, grossAmount: 230580 })
  return {
    ...base,
    promiseHistory: [],
    progressShared: false,
    shipments: { shown: 0, onTheWay: 0 },
    pieces: { ordered: 1, shipped: 0, open: 1, closedShort: 0 },
    milestones: base.milestones.map((step, index) => ({ ...step, state: index < 2 ? 'DONE' : 'TODO', date: index < 2 ? step.date : null, current: index === 2, expected: step.key === 'SHIPPED' ? dayAt(19) : null })),
    lines: [{ ...base.lines[0]!, kind: 'MADE_TO_MEASURE', style: SUIT, quantity: 1, measurement: { riderName: 'Marco B.', revision: 3 }, baseSize: '50', sizes: [{ size: '50', ordered: 1, shipped: 0, open: 1, closedShort: 0, unitPrice: '1890.000000' }], unitPrice: '1890.000000', netAmount: 189000, vatAmount: 41580, pieces: { ordered: 1, shipped: 0, open: 1 } }],
    deposits: [{ id: id(302), kind: 'ACCONTO', status: 'OPEN', amount: 56700, currency: 'EUR', dueDate: dayAt(3), paidAt: null }],
  }
}

export function progressRead(): ProgressRead {
  const stages = PROGRESS_STAGES.map((key) => ({ key, words: PROGRESS_STAGE_WORDS[key] }))
  const line = (lineId: string, seq: number, style: { code: string; name: string }, colourway: { code: string; name: string }, run: Record<string, [number, number, number, number, number]>) => {
    const sizesRun = Object.entries(run).map(([size, [ordered, cut, sewn, inspected, packed]]) => ({ size, ordered, cut, sewn, inspected, packed }))
    const sum = (key: 'ordered' | 'cut' | 'sewn' | 'inspected' | 'packed') => sizesRun.reduce((total, entry) => total + entry[key], 0)
    return { lineId, seq, style, colourway, ordered: sum('ordered'), cut: sum('cut'), sewn: sum('sewn'), inspected: sum('inspected'), packed: sum('packed'), sizes: sizesRun }
  }
  const lines = [
    line(id(201), 1, JACKET, BLACK, { '46': [4, 4, 4, 4, 4], '48': [8, 8, 8, 7, 6], '50': [10, 10, 9, 8, 6], '52': [6, 6, 4, 2, 2], '54': [2, 2, 0, 0, 0] }),
    line(id(202), 2, TROUSERS, SAND, { '46': [2, 2, 1, 0, 0], '48': [4, 4, 2, 0, 0], '50': [6, 6, 3, 0, 0], '52': [4, 2, 0, 0, 0] }),
  ]
  const whole = { ordered: 46, cut: 44, sewn: 31, inspected: 21, packed: 18 }
  return { asOf: at(0), refreshSeconds: 60, stages, lines, whole, percent: 62 }
}

/** A day as the API's words write it ("21 ott", "21 Oct"). */
const short = (locale: Locale, day: string) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
const CUT_DAY = dayAt(-18)

const verdict = (possible: boolean, code: Verdict['code'], it: string, en: string, day: string | null = null): Verdict => ({ possible, code, day, words: { it, en } })
export const FREE = verdict(true, 'FREE', 'Si può cambiare', 'Can change')

export function rulesOf(over: Partial<ChangeRules> = {}): ChangeRules {
  return {
    asOf: at(0),
    order: { id: ORDER_ID, number: 'SO-2026-0141', customerRef: 'BA-PO-771', status: 'PARTLY_SHIPPED', requestedDate: dayAt(5), promiseDate: dayAt(12), currency: 'EUR', version: 4 },
    change: FREE,
    cancel: verdict(false, 'CUT', `Non possibile: il taglio è iniziato il ${short('it', CUT_DAY)}`, `Not possible: cutting started on ${short('en', CUT_DAY)}`, CUT_DAY),
    lines: [
      {
        lineId: id(201),
        seq: 1,
        kind: 'SIZE_GRID',
        style: JACKET,
        colourway: BLACK,
        sizes: Object.entries({ '46': 4, '48': 8, '50': 10, '52': 6, '54': 2, '56': 0 }).map(([size, quantity]) => ({ size, quantity, offered: true })),
        change: verdict(false, 'LEATHER_CUT', `Non possibile: la pelle è stata tagliata il ${short('it', CUT_DAY)}`, `Not possible: the leather was cut on ${short('en', CUT_DAY)}`, CUT_DAY),
        cancel: verdict(false, 'LEATHER_CUT', `Non possibile: la pelle è stata tagliata il ${short('it', CUT_DAY)}`, `Not possible: the leather was cut on ${short('en', CUT_DAY)}`, CUT_DAY),
        cancelFee: 0,
      },
      {
        lineId: id(202),
        seq: 2,
        kind: 'SIZE_GRID',
        style: TROUSERS,
        colourway: SAND,
        sizes: Object.entries({ '46': 2, '48': 4, '50': 6, '52': 4, '54': 0 }).map(([size, quantity]) => ({ size, quantity, offered: true })),
        change: FREE,
        cancel: verdict(true, 'FREE', 'Libero', 'Free'),
        cancelFee: 29550,
      },
    ],
    cancelFee: { pct: '15', words: { it: 'Penale del 15% sul valore netto di ogni riga annullata', en: 'A fee of 15% of each cancelled line’s net value' }, currency: 'EUR', wholeOrderFee: 112800 },
    reasons: [
      { code: 'NOT_NEEDED', words: { it: 'Non ci serve più', en: 'We no longer need it' }, needsNote: false },
      { code: 'WRONG_ORDER', words: { it: 'Ordinato per errore', en: 'Ordered by mistake' }, needsNote: false },
      { code: 'OTHER', words: { it: 'Un altro motivo', en: 'Another reason' }, needsNote: true },
    ],
    addresses: [
      { id: id(401), label: 'Brand Alpha — Magazzino, Via Esempio 10, 20100 Milano' },
      { id: id(402), label: 'Brand Alpha — Negozio, Corso Finto 5, 10100 Torino' },
    ],
    noWithdrawal: null,
    openRequestId: null,
    live: LIVE,
    ...over,
  }
}

export function requestsOf(): ChangeRequest[] {
  return [
    {
      id: id(501),
      orderId: ORDER_ID,
      orderNumber: 'SO-2026-0141',
      customerRef: 'BA-PO-771',
      kind: 'CHANGE',
      kindWords: KIND_WORDS.CHANGE,
      status: 'OPEN',
      words: REQUEST_STATUS_WORDS.OPEN,
      askedAt: at(-6),
      cells: [{ lineId: id(202), seq: 2, style: TROUSERS, colourway: SAND, size: '50', before: 6, asked: 8 }],
      wholeOrder: false,
      requestedDate: dayAt(10),
      shipTo: null,
      reasonCode: null,
      reasonWords: null,
      note: 'Ci servono due 50 in più per il negozio.',
      answer: null,
      answeredAt: null,
      withdrawnAt: null,
      cancelFee: null,
      version: 1,
      mine: true,
    },
    {
      id: id(502),
      orderId: ORDER_ID,
      orderNumber: 'SO-2026-0141',
      customerRef: 'BA-PO-771',
      kind: 'CANCEL',
      kindWords: KIND_WORDS.CANCEL,
      status: 'REFUSED',
      words: REQUEST_STATUS_WORDS.REFUSED,
      askedAt: at(-10 * 24),
      cells: [{ lineId: id(201), seq: 1, style: JACKET, colourway: BLACK, size: null, before: 30, asked: 0 }],
      wholeOrder: false,
      requestedDate: null,
      shipTo: null,
      reasonCode: 'NOT_NEEDED',
      reasonWords: { it: 'Non ci serve più', en: 'We no longer need it' },
      note: null,
      answer: 'La pelle è già tagliata: possiamo spostare la consegna se vi aiuta.',
      answeredAt: at(-9 * 24),
      withdrawnAt: null,
      cancelFee: null,
      version: 2,
      mine: false,
    },
  ]
}

export function shipmentsRead(over: Partial<ShipmentsRead> = {}): ShipmentsRead {
  return {
    asOf: at(0),
    shipments: [
      {
        id: id(101),
        number: 'SH-2026-0233',
        status: 'IN_TRANSIT',
        words: SHIPMENT_STATUS_WORDS.IN_TRANSIT,
        transportBy: 'CARRIER',
        carrierName: 'Corriere Demo',
        packedAt: at(-28),
        shippedAt: at(-20),
        deliveredAt: null,
        expectedDeliveryAt: at(30),
        ddt: { number: 'DDT-2026-0144', date: dayAt(-1) },
        milestones: [
          { key: 'PACKED', words: SHIPMENT_MILESTONE_WORDS.PACKED, done: true, at: at(-28) },
          { key: 'COLLECTED', words: SHIPMENT_MILESTONE_WORDS.COLLECTED, done: true, at: at(-20) },
          { key: 'IN_TRANSIT', words: SHIPMENT_MILESTONE_WORDS.IN_TRANSIT, done: true, at: at(-12) },
          { key: 'DELIVERED', words: SHIPMENT_MILESTONE_WORDS.DELIVERED, done: false, at: null },
        ],
        parcels: [
          { seq: 1, trackingNumber: 'DEMO00012345', trackingLink: { url: 'https://tracking.example/DEMO00012345', words: { it: 'Segui sul sito del corriere', en: "Track on the carrier's site" } }, status: 'IN_TRANSIT', words: TRACKING_WORDS.IN_TRANSIT, lastEvent: { at: at(-3), status: 'IN_TRANSIT', words: TRACKING_WORDS.IN_TRANSIT, description: 'Hub Demo', location: 'Bologna', parcelSeq: 1 } },
          { seq: 2, trackingNumber: 'DEMO00012346', trackingLink: null, status: 'IN_TRANSIT', words: TRACKING_WORDS.IN_TRANSIT, lastEvent: null },
        ],
        events: [
          { at: at(-3), status: 'IN_TRANSIT', words: TRACKING_WORDS.IN_TRANSIT, description: 'Hub Demo', location: 'Bologna', parcelSeq: 1 },
          { at: at(-20), status: 'LABEL_CREATED', words: TRACKING_WORDS.LABEL_CREATED, description: null, location: 'Firenze', parcelSeq: null },
        ],
        lines: [
          { lineSeq: 1, style: JACKET, colourway: BLACK, size: '46', quantity: 4 },
          { lineSeq: 1, style: JACKET, colourway: BLACK, size: '48', quantity: 6 },
          { lineSeq: 1, style: JACKET, colourway: BLACK, size: '50', quantity: 6 },
          { lineSeq: 1, style: JACKET, colourway: BLACK, size: '52', quantity: 2 },
        ],
        papers: [
          { fileId: id(601), name: 'DDT-2026-0144.pdf', contentType: 'application/pdf', sizeBytes: 182_000, versionNo: 1 },
          { fileId: id(602), name: 'Dichiarazione-conformita-JKT-DEMO-01.pdf', contentType: 'application/pdf', sizeBytes: 240_000, versionNo: 2 },
        ],
      },
    ],
    stillToShip: [
      { lineId: id(201), seq: 1, style: JACKET, colourway: BLACK, size: '48', ordered: 8, shipped: 6, open: 2, expected: dayAt(12) },
      { lineId: id(201), seq: 1, style: JACKET, colourway: BLACK, size: '50', ordered: 10, shipped: 6, open: 4, expected: dayAt(12) },
      { lineId: id(202), seq: 2, style: TROUSERS, colourway: SAND, size: '50', ordered: 6, shipped: 0, open: 6, expected: dayAt(9) },
    ],
    firstExpected: null,
    live: LIVE,
    ...over,
  }
}

const doc = (n: number, kind: string, kindWords: { it: string; en: string }, title: { it: string; en: string }, over: Partial<DocumentsRead['items'][number]> = {}): DocumentsRead['items'][number] => ({
  id: id(700 + n),
  kind,
  kindWords,
  group: 'ORDERS',
  title,
  date: at(-n * 24),
  version: 1,
  fingerprint: `3f9a1c2b0d4${n}`,
  language: 'it',
  current: true,
  replacedBy: null,
  new: false,
  files: [{ fileId: id(700 + n), format: 'PDF', name: `${title.en}.pdf`, contentType: 'application/pdf', sizeBytes: 120_000 }],
  grossTotal: null,
  currency: null,
  ...over,
})

export function documentsRead(over: Partial<DocumentsRead> = {}): DocumentsRead {
  const confirmation = { it: 'Conferma d’ordine', en: 'Order confirmation' }
  return {
    asOf: at(0),
    seesPrices: true,
    count: 5,
    items: [
      doc(1, 'DDT', { it: 'Documento di trasporto', en: 'Delivery note' }, { it: 'DDT-2026-0144', en: 'DDT-2026-0144' }, { group: 'DELIVERY', new: true }),
      doc(2, 'DECLARATION_OF_CONFORMITY', { it: 'Dichiarazione di conformità', en: 'Declaration of conformity' }, { it: 'DoC JKT-DEMO-01 rev. 2', en: 'DoC JKT-DEMO-01 rev. 2' }, { group: 'CONFORMITY', version: 2 }),
      doc(3, 'ORDER_CONFIRMATION', { it: 'Conferma d’ordine', en: 'Order confirmation' }, confirmation, { version: 2 }),
      doc(9, 'ORDER_CONFIRMATION', { it: 'Conferma d’ordine', en: 'Order confirmation' }, confirmation, { current: false, replacedBy: { id: id(703), title: confirmation, version: 2 } }),
      doc(4, 'DEPOSIT_INVOICE', { it: 'Fattura di acconto', en: 'Deposit invoice' }, { it: 'FT-2026-00031', en: 'FT-2026-00031' }, { group: 'FINANCE', grossTotal: 275232, currency: 'EUR', files: [{ fileId: id(704), format: 'PDF', name: 'FT-2026-00031.pdf', contentType: 'application/pdf', sizeBytes: 90_000 }, { fileId: id(714), format: 'XML', name: 'FT-2026-00031.xml', contentType: 'application/xml', sizeBytes: 9_000 }] }),
    ],
    live: LIVE,
    ...over,
  }
}

export function approvalPage(over: Partial<ApprovalPage['request']> = {}, may: Partial<ApprovalPage['may']> = {}): ApprovalPage {
  return {
    request: { id: id(801), kind: 'REVISED_ORDER', question: 'Abbiamo aggiunto due giacche taglia 52 come da telefonata: confermate la nuova versione?', dueAt: at(4 * 24), status: 'OPEN', answer: null, version: 1, ...over },
    content: {
      revisedOrder: {
        orderNumber: 'SO-2026-0141',
        revision: 2,
        reason: 'Due pezzi in più nella taglia 52',
        currency: 'EUR',
        lines: [{ change: 'CHANGED', lineId: id(201), seq: 1, style: JACKET, colour: BLACK, piecesBefore: 28, piecesAfter: 30, sizes: [{ size: '52', before: 4, after: 6 }], priceChanged: false }],
        header: [{ field: 'requestedDate', before: dayAt(3), after: dayAt(5) }],
        prices: [{ lineId: id(201), unitPrice: null, netBefore: 518000, netAfter: 555000 }],
        netAmountBefore: 715000,
        netAmountAfter: 752000,
        grossAmountBefore: 872300,
        grossAmountAfter: 917440,
      },
    },
    may: { answer: true, withChanges: false, held: null, ...may },
  }
}

export function threadOf(locale: Locale): ThreadViewModel {
  const portal = words(locale, 'portal')
  const messages: PartnerMessage[] = [
    {
      id: 'm1',
      side: 'company',
      channel: 'email',
      author: { name: 'Giulia Esempio', mine: false },
      body: locale === 'it' ? 'Buongiorno, la prima spedizione di SO-2026-0141 è partita ieri.' : 'Good morning, the first shipment of SO-2026-0141 left yesterday.',
      attachments: [],
      at: at(-20),
      atText: formatDateTime(at(-20), { locale }),
    },
    {
      id: 'm2',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Anna Esempio', mine: true },
      body: locale === 'it' ? 'Grazie! Le taglie 54 arrivano con la seconda?' : 'Thank you! Do the size 54 pieces come with the second one?',
      at: at(-4),
      atText: formatDateTime(at(-4), { locale }),
    },
  ]
  return { state: 'ready', record: null, companyName: 'Pelletteria Esempio', messages, composer: { value: '', busy: false, heldReason: null, hint: portal('thread.hint'), limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}

export { NO_WITHDRAWAL_WORDS }
