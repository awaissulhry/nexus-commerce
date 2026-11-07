import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { QUANTITY_SCALE } from '../../inventory/ledger/moves'
import { HIDE_AREA_UNITS, MAX_THICKNESS_MM, RECEIPT_LIMITS } from '../../inventory/receipts/rules'
import { fixedRatio, type Uom } from '../../product/units/units'
import { Dec, HUNDRED, parseDecimal, ZERO, type Decimal } from '../../tax/decimal'

/**
 * Ship notices (B-W2b-182; SCM-106 "Create ship notice from PO", SCM-107 "Leather packing list on the ASN"; design
 * portal.supplier.asn and warehouse.receipts sec:rc-inbound), pure: what a supplier may announce, how its notice reads in
 * its own words, and the checks of a tannery's packing list against the purchase order BEFORE the truck leaves (area per
 * hide against the line's tolerance, the grade asked, the thickness range, one dye batch, the hide count, Cr VI evidence on
 * file). An Ariba ship notice carries items, quantities and batches; none of these checks.
 *
 * The verdicts (design "Verdict per row and per line: OK / Check (amber, reason) / Not as ordered (red, reason)"): a CHECK is
 * worth a look and never holds anything; NOT AS ORDERED goes only with a note to our dock ("differences can still be sent
 * with a note (we decide at receipt)"). Every reason has a code, its figures and its words in Italian and English. No price,
 * cost or amount anywhere (Owner answer C2).
 */

export interface Words {
  readonly it: string
  readonly en: string
}

export const SHIP_NOTICE_STATUSES = ['DRAFT', 'SENT', 'RECEIVED', 'CANCELLED'] as const
export type ShipNoticeStatus = (typeof SHIP_NOTICE_STATUSES)[number]

/** The orders a supplier announces goods of: confirmed (design "Open lines of confirmed POs"), or delivered in part. */
export const SHIPPABLE_ORDER_STATUSES = ['CONFIRMED', 'PARTLY_RECEIVED'] as const
export const isShippableOrder = (status: string): boolean => (SHIPPABLE_ORDER_STATUSES as readonly string[]).includes(status)

/** A notice changes until it is received (design "editable until received"); cancelled is final. */
export const isEditableNotice = (status: string): boolean => status === 'DRAFT' || status === 'SENT'

export const SHIP_NOTICE_LIMITS = Object.freeze({
  lines: 100,
  hides: RECEIPT_LIMITS.moves,
  /** The database's own limits: a reference, DDT, lot, dye batch or hide number; a carrier or tracking number; notes. */
  code: 60,
  text: 100,
  note: 2000,
  reason: 500,
  parcels: 9999,
})

// ---- how a notice reads ------------------------------------------------------------------------------------------------------

/** The design's statuses: Announced / In transit / Received / Received with differences, and the supplier's draft. */
export const NOTICE_STATES = ['DRAFT', 'ANNOUNCED', 'IN_TRANSIT', 'RECEIVED', 'RECEIVED_WITH_DIFFERENCES', 'CANCELLED'] as const
export type NoticeState = (typeof NOTICE_STATES)[number]

export const NOTICE_STATE_WORDS: Readonly<Record<NoticeState, Words>> = Object.freeze({
  DRAFT: { it: 'Bozza', en: 'Draft' },
  ANNOUNCED: { it: 'Annunciato', en: 'Announced' },
  IN_TRANSIT: { it: 'In viaggio', en: 'In transit' },
  RECEIVED: { it: 'Ricevuto', en: 'Received' },
  RECEIVED_WITH_DIFFERENCES: { it: 'Ricevuto con differenze', en: 'Received with differences' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
})

/** A line as the state reads it: what was announced and what our receipt took of it (null until received). */
export interface StateLine {
  readonly quantity: string
  readonly receivedQuantity: string | null
}

/** The lines whose received quantity differs from what was announced (design "with the lines that differ"). */
export const differingLines = <L extends StateLine>(lines: readonly L[]): L[] => lines.filter((line) => line.receivedQuantity !== null && !new Dec(line.receivedQuantity).equals(new Dec(line.quantity)))

/** The notice's state on a day: SENT is "In transit" once its ship date has come ("In transit" is derived, B-W2b-158). */
export function noticeStateOf(notice: { readonly status: string; readonly shipDate: BusinessDate | null; readonly lines: readonly StateLine[] }, today: BusinessDate): NoticeState {
  switch (notice.status) {
    case 'DRAFT':
      return 'DRAFT'
    case 'SENT':
      return notice.shipDate !== null && notice.shipDate <= today ? 'IN_TRANSIT' : 'ANNOUNCED'
    case 'RECEIVED':
      return differingLines(notice.lines).length > 0 ? 'RECEIVED_WITH_DIFFERENCES' : 'RECEIVED'
    default:
      return 'CANCELLED'
  }
}

// ---- the checks against the order --------------------------------------------------------------------------------------------

export const VERDICTS = ['OK', 'CHECK', 'NOT_AS_ORDERED'] as const
export type Verdict = (typeof VERDICTS)[number]
export const VERDICT_WORDS: Readonly<Record<Verdict, Words>> = Object.freeze({
  OK: { it: 'OK', en: 'OK' },
  CHECK: { it: 'Da verificare', en: 'Check' },
  NOT_AS_ORDERED: { it: 'Non come ordinato', en: 'Not as ordered' },
})
const RANK: Readonly<Record<Verdict, number>> = { OK: 0, CHECK: 1, NOT_AS_ORDERED: 2 }
export const worstOf = (verdicts: Iterable<Verdict>): Verdict => {
  let worst: Verdict = 'OK'
  for (const verdict of verdicts) if (RANK[verdict] > RANK[worst]) worst = verdict
  return worst
}

export const REASON_CODES = [
  'GRADE',
  'NO_GRADE',
  'THICKNESS',
  'NO_THICKNESS',
  'DYE_BATCH',
  'NO_DYE_BATCH',
  'DYE_BATCHES',
  'EARLIER_DYE_BATCH',
  'OVER_ORDER',
  'LIST_VS_LINE',
  'HIDE_COUNT',
  'NO_PACKING_LIST',
  'CR_VI',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export type ReasonParams = Readonly<Record<string, string | number>>
export interface Reason {
  readonly code: ReasonCode
  readonly verdict: Verdict
  readonly params: ReasonParams
  readonly words: Words
}

const TEMPLATES: Readonly<Record<ReasonCode, { readonly verdict: Verdict; readonly words: Words }>> = Object.freeze({
  GRADE: { verdict: 'NOT_AS_ORDERED', words: { it: 'Scelta {grade}: l’ordine chiede {asked}.', en: 'Grade {grade}: the order asks {asked}.' } },
  NO_GRADE: { verdict: 'CHECK', words: { it: 'Nessuna scelta indicata: l’ordine chiede {asked}.', en: 'No grade given: the order asks {asked}.' } },
  THICKNESS: { verdict: 'NOT_AS_ORDERED', words: { it: '{value} mm, fuori dai {min}–{max} mm chiesti.', en: '{value} mm, outside the {min}–{max} mm asked.' } },
  NO_THICKNESS: { verdict: 'CHECK', words: { it: 'Nessuno spessore indicato: l’ordine chiede {min}–{max} mm.', en: 'No thickness given: the order asks {min}–{max} mm.' } },
  DYE_BATCH: { verdict: 'NOT_AS_ORDERED', words: { it: 'Bagno {batch}: la riga spedisce il bagno {main} e l’ordine chiede un solo bagno.', en: 'Dye batch {batch}: the line ships dye batch {main} and the order asks one dye batch.' } },
  NO_DYE_BATCH: { verdict: 'CHECK', words: { it: 'Nessun bagno indicato: l’ordine chiede un solo bagno.', en: 'No dye batch given: the order asks one dye batch.' } },
  DYE_BATCHES: { verdict: 'NOT_AS_ORDERED', words: { it: '{count} bagni ({batches}): l’ordine chiede un solo bagno.', en: '{count} dye batches ({batches}): the order asks one dye batch.' } },
  EARLIER_DYE_BATCH: { verdict: 'NOT_AS_ORDERED', words: { it: 'Bagno {batch}: le consegne precedenti di questa riga erano del bagno {earlier} e l’ordine ne chiede uno solo.', en: 'Dye batch {batch}: earlier deliveries of this line came in {earlier} and the order asks one dye batch.' } },
  OVER_ORDER: { verdict: 'NOT_AS_ORDERED', words: { it: '{shipping} {uom} con {before} {uom} già ricevuti o in viaggio: più dei {expected} {uom} ordinati (fino a {upTo} con la tolleranza del {pct}%).', en: '{shipping} {uom} with {before} {uom} already received or on its way: more than the {expected} {uom} ordered (up to {upTo} with its {pct}% tolerance).' } },
  LIST_VS_LINE: { verdict: 'CHECK', words: { it: 'Le pelli sommano {total} {uom}; la riga dice {quantity} {uom}.', en: 'The hides add up to {total} {uom}; the line says {quantity} {uom}.' } },
  HIDE_COUNT: { verdict: 'CHECK', words: { it: '{count} pelli per {area} {uom}: ne erano previste circa {estimate}.', en: '{count} hides for {area} {uom}: about {estimate} were expected.' } },
  NO_PACKING_LIST: { verdict: 'CHECK', words: { it: 'Nessuna distinta per pelle: misuriamo ogni pelle all’arrivo.', en: 'No packing list per hide: we measure every hide when it arrives.' } },
  CR_VI: { verdict: 'CHECK', words: { it: 'Questa pelle richiede la prova del cromo VI: nessun rapporto di prova valido in archivio.', en: 'This leather needs Cr VI evidence: no valid test report is on file.' } },
})

const fill = (template: string, params: ReasonParams): string => template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
export function reasonOf(code: ReasonCode, params: ReasonParams = {}): Reason {
  const template = TEMPLATES[code]
  return { code, verdict: template.verdict, params, words: { it: fill(template.words.it, params), en: fill(template.words.en, params) } }
}

/** A line of the order as the checks read it (quantities in the order line's own unit, `uom`). */
export interface OrderLineFacts {
  readonly id: string
  readonly seq: number
  readonly uom: Uom
  /** The material is leather (tracked by hide): its hides make the packing list. */
  readonly leather: boolean
  /** What the supplier is to deliver: the confirmed quantity, else the ordered one. */
  readonly expected: string
  /** Taken by our posted receipts so far. */
  readonly received: string
  /** On the supplier's OTHER sent notices, not received yet. */
  readonly inTransit: string
  readonly tolerancePct: string | null
  readonly grade: string | null
  readonly thicknessMinMm: string | null
  readonly thicknessMaxMm: string | null
  readonly oneDyeBatch: boolean
  readonly estimatedHides: number | null
  readonly requiresCrViTest: boolean
  /** The dye batches earlier deliveries of the line came in (one dye batch is across deliveries). */
  readonly earlierDyeBatches: readonly string[]
}

export interface NoticeLineFacts {
  readonly id: string
  readonly seq: number
  readonly purchaseOrderLineId: string
  readonly quantity: string
  readonly uom: Uom
  readonly dyeBatch: string | null
}

export interface NoticeHideFacts {
  readonly lineId: string
  readonly seq: number
  readonly hideNumber: string
  readonly area: string
  readonly areaUom: Uom
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly dyeBatch: string | null
}

export interface CheckInput {
  readonly orderLines: readonly OrderLineFacts[]
  readonly lines: readonly NoticeLineFacts[]
  readonly hides: readonly NoticeHideFacts[]
  /** A current Cr VI test report of the notice or of the supplier is on file (design "Cr VI evidence on file"). */
  readonly crViEvidence: boolean
}

export interface HideVerdict {
  readonly lineId: string
  readonly seq: number
  readonly hideNumber: string
  readonly verdict: Verdict
  readonly reasons: readonly Reason[]
}

export interface LineVerdict {
  readonly lineId: string
  readonly seq: number
  readonly verdict: Verdict
  readonly reasons: readonly Reason[]
  /** The hides of the line and their area in the line's unit (null: no packing list). */
  readonly hides: number
  readonly area: string | null
  /** The order line's figures in its unit: expected, received, on other notices, what stays open after this one. */
  readonly expected: string
  readonly before: string
  readonly upTo: string
  readonly openAfter: string
}

export interface PackingCheck {
  readonly verdict: Verdict
  readonly lines: readonly LineVerdict[]
  readonly hides: readonly HideVerdict[]
  readonly counts: { readonly ok: number; readonly check: number; readonly notAsOrdered: number }
}

const text = (value: Decimal): string => value.toDecimalPlaces(QUANTITY_SCALE).toString()
const shown = (value: Decimal): string => value.toDecimalPlaces(2).toString()
const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()
const batchOf = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null)

/** An area in another area unit (m², dm², ft²), exactly; null when the units do not convert. */
export function areaIn(area: string, from: Uom, to: Uom): Decimal | null {
  const ratio = fixedRatio(from, to)
  return ratio === null ? null : new Dec(area).times(ratio)
}

/** The batch most hides of a line share (the line's own when it names one): the "one dye batch" the others are read against. */
function mainBatchOf(line: NoticeLineFacts, hides: readonly NoticeHideFacts[]): string | null {
  const own = batchOf(line.dyeBatch)
  if (own) return own
  const counts = new Map<string, number>()
  for (const hide of hides) {
    const batch = batchOf(hide.dyeBatch)
    if (batch) counts.set(batch, (counts.get(batch) ?? 0) + 1)
  }
  let main: string | null = null
  for (const [batch, count] of counts) if (main === null || count > counts.get(main)!) main = batch
  return main
}

function hideReasons(order: OrderLineFacts, hide: NoticeHideFacts, main: string | null): Reason[] {
  const reasons: Reason[] = []
  if (order.grade) {
    if (!batchOf(hide.grade)) reasons.push(reasonOf('NO_GRADE', { asked: order.grade }))
    else if (!sameText(hide.grade!, order.grade)) reasons.push(reasonOf('GRADE', { grade: hide.grade!.trim(), asked: order.grade }))
  }
  if (order.thicknessMinMm !== null || order.thicknessMaxMm !== null) {
    const range = { min: order.thicknessMinMm ?? '…', max: order.thicknessMaxMm ?? '…' }
    if (hide.thicknessMm === null) reasons.push(reasonOf('NO_THICKNESS', range))
    else {
      const value = new Dec(hide.thicknessMm)
      if ((order.thicknessMinMm !== null && value.lessThan(order.thicknessMinMm)) || (order.thicknessMaxMm !== null && value.greaterThan(order.thicknessMaxMm))) {
        reasons.push(reasonOf('THICKNESS', { value: value.toString(), ...range }))
      }
    }
  }
  if (order.oneDyeBatch) {
    const batch = batchOf(hide.dyeBatch)
    if (!batch) reasons.push(reasonOf('NO_DYE_BATCH'))
    else if (main !== null && !sameText(batch, main)) reasons.push(reasonOf('DYE_BATCH', { batch, main }))
  }
  return reasons
}

/**
 * The packing list and the lines against the order (design packing-list "Checks per line: total area vs ordered ± tolerance ·
 * one dye batch · grade · thickness range · hide count vs expected; Verdict per row and per line"). A line of a material not
 * kept by hide is checked for its quantity only.
 */
export function checkShipNotice(input: CheckInput): PackingCheck {
  const orders = new Map(input.orderLines.map((line) => [line.id, line]))
  const lines: LineVerdict[] = []
  const hides: HideVerdict[] = []
  for (const line of [...input.lines].sort((a, b) => a.seq - b.seq)) {
    const order = orders.get(line.purchaseOrderLineId)
    if (!order) continue
    const own = input.hides.filter((hide) => hide.lineId === line.id).sort((a, b) => a.seq - b.seq)
    const main = order.leather && order.oneDyeBatch ? mainBatchOf(line, own) : null
    const rowVerdicts = own.map((hide): HideVerdict => {
      const reasons = order.leather ? hideReasons(order, hide, main) : []
      return { lineId: line.id, seq: hide.seq, hideNumber: hide.hideNumber, verdict: worstOf(reasons.map((reason) => reason.verdict)), reasons }
    })
    hides.push(...rowVerdicts)

    const reasons: Reason[] = []
    const unit = order.uom
    // The area of the list in the line's unit (null when a hide's unit cannot be read in it).
    let area: Decimal | null = own.length === 0 ? null : ZERO
    for (const hide of own) {
      const converted = areaIn(hide.area, hide.areaUom, unit)
      area = area === null || converted === null ? null : area.plus(converted)
    }
    const quantity = new Dec(line.quantity)
    const shipping = area ?? quantity
    const tolerance = parseDecimal(order.tolerancePct) ?? ZERO
    const expected = new Dec(order.expected)
    const before = new Dec(order.received).plus(order.inTransit)
    const upTo = expected.times(HUNDRED.plus(tolerance)).dividedBy(HUNDRED)
    if (before.plus(shipping).greaterThan(upTo)) {
      reasons.push(reasonOf('OVER_ORDER', { shipping: shown(shipping), before: shown(before), expected: shown(expected), upTo: shown(upTo), pct: tolerance.toString(), uom: unit }))
    }
    if (order.leather) {
      if (own.length === 0) reasons.push(reasonOf('NO_PACKING_LIST'))
      else {
        if (area !== null) {
          const slack = Dec.max(quantity.times(tolerance.isZero() ? new Dec('0.5') : tolerance).dividedBy(HUNDRED), new Dec('0.01'))
          if (area.minus(quantity).abs().greaterThan(slack)) reasons.push(reasonOf('LIST_VS_LINE', { total: shown(area), quantity: shown(quantity), uom: unit }))
        }
        if (order.estimatedHides !== null && order.estimatedHides > 0 && expected.greaterThan(0)) {
          // A whole count of hides (an integer read from its fixed text, never a float of the area).
          const estimate = Math.max(1, Number.parseInt(new Dec(order.estimatedHides).times(shipping).dividedBy(expected).toFixed(0), 10))
          const off = Math.abs(own.length - estimate)
          if (off > Math.max(1, Math.round(estimate * 0.2))) reasons.push(reasonOf('HIDE_COUNT', { count: own.length, area: shown(shipping), uom: unit, estimate }))
        }
        if (order.oneDyeBatch) {
          const batches = [...new Set(own.map((hide) => batchOf(hide.dyeBatch)).filter((batch): batch is string => batch !== null).map((batch) => batch.toUpperCase()))]
          if (batches.length > 1) reasons.push(reasonOf('DYE_BATCHES', { count: batches.length, batches: batches.join(', ') }))
        }
      }
      if (order.oneDyeBatch && order.earlierDyeBatches.length > 0) {
        const shipped = main ?? batchOf(line.dyeBatch)
        if (shipped && !order.earlierDyeBatches.some((earlier) => sameText(earlier, shipped))) reasons.push(reasonOf('EARLIER_DYE_BATCH', { batch: shipped, earlier: order.earlierDyeBatches.join(', ') }))
      }
      if (order.requiresCrViTest && !input.crViEvidence) reasons.push(reasonOf('CR_VI'))
    }
    const openAfter = Dec.max(ZERO, expected.minus(before).minus(shipping))
    lines.push({
      lineId: line.id,
      seq: line.seq,
      verdict: worstOf([...reasons.map((reason) => reason.verdict), ...rowVerdicts.map((row) => row.verdict)]),
      reasons,
      hides: own.length,
      area: area === null ? null : text(area),
      expected: text(expected),
      before: text(before),
      upTo: text(upTo),
      openAfter: text(openAfter),
    })
  }
  const all = [...lines.map((line) => line.verdict), ...hides.map((hide) => hide.verdict)]
  return {
    verdict: worstOf(all),
    lines,
    hides,
    counts: { ok: hides.filter((hide) => hide.verdict === 'OK').length, check: hides.filter((hide) => hide.verdict === 'CHECK').length, notAsOrdered: hides.filter((hide) => hide.verdict === 'NOT_AS_ORDERED').length },
  }
}

// ---- what a supplier writes -------------------------------------------------------------------------------------------------

/** The supplier's terms of a delivery (design step 3 "Transport and papers"). */
export interface NoticeTerms {
  readonly supplierRef?: string | null | undefined
  readonly ddtNumber?: string | null | undefined
  readonly ddtDate?: string | null | undefined
  readonly shipDate?: string | null | undefined
  readonly expectedDate?: string | null | undefined
  readonly carrier?: string | null | undefined
  readonly trackingNumber?: string | null | undefined
  readonly parcels?: number | null | undefined
  readonly note?: string | null | undefined
}

export const TERM_FIELDS = ['supplierRef', 'ddtNumber', 'ddtDate', 'shipDate', 'expectedDate', 'carrier', 'trackingNumber', 'parcels', 'note'] as const
export type TermField = (typeof TERM_FIELDS)[number]

export const blankText = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const CONTROL = /[\u0000-\u001f\u007f]/

/** The terms as they stand after a change (given fields replace, the rest stay), and what is wrong with them. */
export function termsProblems(terms: Required<{ [K in TermField]: NoticeTerms[K] }>, base = 'body'): Issue[] {
  const issues: Issue[] = []
  const shortText = (field: TermField, max: number) => {
    const value = terms[field] as string | null | undefined
    if (value !== null && value !== undefined && value.trim().length > max) issues.push({ path: `${base}/${field}`, message: `At most ${max} characters.` })
    if (field !== 'note' && typeof value === 'string' && CONTROL.test(value)) issues.push({ path: `${base}/${field}`, message: 'One line of text.' })
  }
  shortText('supplierRef', SHIP_NOTICE_LIMITS.code)
  shortText('ddtNumber', SHIP_NOTICE_LIMITS.code)
  shortText('carrier', SHIP_NOTICE_LIMITS.text)
  shortText('trackingNumber', SHIP_NOTICE_LIMITS.text)
  shortText('note', SHIP_NOTICE_LIMITS.note)
  for (const field of ['ddtDate', 'shipDate', 'expectedDate'] as const) {
    const value = terms[field]
    if (value !== null && value !== undefined && !isBusinessDate(value)) issues.push({ path: `${base}/${field}`, message: 'A calendar day, YYYY-MM-DD.' })
  }
  if (terms.ddtDate && !blankText(terms.ddtNumber)) issues.push({ path: `${base}/ddtDate`, message: 'A DDT date goes with its number.' })
  if (terms.shipDate && terms.expectedDate && isBusinessDate(terms.shipDate) && isBusinessDate(terms.expectedDate) && terms.expectedDate < terms.shipDate) {
    issues.push({ path: `${base}/expectedDate`, message: 'The goods arrive on or after the day they leave.' })
  }
  if (terms.parcels !== null && terms.parcels !== undefined && (!Number.isInteger(terms.parcels) || terms.parcels < 1 || terms.parcels > SHIP_NOTICE_LIMITS.parcels)) {
    issues.push({ path: `${base}/parcels`, message: `A whole number from 1 to ${SHIP_NOTICE_LIMITS.parcels}.` })
  }
  return issues
}

/** A line the supplier ships (design step 1 "Quantity shipped per line (partial allowed; an unshipped line stays open); Batch / dye-lot per line"). */
export interface LineInput {
  readonly purchaseOrderLineId: string
  readonly quantity: string
  readonly supplierLot?: string | null | undefined
  readonly dyeBatch?: string | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with the lines against the order's open lines (by id): each once, a quantity above 0 with at most 4 decimals. */
export function lineProblems(lines: readonly LineInput[], openLineIds: ReadonlySet<string>, base = 'body/lines'): Issue[] {
  const issues: Issue[] = []
  if (lines.length > SHIP_NOTICE_LIMITS.lines) issues.push({ path: base, message: `At most ${SHIP_NOTICE_LIMITS.lines} lines.` })
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const at = `${base}/${index}`
    if (!openLineIds.has(line.purchaseOrderLineId)) issues.push({ path: `${at}/purchaseOrderLineId`, message: 'Not an open line of this order.' })
    else if (seen.has(line.purchaseOrderLineId)) issues.push({ path: `${at}/purchaseOrderLineId`, message: 'Each order line once: give one quantity per line.' })
    seen.add(line.purchaseOrderLineId)
    const quantity = parseDecimal(line.quantity)
    if (quantity === null || quantity.lessThanOrEqualTo(0)) issues.push({ path: `${at}/quantity`, message: 'A quantity above 0.' })
    else if (quantity.decimalPlaces() > QUANTITY_SCALE) issues.push({ path: `${at}/quantity`, message: `At most ${QUANTITY_SCALE} decimals.` })
    for (const field of ['supplierLot', 'dyeBatch'] as const) {
      const value = line[field]
      if (typeof value === 'string' && (value.trim().length > SHIP_NOTICE_LIMITS.code || CONTROL.test(value))) issues.push({ path: `${at}/${field}`, message: `One line of at most ${SHIP_NOTICE_LIMITS.code} characters.` })
    }
    if (typeof line.note === 'string' && line.note.trim().length > SHIP_NOTICE_LIMITS.note) issues.push({ path: `${at}/note`, message: `At most ${SHIP_NOTICE_LIMITS.note} characters.` })
  })
  return issues
}

/** A row of the packing list as typed or read from the tannery's sheet. */
export interface HideInput {
  /** The notice line it belongs to: its order line's number (10, 20 …); none: the notice's one leather line. */
  readonly line?: number | null | undefined
  readonly hideNumber: string
  readonly area: string
  readonly unit?: Uom | null | undefined
  readonly grade?: string | null | undefined
  readonly thicknessMm?: string | null | undefined
  readonly dyeBatch?: string | null | undefined
  readonly note?: string | null | undefined
}

/** A leather line of the notice, as the rows find it. */
export interface PackingLine {
  readonly id: string
  /** The order line's number. */
  readonly orderSeq: number
  readonly uom: Uom
}

export interface PlacedHide {
  readonly index: number
  readonly lineId: string
  readonly hideNumber: string
  readonly area: string
  readonly areaUom: Uom
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly dyeBatch: string | null
  readonly note: string | null
}

/** The rows on the notice's leather lines, and what is wrong with them (each problem at its row and field). */
export function placeHides(rows: readonly HideInput[], leatherLines: readonly PackingLine[], base = 'body/rows'): { readonly hides: PlacedHide[]; readonly issues: Issue[] } {
  const issues: Issue[] = []
  const hides: PlacedHide[] = []
  if (rows.length > SHIP_NOTICE_LIMITS.hides) issues.push({ path: base, message: `At most ${SHIP_NOTICE_LIMITS.hides} hides on one notice: split the delivery.` })
  const seen = new Map<string, number>()
  rows.forEach((row, index) => {
    const at = `${base}/${index}`
    const before = issues.length
    let line: PackingLine | undefined
    if (row.line === null || row.line === undefined) {
      if (leatherLines.length === 1) line = leatherLines[0]
      else issues.push({ path: `${at}/line`, message: leatherLines.length === 0 ? 'This notice has no leather line: a packing list lists hides.' : 'Name the order line (10, 20 …): the notice has more than one leather line.' })
    } else {
      line = leatherLines.find((candidate) => candidate.orderSeq === row.line)
      if (!line) issues.push({ path: `${at}/line`, message: `Order line ${row.line} is not a leather line of this notice.` })
    }
    const number = row.hideNumber.trim()
    if (number.length === 0 || number.length > SHIP_NOTICE_LIMITS.code || CONTROL.test(row.hideNumber)) issues.push({ path: `${at}/hideNumber`, message: `The tannery's number: 1 to ${SHIP_NOTICE_LIMITS.code} characters on one line.` })
    else {
      const key = number.toUpperCase()
      if (seen.has(key)) issues.push({ path: `${at}/hideNumber`, message: `Hide ${number} is listed twice (row ${seen.get(key)! + 1} too).` })
      seen.set(key, index)
    }
    const area = parseDecimal(row.area)
    if (area === null || area.lessThanOrEqualTo(0)) issues.push({ path: `${at}/area`, message: 'An area above 0.' })
    else if (area.decimalPlaces() > QUANTITY_SCALE) issues.push({ path: `${at}/area`, message: `At most ${QUANTITY_SCALE} decimals.` })
    const unit: Uom | null = row.unit ?? (line && HIDE_AREA_UNITS.includes(line.uom) ? line.uom : null)
    if ((unit === null && line) || (unit !== null && !HIDE_AREA_UNITS.includes(unit))) issues.push({ path: `${at}/unit`, message: 'A hide is measured in m², dm² or ft².' })
    let thickness: string | null = null
    if (row.thicknessMm !== null && row.thicknessMm !== undefined && String(row.thicknessMm).trim() !== '') {
      const value = parseDecimal(row.thicknessMm)
      if (value === null || value.lessThanOrEqualTo(0) || value.greaterThan(MAX_THICKNESS_MM) || value.decimalPlaces() > 2) issues.push({ path: `${at}/thicknessMm`, message: `Above 0 and at most ${MAX_THICKNESS_MM} mm, two decimals.` })
      else thickness = value.toString()
    }
    for (const field of ['grade', 'dyeBatch'] as const) {
      const value = row[field]
      if (typeof value === 'string' && (value.trim().length > SHIP_NOTICE_LIMITS.code || CONTROL.test(value))) issues.push({ path: `${at}/${field}`, message: `One line of at most ${SHIP_NOTICE_LIMITS.code} characters.` })
    }
    if (typeof row.note === 'string' && row.note.trim().length > SHIP_NOTICE_LIMITS.reason) issues.push({ path: `${at}/note`, message: `At most ${SHIP_NOTICE_LIMITS.reason} characters.` })
    if (issues.length === before && line && area && unit) {
      hides.push({ index, lineId: line.id, hideNumber: number, area: area.toString(), areaUom: unit, grade: blankText(row.grade), thicknessMm: thickness, dyeBatch: blankText(row.dyeBatch), note: blankText(row.note) })
    }
  })
  return { hides, issues }
}

/** Why the notice cannot be sent yet, in words (the database refuses the same: a line and a ship date). */
export function sendProblems(notice: { readonly lines: number; readonly shipDate: string | null; readonly expectedDate: string | null }): Issue[] {
  const issues: Issue[] = []
  if (notice.lines === 0) issues.push({ path: 'body/lines', message: 'Add at least one line to ship.' })
  if (!notice.shipDate) issues.push({ path: 'body/shipDate', message: 'Give the day the goods leave.' })
  if (!notice.expectedDate) issues.push({ path: 'body/expectedDate', message: 'Give the day the goods arrive: our dock plans by it.' })
  return issues
}

/** A NOT AS ORDERED notice goes with a note to our dock (design "differences can still be sent with a note (we decide at receipt)"). */
export function differencesNeedNote(check: Pick<PackingCheck, 'verdict'>, note: string | null | undefined): Issue | null {
  return check.verdict === 'NOT_AS_ORDERED' && !blankText(note) ? { path: 'body/note', message: 'Some of it is not as ordered: say why in a note for our dock, or fix the list.' } : null
}

/** How much of each notice line our receipt took (its order line's received quantity, in the line's unit, shared out by line order). */
export function receivedPerLine(lines: readonly { readonly id: string; readonly seq: number; readonly purchaseOrderLineId: string; readonly quantity: string }[], receivedByOrderLine: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  const byOrderLine = new Map<string, { readonly id: string; readonly seq: number; readonly quantity: string }[]>()
  for (const line of lines) byOrderLine.set(line.purchaseOrderLineId, [...(byOrderLine.get(line.purchaseOrderLineId) ?? []), line])
  for (const [orderLineId, own] of byOrderLine) {
    let left = new Dec(receivedByOrderLine.get(orderLineId) ?? '0')
    const sorted = [...own].sort((a, b) => a.seq - b.seq)
    sorted.forEach((line, index) => {
      const take = index === sorted.length - 1 ? left : Dec.min(left, new Dec(line.quantity))
      out.set(line.id, text(Dec.max(ZERO, take)))
      left = left.minus(take)
    })
  }
  return out
}
