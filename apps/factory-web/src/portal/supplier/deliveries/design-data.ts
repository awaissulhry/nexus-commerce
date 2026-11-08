import type { Locale } from '../../../lib/i18n/locales'
import { at, dayAt, PO_ID, PREFIX, shellOf as orderShellOf, words as orderWords } from '../orders/design-data'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { LineChoice, Notice, NoticeHide, NoticeLine, NoticePage, NoticeRow, NoticesRead, Reason, SheetRead, ShippableRead } from './api'
import { NS } from './model'

/**
 * SCR-227's made-up world (B-W2b-186; PLAN §3.1), the same as SCR-189's: an invented buying company (Officina Demo) and an
 * invented tannery (Conceria Prova S.p.A., its person Luca Prova), purchase order PO-2026-0101 with a black nappa by the ft²
 * and a lining by the metre, ship notices ASN-2026-0007…0014, hides 2231-001… of dye batch 2231. Never a real company,
 * person or number; never a price.
 */

export { at, dayAt, PREFIX }
export const words = (locale: Locale) => orderWords(locale, NS)
export const shellOf = (locale: Locale, over: Partial<PortalShellViewModel> = {}): PortalShellViewModel => orderShellOf(locale, { path: '/deliveries', ...over })

const id = (n: number) => `0190f0e2-7777-7000-8227-${String(n).padStart(12, '0')}`
export const ORDER = { id: PO_ID, number: 'PO-2026-0101' }
const PO2 = { id: id(902), number: 'PO-2026-0104' }

// ── the order's open lines ───────────────────────────────────────────────────────────────────────────────────────────
export const LEATHER: LineChoice = {
  purchaseOrderLineId: id(10),
  seq: 10,
  item: { code: 'PEL-NAP-NERO', name: 'Nappa nera 1,2', leather: true },
  supplierArticleCode: 'CP-NAPPA-NR',
  colour: 'Nero',
  uom: 'FT2',
  expected: '1200.0000',
  received: '0.0000',
  inTransit: '0.0000',
  open: '1200.0000',
  needDate: dayAt(10),
  confirmedDate: dayAt(12),
  grade: 'A',
  thicknessMinMm: '1.10',
  thicknessMaxMm: '1.30',
  oneDyeBatch: true,
  tolerancePct: '5',
  estimatedHides: 55,
  requiresCrViTest: true,
}
export const LINING: LineChoice = {
  ...LEATHER,
  purchaseOrderLineId: id(20),
  seq: 20,
  item: { code: 'TES-FOD-01', name: 'Fodera tela', leather: false },
  supplierArticleCode: null,
  colour: 'Grigio',
  uom: 'M',
  expected: '300.0000',
  open: '300.0000',
  needDate: dayAt(14),
  confirmedDate: null,
  grade: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  oneDyeBatch: false,
  tolerancePct: null,
  estimatedHides: null,
  requiresCrViTest: false,
}

export const SHIPPABLE: ShippableRead = {
  mayWrite: true,
  orders: [
    { id: ORDER.id, number: ORDER.number, documentNumber: ORDER.number, status: 'CONFIRMED', lines: [LEATHER, LINING] },
    { id: PO2.id, number: PO2.number, documentNumber: `${PO2.number} rev. 2`, status: 'PARTLY_RECEIVED', lines: [{ ...LINING, purchaseOrderLineId: id(30), seq: 10, open: '120.0000', needDate: dayAt(20) }] },
  ],
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const row = (n: number, state: NoticeRow['state'], over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: id(n),
  number: state === 'DRAFT' ? null : `ASN-2026-00${String(n).padStart(2, '0')}`,
  status: state === 'DRAFT' ? 'DRAFT' : state === 'CANCELLED' ? 'CANCELLED' : state.startsWith('RECEIVED') ? 'RECEIVED' : 'SENT',
  state,
  purchaseOrder: ORDER,
  shipDate: dayAt(-n + 13),
  expectedDate: dayAt(-n + 15),
  carrier: 'Corriere Esempio',
  trackingNumber: `CE-000${200 + n}`,
  ddtNumber: `DDT ${100 + n}/26`,
  supplierRef: `SP-${2220 + n}`,
  parcels: 3,
  sentAt: state === 'DRAFT' ? null : at(-24 * (16 - n)),
  lines: 2,
  hides: 48,
  differing: state === 'RECEIVED_WITH_DIFFERENCES' ? 1 : 0,
  version: 4,
  ...over,
})

export const ROWS: readonly NoticeRow[] = [
  row(15, 'DRAFT', { shipDate: null, expectedDate: null, carrier: null, trackingNumber: null, ddtNumber: null, supplierRef: null, hides: 0, lines: 1 }),
  row(14, 'IN_TRANSIT'),
  row(13, 'ANNOUNCED', { shipDate: dayAt(3), expectedDate: dayAt(5), trackingNumber: null }),
  row(11, 'RECEIVED_WITH_DIFFERENCES', { purchaseOrder: PO2 }),
  row(9, 'RECEIVED', { hides: 0, lines: 1 }),
  row(7, 'CANCELLED', { hides: 0 }),
]

export function noticesRead(items: readonly NoticeRow[] = ROWS, over: Partial<NoticesRead> = {}): NoticesRead {
  const counts: Record<string, number> = {}
  for (const entry of ROWS) counts[entry.state] = (counts[entry.state] ?? 0) + 1
  return { asOf: at(0), mayWrite: true, counts, items: [...items], more: false, live: { events: ['ship_notice.sent', 'ship_notice.changed', 'ship_notice.cancelled', 'ship_notice.received', 'ship_notice.reopened'] }, ...over }
}

// ── one notice ───────────────────────────────────────────────────────────────────────────────────────────────────────
const reason = (code: string, verdict: Reason['verdict'], params: Reason['params'] = {}): Reason => ({ code, verdict, params })

const hide = (n: number, over: Partial<NoticeHide> = {}): NoticeHide => ({
  id: id(100 + n),
  seq: n,
  hideNumber: `2231-${String(n).padStart(3, '0')}`,
  area: ['21.40', '19.85', '22.10', '20.75', '23.05', '18.90'][(n - 1) % 6]!,
  areaUom: 'FT2',
  grade: 'A',
  thicknessMm: '1.20',
  dyeBatch: '2231',
  note: null,
  verdict: 'OK',
  reasons: [],
  ...over,
})

export const HIDES: readonly NoticeHide[] = [
  hide(1),
  hide(2),
  hide(3, { thicknessMm: null, verdict: 'CHECK', reasons: [reason('NO_THICKNESS', 'CHECK', { min: '1.10', max: '1.30' })] }),
  hide(4),
  hide(17, { grade: 'B', verdict: 'NOT_AS_ORDERED', reasons: [reason('GRADE', 'NOT_AS_ORDERED', { grade: 'B', asked: 'A' })], note: 'Piccola cicatrice sul fianco' }),
  hide(6, { dyeBatch: '2232', verdict: 'NOT_AS_ORDERED', reasons: [reason('DYE_BATCH', 'NOT_AS_ORDERED', { batch: '2232', main: '2231' })] }),
]

const leatherLine = (hides: readonly NoticeHide[], over: Partial<NoticeLine> = {}): NoticeLine => ({
  id: id(210),
  seq: 10,
  purchaseOrderLineId: LEATHER.purchaseOrderLineId,
  orderSeq: 10,
  item: LEATHER.item,
  supplierArticleCode: LEATHER.supplierArticleCode,
  colour: LEATHER.colour,
  quantity: '126.0500',
  uom: 'FT2',
  supplierLot: 'L-2231',
  dyeBatch: '2231',
  note: null,
  receivedQuantity: null,
  verdict: hides.some((entry) => entry.verdict === 'NOT_AS_ORDERED') ? 'NOT_AS_ORDERED' : hides.length === 0 ? 'CHECK' : 'OK',
  reasons: hides.length === 0 ? [reason('NO_PACKING_LIST', 'CHECK'), reason('CR_VI', 'CHECK')] : [reason('CR_VI', 'CHECK'), reason('HIDE_COUNT', 'CHECK', { count: hides.length, area: '126.05', uom: 'FT2', estimate: 6 })].slice(0, 1),
  figures: { hides: hides.length, area: hides.length > 0 ? '126.0500' : null, expected: '1200.0000', before: '0.0000', upTo: '1260.0000', openAfter: '1073.9500' },
  hides: [...hides],
  ...over,
})

const liningLine = (over: Partial<NoticeLine> = {}): NoticeLine => ({
  id: id(220),
  seq: 20,
  purchaseOrderLineId: LINING.purchaseOrderLineId,
  orderSeq: 20,
  item: LINING.item,
  supplierArticleCode: null,
  colour: LINING.colour,
  quantity: '150.0000',
  uom: 'M',
  supplierLot: null,
  dyeBatch: null,
  note: null,
  receivedQuantity: null,
  verdict: 'OK',
  reasons: [],
  figures: { hides: 0, area: null, expected: '300.0000', before: '0.0000', upTo: '300.0000', openAfter: '150.0000' },
  hides: [],
  ...over,
})

export function notice(over: Partial<Notice> = {}): Notice {
  const lines = over.lines ?? [leatherLine(HIDES), liningLine()]
  const hides = lines.flatMap((line) => line.hides)
  const verdicts = [...lines.map((line) => line.verdict), ...hides.map((entry) => entry.verdict)]
  return {
    id: id(14),
    number: 'ASN-2026-0014',
    status: 'SENT',
    state: 'IN_TRANSIT',
    purchaseOrder: ORDER,
    siteId: id(990),
    supplierRef: 'SP-2234',
    ddtNumber: 'DDT 114/26',
    ddtDate: dayAt(-1),
    shipDate: dayAt(-1),
    expectedDate: dayAt(1),
    carrier: 'Corriere Esempio',
    trackingNumber: 'CE-000214',
    parcels: 3,
    note: 'Pelli 2231-017 e 2231-006 segnalate: vedi distinta.',
    sentAt: at(-30),
    receivedAt: null,
    cancelledAt: null,
    cancelReason: null,
    version: 4,
    verdict: verdicts.includes('NOT_AS_ORDERED') ? 'NOT_AS_ORDERED' : verdicts.includes('CHECK') ? 'CHECK' : 'OK',
    counts: { ok: hides.filter((entry) => entry.verdict === 'OK').length, check: hides.filter((entry) => entry.verdict === 'CHECK').length, notAsOrdered: hides.filter((entry) => entry.verdict === 'NOT_AS_ORDERED').length },
    differing: [],
    lines: [...lines],
    ...over,
  }
}

export function noticePage(over: Partial<NoticePage> = {}, noticeOver: Partial<Notice> = {}): NoticePage {
  return {
    notice: notice(noticeOver),
    site: { id: id(990), code: 'A1', name: 'Stabilimento Demo A' },
    mayWrite: true,
    canEdit: true,
    canSend: false,
    canCancel: true,
    sendHeld: [],
    warnings: [],
    addable: [],
    live: { events: ['ship_notice.changed', 'ship_notice.cancelled', 'ship_notice.received', 'ship_notice.reopened'] },
    ...over,
  }
}

/** A draft: the leather line and the lining, with or without its packing list, its terms typed or not. */
export function draftPage(input: { hides?: readonly NoticeHide[]; terms?: boolean; leather?: boolean } = {}): NoticePage {
  const hides = input.hides ?? []
  const lines = input.leather === false ? [liningLine()] : [leatherLine(hides), liningLine()]
  const terms = input.terms ?? false
  return noticePage(
    { canSend: terms && !hides.some((entry) => entry.verdict === 'NOT_AS_ORDERED'), sendHeld: terms ? [] : ['Give the day the goods leave.', 'Give the day the goods arrive: our dock plans by it.'], addable: [] },
    {
      id: id(15),
      number: null,
      status: 'DRAFT',
      state: 'DRAFT',
      lines,
      sentAt: null,
      note: null,
      ...(terms ? {} : { shipDate: null, expectedDate: null, carrier: null, trackingNumber: null, ddtNumber: null, ddtDate: null, parcels: null, supplierRef: null }),
    },
  )
}

/** The tannery's sheet as read (nothing kept): verdicts per row, two rows that do not read. */
export function sheetRead(unreadable = true): SheetRead {
  const rows: SheetRead['rows'] = HIDES.map((entry, index) => ({
    rowNumber: index + 2,
    hideNumber: entry.hideNumber,
    line: 10,
    area: entry.area,
    unit: 'FT2',
    grade: entry.grade,
    thicknessMm: entry.thicknessMm,
    dyeBatch: entry.dyeBatch,
    errors: [],
    verdict: entry.verdict,
    reasons: entry.reasons,
  }))
  const bad: SheetRead['rows'] = unreadable
    ? [
        { rowNumber: 14, hideNumber: '2231-012', line: 10, area: null, unit: 'FT2', grade: 'A', thicknessMm: '1.20', dyeBatch: '2231', errors: [{ column: 'area' }], verdict: null, reasons: [] },
        { rowNumber: 15, hideNumber: '2231-002', line: 10, area: '20.10', unit: 'FT2', grade: 'A', thicknessMm: '1.25', dyeBatch: '2231', errors: [{ column: 'hideNumber' }], verdict: null, reasons: [] },
      ]
    : []
  return {
    fileName: 'distinta-2231.xlsx',
    format: 'xlsx',
    sheet: 'Distinta',
    numberFormat: 'it',
    columns: ['hideNumber', 'area', 'unit', 'line', 'grade', 'thicknessMm', 'dyeBatch'],
    ignored: unreadable ? ['Colore'] : [],
    rows: [...rows, ...bad],
    unreadable: bad.length,
    verdict: unreadable ? null : 'NOT_AS_ORDERED',
    lines: [{ lineId: id(210), seq: 10, verdict: 'NOT_AS_ORDERED', reasons: [reason('CR_VI', 'CHECK')], hides: HIDES.length, area: '126.0500', expected: '1200.0000', before: '0.0000', upTo: '1260.0000', openAfter: '1073.9500' }],
    applied: false,
    page: null,
  }
}

export const HIDE_17 = id(117)
export const NOTICE_ID = id(14)
export const DRAFT_ID = id(15)
export { leatherLine, liningLine }
