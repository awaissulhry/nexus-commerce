import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import type { PortalBand } from '../../shell/frame'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { CatalogueRead, StyleCard, StyleDetail } from '../catalogue/api'
import { shellOf as ordersShellOf } from '../orders/design-data'
import type { DraftLine, DraftRecord, DraftRow, PastOrder, PastOrderRow, ShipTo, UploadAnswer } from './api'
import { NS } from './model'
import { orderingWordsFor, type OrderingWords } from './words'

/**
 * SCR-185 and SCR-226's made-up world (B-W2b-194; PLAN §3.1): the invented maker Pelletteria Esempio and its invented
 * customer Brand Alpha S.r.l. (as SCR-184), their PO numbers BA-PO-…, our orders SO-2026-…, requests RQ-…, three made-up
 * styles (a jacket, trousers, gloves) with made-up colours, sizes and prices. Never a real company, person, address or
 * number.
 */

const HOUR = 3_600_000
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const dayAt = (days: number) => at(days * 24).slice(0, 10)
export const TODAY = dayAt(0)
export const PREFIX = '/p/BRAND-ALPHA'
export const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
export const orderingWords = (locale: Locale): OrderingWords => orderingWordsFor(words(locale), locale)

const id = (n: number) => `0194f0e2-1940-7000-8000-${String(n).padStart(12, '0')}`

export function shellOf(locale: Locale, band: PortalBand, path: string, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel {
  return ordersShellOf(locale, band, { path, badges: {}, ...over })
}

// ── the catalogue ───────────────────────────────────────────────────────────────────────────────────────────────────────
const colour = (n: number, code: string, name: string) => ({ id: id(100 + n), code, name })
const BLK = colour(1, 'BLK', 'Nero Esempio')
const RED = colour(2, 'RED', 'Rosso Esempio')
const NAV = colour(3, 'NAV', 'Blu Esempio')
const BRN = colour(4, 'BRN', 'Marrone Esempio')

export const STYLES: readonly StyleCard[] = [
  {
    id: id(1),
    code: 'JKT-100',
    name: 'Giacca Corsa Esempio',
    nameI18n: { it: 'Giacca Corsa Esempio', en: 'Example Race Jacket' },
    productType: 'JACKET',
    season: 'FW27',
    ownLabel: true,
    colours: [BLK, RED],
    sizes: ['46', '48', '50', '52', '54', '56'],
    range: '46–56',
    ppe: { category: 'CATEGORY_II', standard: 'EN 17092-3', class: 'AA' },
    priceFrom: '410.00',
  },
  {
    id: id(2),
    code: 'TRS-200',
    name: 'Pantalone Touring Esempio',
    nameI18n: { it: 'Pantalone Touring Esempio', en: 'Example Touring Trousers' },
    productType: 'TROUSERS',
    season: 'FW27',
    ownLabel: false,
    colours: [BLK, NAV],
    sizes: ['46', '48', '50', '52', '54'],
    range: '46–54',
    ppe: { category: 'CATEGORY_II', standard: 'EN 17092-4', class: 'A' },
    priceFrom: '265.00',
  },
  {
    id: id(3),
    code: 'GLV-300',
    name: 'Guanto Estate Esempio',
    nameI18n: null,
    productType: 'GLOVES',
    season: 'SS27',
    ownLabel: false,
    colours: [BLK],
    sizes: ['S', 'M', 'L', 'XL'],
    range: 'S–XL',
    ppe: { category: 'NOT_PPE', standard: null, class: null },
    priceFrom: '48.50',
  },
]

export function catalogueRead(over: Partial<CatalogueRead> = {}, seesPrices = true): CatalogueRead {
  const styles = (over.styles ?? STYLES).map((style) => (seesPrices ? style : { ...style, priceFrom: undefined }))
  return {
    styles,
    count: styles.length,
    total: STYLES.length,
    facets: {
      categories: [
        { value: 'GLOVES', count: 1 },
        { value: 'JACKET', count: 1 },
        { value: 'TROUSERS', count: 1 },
      ],
      seasons: [
        { value: 'FW27', count: 2 },
        { value: 'SS27', count: 1 },
      ],
      ppe: [
        { value: 'CATEGORY_II', count: 2 },
        { value: 'NOT_PPE', count: 1 },
      ],
      ownLabel: 1,
      openRange: 2,
    },
    currency: 'EUR',
    asOf: at(0),
    seesPrices,
    ...over,
  }
}

export function styleDetail(seesPrices = true): StyleDetail {
  const style = STYLES[0]!
  const sizes = (offered: readonly string[]) => style.sizes.map((size) => ({ size, offered: offered.includes(size) }))
  return {
    style: {
      ...style,
      ...(seesPrices ? {} : { priceFrom: undefined }),
      description: 'Giacca in pelle bovina con protezioni su spalle e gomiti (testo di esempio).',
      baseSize: '50',
      revision: 3,
      colourways: [
        { ...BLK, sizes: sizes(['46', '48', '50', '52', '54', '56']), ...(seesPrices ? { price: '410.00' } : {}) },
        { ...RED, sizes: sizes(['48', '50', '52', '54']), ...(seesPrices ? { price: '425.00' } : {}) },
      ],
    },
    currency: 'EUR',
    asOf: at(0),
    seesPrices,
  }
}

// ── a draft ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ADDRESSES: readonly ShipTo[] = [
  { id: id(201), name: 'Magazzino Esempio', line1: 'Via Esempio 12', line2: null, postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', contactName: 'Anna Esempio', phone: null, deliveryNotes: null, isDefault: true, status: 'ACTIVE', approval: null, version: 1 },
  { id: id(202), name: 'Negozio Esempio', line1: 'Corso Finto 3', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT', contactName: null, phone: null, deliveryNotes: null, isDefault: false, status: 'ACTIVE', approval: { status: 'APPROVED' }, version: 2 },
  { id: id(203), name: 'Deposito Nuovo Esempio', line1: 'Via Inventata 7', line2: null, postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT', contactName: null, phone: null, deliveryNotes: null, isDefault: false, status: 'ACTIVE', approval: { status: 'WAITING' }, version: 1 },
]

const JKT_SIZES = ['46', '48', '50', '52', '54', '56']

export function lineOf(n: number, over: Partial<DraftLine> = {}, seesPrices = true): DraftLine {
  const base: DraftLine = {
    id: id(300 + n),
    seq: n,
    version: 1,
    style: { id: STYLES[0]!.id, code: 'JKT-100', name: 'Giacca Corsa Esempio' },
    colourway: BLK,
    sizes: [
      { size: '48', quantity: 4, offered: true },
      { size: '50', quantity: 8, offered: true },
      { size: '52', quantity: 6, offered: true },
    ],
    offered: JKT_SIZES,
    colours: [BLK, RED],
    pieces: 18,
    unitPriceShown: '410.00',
    priceNow: '410.00',
    amount: '7380.00',
    note: null,
    source: null,
    notices: [],
    problems: [],
  }
  const line = { ...base, ...over }
  return seesPrices ? line : { ...line, unitPriceShown: undefined, priceNow: undefined, amount: undefined }
}

export const LINE_TROUSERS = (seesPrices = true) =>
  lineOf(
    2,
    {
      style: { id: STYLES[1]!.id, code: 'TRS-200', name: 'Pantalone Touring Esempio' },
      colourway: NAV,
      colours: [BLK, NAV],
      offered: ['46', '48', '50', '52', '54'],
      sizes: [
        { size: '48', quantity: 3, offered: true },
        { size: '50', quantity: 5, offered: true },
      ],
      pieces: 8,
      unitPriceShown: '265.00',
      priceNow: '265.00',
      amount: '2120.00',
      note: 'BA-TR-7',
    },
    seesPrices,
  )

export function draftRecord(over: { lines?: DraftLine[]; request?: Partial<DraftRecord['request']>; seesPrices?: boolean; addresses?: readonly ShipTo[] } = {}): DraftRecord {
  const seesPrices = over.seesPrices ?? true
  const lines = over.lines ?? [lineOf(1, {}, seesPrices), LINE_TROUSERS(seesPrices)]
  const pieces = lines.reduce((sum, line) => sum + line.sizes.reduce((total, row) => total + row.quantity, 0), 0)
  const net = lines.reduce((sum, line) => sum + Number(line.unitPriceShown ?? 0) * line.sizes.reduce((total, row) => total + row.quantity, 0), 0)
  return {
    request: {
      id: id(400),
      number: null,
      status: 'DRAFT',
      source: 'PICKER',
      customerRef: 'BA-PO-4521',
      shipToAddressId: ADDRESSES[0]!.id,
      requestedDate: dayAt(42),
      note: null,
      currency: 'EUR',
      createdAt: at(-26),
      updatedAt: at(-1),
      sentAt: null,
      decidedAt: null,
      salesOrder: null,
      quote: null,
      version: 7,
      lines,
      summary: { lines: lines.length, pieces, ...(seesPrices ? { net: net.toFixed(2) } : {}) },
      problems: lines.flatMap((line) => line.problems),
      pricesChanged: lines.filter((line) => line.problems.some((problem) => problem.code === 'PRICE_CHANGED')).length,
      ...over.request,
    },
    addresses: [...(over.addresses ?? ADDRESSES)],
    seesPrices,
  }
}

export const DRAFTS: readonly DraftRow[] = [
  { id: id(400), number: null, status: 'DRAFT', source: 'PICKER', customerRef: 'BA-PO-4521', lines: 2, pieces: 26, createdAt: at(-26), updatedAt: at(-1), version: 7 },
  { id: id(401), number: null, status: 'DRAFT', source: 'UPLOAD', customerRef: null, lines: 5, pieces: 140, createdAt: at(-24 * 6), updatedAt: at(-24 * 5), version: 3 },
]

// ── reorder ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const PAST_ORDERS: readonly PastOrderRow[] = [
  { id: id(501), number: 'SO-2026-0141', customerRef: 'BA-PO-4410', orderDate: dayAt(-60), lines: 3, pieces: 74 },
  { id: id(502), number: 'SO-2026-0098', customerRef: 'BA-PO-4302', orderDate: dayAt(-120), lines: 2, pieces: 40 },
  { id: id(503), number: 'SO-2025-0412', customerRef: null, orderDate: dayAt(-300), lines: 1, pieces: 12 },
]

export function pastOrder(seesPrices = true): PastOrder {
  const price = (value: string) => (seesPrices ? value : undefined)
  return {
    order: { id: id(501), number: 'SO-2026-0141', customerRef: 'BA-PO-4410', orderDate: dayAt(-60) },
    lines: [
      {
        orderLineId: id(601),
        seq: 1,
        style: { id: STYLES[0]!.id, code: 'JKT-100', name: 'Giacca Corsa Esempio' },
        colourway: BLK,
        sizesOrdered: [
          { size: '48', quantity: 6 },
          { size: '50', quantity: 10 },
          { size: '52', quantity: 8 },
          { size: '58', quantity: 2 },
        ],
        sizes: [
          { size: '48', quantity: 6 },
          { size: '50', quantity: 10 },
          { size: '52', quantity: 8 },
        ],
        pieces: 26,
        unitPriceThen: price('400.00'),
        priceNow: price('410.00'),
        addable: true,
        needsColour: false,
        colours: [BLK, RED],
        notices: [...(seesPrices ? [{ code: 'PRICE_CHANGED' as const }] : []), { code: 'SIZES_DROPPED' as const }],
      },
      {
        orderLineId: id(602),
        seq: 2,
        style: { id: STYLES[1]!.id, code: 'TRS-200', name: 'Pantalone Touring Esempio' },
        colourway: BRN,
        sizesOrdered: [
          { size: '48', quantity: 10 },
          { size: '50', quantity: 12 },
        ],
        sizes: [
          { size: '48', quantity: 10 },
          { size: '50', quantity: 12 },
        ],
        pieces: 22,
        unitPriceThen: price('265.00'),
        priceNow: price('265.00'),
        addable: false,
        needsColour: true,
        colours: [BLK, NAV],
        notices: [{ code: 'COLOUR_DISCONTINUED' }],
      },
      {
        orderLineId: id(603),
        seq: 3,
        style: { id: id(9), code: 'VST-900', name: 'Gilet Esempio' },
        colourway: BLK,
        sizesOrdered: [{ size: 'M', quantity: 26 }],
        sizes: [],
        pieces: 26,
        unitPriceThen: price('120.00'),
        priceNow: undefined,
        addable: false,
        needsColour: false,
        colours: [],
        notices: [{ code: 'STYLE_NOT_SOLD' }],
      },
    ],
    seesPrices,
  }
}

// ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function uploadAnswer(): UploadAnswer {
  const ready = (rowNumber: number, size: string, quantity: number) => ({ rowNumber, status: 'READY' as const, style: 'JKT-100', colour: 'BLK', size, quantity, yourCode: 'BA-J-1', styleId: STYLES[0]!.id, colourwayId: BLK.id, reasons: [] })
  return {
    dryRun: {
      rows: 6,
      ready: 4,
      refused: 2,
      verdicts: [
        ready(2, '48', 4),
        ready(3, '50', 6),
        ready(4, '52', 6),
        { rowNumber: 5, status: 'REFUSED', style: 'JKT-100', colour: 'BLK', size: '62', quantity: 2, yourCode: 'BA-J-1', styleId: null, colourwayId: null, reasons: [{ it: 'Taglia 62 non offerta per JKT-100 BLK.', en: 'Size 62 not offered for JKT-100 BLK.' }] },
        { rowNumber: 6, status: 'REFUSED', style: 'JKT-100', colour: 'RED', size: '50', quantity: null, yourCode: null, styleId: null, colourwayId: null, reasons: [{ it: 'Quantity: must be a whole number', en: 'Quantity: must be a whole number' }] },
        ready(7, '54', 3),
      ],
      lines: [{ styleId: STYLES[0]!.id, styleCode: 'JKT-100', colourwayId: BLK.id, colourwayCode: 'BLK', sizes: [{ size: '48', quantity: 4 }], note: 'BA-J-1' }],
      refusedCsv: 'Row;Style;Colour;Size;Quantity;Your code;Reason\r\n5;JKT-100;BLK;62;2;BA-J-1;Size 62 not offered\r\n',
      columns: [],
      ignored: ['Season'],
    },
    applied: false,
    record: null,
  }
}
