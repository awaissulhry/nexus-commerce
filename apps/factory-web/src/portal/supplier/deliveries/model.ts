import { Dec } from '@nexus/factory-domain/tax/decimal'
import { issuePath, type ApiIssue } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { plainQuantity, quantityShown, quantityTyped } from '../../../lib/po-answer/quantities'
import { NOTICE_STATES, type LineBody, type LineChoice, type LineVerdict, type Notice, type NoticePage, type NoticeRow, type NoticeState, type NoticesRead, type Reason, type SheetRead, type SheetRow, type TermsBody, type Verdict } from './api'

/**
 * SCR-227 — the supplier's Ship notices (design portal.supplier.asn; B-W2b-186 on B-W2b-182's API), pure: the list's chips,
 * addresses and CSV, the four steps of announcing a delivery (what you ship, the leather packing list, transport and papers,
 * review and send), each step's draft and why it waits, the checks' reasons said from their codes and figures, a sheet row's
 * problems said from its columns, a refusal's issues said from their paths, the cancel. No price, cost or amount anywhere
 * (Owner answer C2). Words are keys of `portal-deliveries`; the views translate.
 */

export const NS = 'portal-deliveries'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
/** A sentence of this page: a key and its values. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The status pill's tone (design "Announced / In transit / Received / Received with differences"). */
export function stateTone(state: NoticeState): Tone {
  switch (state) {
    case 'RECEIVED':
      return 'success'
    case 'RECEIVED_WITH_DIFFERENCES':
      return 'warning'
    case 'ANNOUNCED':
    case 'IN_TRANSIT':
      return 'info'
    default:
      return 'neutral'
  }
}

/** OK / Check (amber) / Not as ordered (red). */
export function verdictTone(verdict: Verdict): Tone {
  return verdict === 'OK' ? 'success' : verdict === 'CHECK' ? 'warning' : 'danger'
}

/** A notice changes until it is received; a draft or a sent one may be cancelled (a draft is discarded). */
export const isOpenNotice = (status: string): boolean => status === 'DRAFT' || status === 'SENT'

// ── addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const STEPS = ['lines', 'packing', 'transport', 'review'] as const
export type Step = (typeof STEPS)[number]
export const stepOf = (value: string | null | undefined): Step | null => ((STEPS as readonly string[]).includes(value ?? '') ? (value as Step) : null)

export const listHref = (prefix: string): string => `${prefix}/deliveries`
/** The notice; a step opens the steps (a draft, or a sent notice being changed). */
export function noticeHref(prefix: string, id: string, step?: Step | null): string {
  return `${prefix}/deliveries/${encodeURIComponent(id)}${step ? `?step=${step}` : ''}`
}
/** A new notice, from one order (design sub-page announce: /deliveries/new?po=<id>). */
export const newHref = (prefix: string, po?: string | null): string => `${prefix}/deliveries/new${po ? `?po=${encodeURIComponent(po)}` : ''}`
/** The order's own page on its Ship notices tab. */
export const orderHref = (prefix: string, id: string): string => `${prefix}/orders/${encodeURIComponent(id)}?tab=asn`
/** Where a row of the list opens: a draft at its first step, any other notice its view. */
export const rowHref = (prefix: string, row: Pick<NoticeRow, 'id' | 'status'>): string => noticeHref(prefix, row.id, row.status === 'DRAFT' ? 'lines' : null)

/** The list's address: `?state=` (none: every notice) and `?q=`. */
export function listQuery(state: NoticeState | null, q: string): string {
  const search = new URLSearchParams()
  if (state) search.set('state', state)
  if (q.trim()) search.set('q', q.trim())
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The chips: every notice, then each state that has notices (the chosen one always). Counts are the API's. */
export function chipsOf(read: Pick<NoticesRead, 'counts'> | null, chosen: NoticeState | null): { state: NoticeState | null; count: number }[] {
  if (!read) return []
  const count = (state: NoticeState) => read.counts[state] ?? 0
  const all = NOTICE_STATES.reduce((sum, state) => sum + count(state), 0)
  return [{ state: null, count: all }, ...NOTICE_STATES.filter((state) => count(state) > 0 || state === chosen).map((state) => ({ state, count: count(state) }))]
}

const CSV_COLUMNS = ['notice', 'order', 'yourRef', 'shipDate', 'expected', 'carrier', 'tracking', 'ddt', 'lines', 'hides', 'status'] as const
const csvCell = (value: string): string => (/[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The rows as CSV (the header in the person's language; days ISO, as a sheet reads them). Never a price. */
export function noticesCsv(rows: readonly NoticeRow[], t: Translate): string {
  const head = CSV_COLUMNS.map((column) => csvCell(t(`csv.${column}`)))
  const body = rows.map((row) =>
    [row.number ?? t('row.draft'), row.purchaseOrder.number, row.supplierRef ?? '', row.shipDate ?? '', row.expectedDate ?? '', row.carrier ?? '', row.trackingNumber ?? '', row.ddtNumber ?? '', String(row.lines), String(row.hides), t(`state.${row.state}`)].map(csvCell),
  )
  return [head, ...body].map((cells) => cells.join(',')).join('\r\n')
}

// ── why a write waits ────────────────────────────────────────────────────────────────────────────────────────────────
export interface WriteFacts {
  /** The person may send us things (the API's `mayWrite`: the upload capability, never a preview). */
  readonly mayWrite: boolean
  readonly preview: boolean
  readonly offline: boolean
  readonly busy: boolean
}

/** Why any write waits (a key), or null. */
export function writeHeld(facts: WriteFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (!facts.mayWrite) return 'held.mayWrite'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  return null
}

// ── step 1: what you ship ────────────────────────────────────────────────────────────────────────────────────────────
/** A line of the order as step 1 offers it (on the notice or still open). */
export interface ShipLine {
  readonly id: string
  /** The order line's number (10, 20 …). */
  readonly seq: number
  readonly code: string | null
  readonly name: string | null
  readonly leather: boolean
  readonly supplierArticleCode: string | null
  readonly colour: string | null
  readonly uom: string
  /** What may still be shipped of it (this notice's own quantity counted in); null when not known. */
  readonly open: string | null
  readonly needDate: string | null
  readonly confirmedDate: string | null
  /** The order's asks (grade, thickness, one dye batch, tolerance, hides, Cr VI) when read. */
  readonly asks: LineChoice | null
}

const choiceLine = (choice: LineChoice): ShipLine => ({
  id: choice.purchaseOrderLineId,
  seq: choice.seq,
  code: choice.item.code,
  name: choice.item.name,
  leather: choice.item.leather,
  supplierArticleCode: choice.supplierArticleCode,
  colour: choice.colour,
  uom: choice.uom,
  open: choice.open,
  needDate: choice.needDate,
  confirmedDate: choice.confirmedDate,
  asks: choice,
})

/**
 * The lines of step 1: the notice's own (their open quantity from the check's figures: expected less what came or travels
 * on OTHER notices), the order's other open lines (`addable`), and — for a new notice — the order's open lines.
 */
export function shipLinesOf(input: { readonly choices: readonly LineChoice[]; readonly notice?: Notice | null; readonly addable?: readonly LineChoice[] }): ShipLine[] {
  const byId = new Map(input.choices.map((choice) => [choice.purchaseOrderLineId, choice]))
  const out = new Map<string, ShipLine>()
  for (const line of input.notice?.lines ?? []) {
    const choice = byId.get(line.purchaseOrderLineId) ?? null
    const open = line.figures ? Dec.max(new Dec(0), new Dec(line.figures.expected).minus(line.figures.before)).toString() : (choice?.open ?? null)
    out.set(line.purchaseOrderLineId, {
      id: line.purchaseOrderLineId,
      seq: line.orderSeq ?? choice?.seq ?? line.seq,
      code: line.item?.code ?? choice?.item.code ?? null,
      name: line.item?.name ?? choice?.item.name ?? null,
      leather: line.item?.leather ?? choice?.item.leather ?? false,
      supplierArticleCode: line.supplierArticleCode,
      colour: line.colour,
      uom: line.uom,
      open,
      needDate: choice?.needDate ?? null,
      confirmedDate: choice?.confirmedDate ?? null,
      asks: choice,
    })
  }
  for (const choice of input.addable ?? []) if (!out.has(choice.purchaseOrderLineId)) out.set(choice.purchaseOrderLineId, choiceLine(choice))
  if (!input.notice) for (const choice of input.choices) if (!out.has(choice.purchaseOrderLineId)) out.set(choice.purchaseOrderLineId, choiceLine(choice))
  return [...out.values()].sort((a, b) => a.seq - b.seq)
}

export interface LineDraft {
  readonly include: boolean
  /** As typed, in the page's language. */
  readonly quantity: string
  readonly dyeBatch: string
  readonly supplierLot: string
}
export type LinesDraft = Readonly<Record<string, LineDraft>>

/** A new notice ships every open line in full (design "preselected from a PO"); the supplier takes off what stays. */
export function linesDraftOf(lines: readonly ShipLine[], notice: Notice | null, locale: Locale): LinesDraft {
  const out: Record<string, LineDraft> = {}
  for (const line of lines) {
    const own = notice?.lines.find((entry) => entry.purchaseOrderLineId === line.id)
    if (own) out[line.id] = { include: true, quantity: quantityTyped(own.quantity, locale), dyeBatch: own.dyeBatch ?? '', supplierLot: own.supplierLot ?? '' }
    else out[line.id] = { include: !notice, quantity: line.open && new Dec(line.open).greaterThan(0) ? quantityTyped(line.open, locale) : '', dyeBatch: '', supplierLot: '' }
  }
  return out
}

export const MAX_CODE = 60
export const MAX_TEXT = 100
export const MAX_NOTE = 2000
export const MAX_PARCELS = 9999

/** What is wrong with each line shipped (a key), by line id. */
export function lineProblemsOf(draft: LinesDraft, locale: Locale): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const [id, line] of Object.entries(draft)) {
    if (!line.include) continue
    const plain = plainQuantity(line.quantity, locale)
    if (plain === null) problems[id] = line.quantity.trim() === '' ? 'lines.problem.empty' : 'lines.problem.number'
    else if (new Dec(plain).lessThanOrEqualTo(0)) problems[id] = 'lines.problem.zero'
    else if (new Dec(plain).decimalPlaces() > 4) problems[id] = 'lines.problem.decimals'
    else if (line.dyeBatch.trim().length > MAX_CODE || line.supplierLot.trim().length > MAX_CODE) problems[id] = 'lines.problem.code'
  }
  return problems
}

/** A line shipping more than is open: the check will say "Not as ordered" (a hint, never a hold). */
export function overOpen(line: ShipLine, draft: LineDraft | undefined, locale: Locale): boolean {
  if (!draft?.include || line.open === null) return false
  const plain = plainQuantity(draft.quantity, locale)
  return plain !== null && new Dec(plain).greaterThan(line.open)
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The lines as the API takes them, in the order's line order. */
export function linesBody(lines: readonly ShipLine[], draft: LinesDraft, locale: Locale): LineBody[] {
  return lines.flatMap((line) => {
    const entry = draft[line.id]
    if (!entry?.include) return []
    return [{ purchaseOrderLineId: line.id, quantity: plainQuantity(entry.quantity, locale) ?? entry.quantity, dyeBatch: blank(entry.dyeBatch), supplierLot: blank(entry.supplierLot) }]
  })
}

/** The lines differ from what the notice holds (step 1 saves only then). */
export function linesChanged(body: readonly LineBody[], notice: Notice | null): boolean {
  if (!notice) return true
  if (body.length !== notice.lines.length) return true
  return body.some((line) => {
    const own = notice.lines.find((entry) => entry.purchaseOrderLineId === line.purchaseOrderLineId)
    return !own || !new Dec(own.quantity).equals(new Dec(line.quantity)) || (own.dyeBatch ?? null) !== line.dyeBatch || (own.supplierLot ?? null) !== line.supplierLot
  })
}

/** Why "Next" of step 1 waits (a key), or null. */
export function linesHeld(draft: LinesDraft, locale: Locale, facts: WriteFacts): string | null {
  const held = writeHeld(facts)
  if (held) return held
  if (!Object.values(draft).some((line) => line.include)) return 'held.noLine'
  if (Object.keys(lineProblemsOf(draft, locale)).length > 0) return 'held.fixLines'
  return null
}

// ── step 3: transport and papers ─────────────────────────────────────────────────────────────────────────────────────
export const TERM_FIELDS = ['shipDate', 'expectedDate', 'parcels', 'carrier', 'trackingNumber', 'ddtNumber', 'ddtDate', 'supplierRef', 'note'] as const
export type TermField = (typeof TERM_FIELDS)[number]
export type TermsDraft = Readonly<Record<TermField, string>>

export function termsDraftOf(notice: Notice | null): TermsDraft {
  return {
    shipDate: notice?.shipDate ?? '',
    expectedDate: notice?.expectedDate ?? '',
    parcels: notice?.parcels === null || notice?.parcels === undefined ? '' : String(notice.parcels),
    carrier: notice?.carrier ?? '',
    trackingNumber: notice?.trackingNumber ?? '',
    ddtNumber: notice?.ddtNumber ?? '',
    ddtDate: notice?.ddtDate ?? '',
    supplierRef: notice?.supplierRef ?? '',
    note: notice?.note ?? '',
  }
}

/** What is wrong with the terms (a key per field). */
export function termsProblemsOf(draft: TermsDraft): Partial<Record<TermField, string>> {
  const problems: Partial<Record<TermField, string>> = {}
  for (const field of ['supplierRef', 'ddtNumber'] as const) if (draft[field].trim().length > MAX_CODE) problems[field] = 'terms.problem.long60'
  for (const field of ['carrier', 'trackingNumber'] as const) if (draft[field].trim().length > MAX_TEXT) problems[field] = 'terms.problem.long100'
  if (draft.note.trim().length > MAX_NOTE) problems.note = 'terms.problem.long2000'
  if (draft.ddtDate && !draft.ddtNumber.trim()) problems.ddtDate = 'terms.problem.ddtDate'
  if (draft.shipDate && draft.expectedDate && draft.expectedDate < draft.shipDate) problems.expectedDate = 'terms.problem.order'
  const parcels = draft.parcels.trim()
  if (parcels && (!/^\d+$/.test(parcels) || Number.parseInt(parcels, 10) < 1 || Number.parseInt(parcels, 10) > MAX_PARCELS)) problems.parcels = 'terms.problem.parcels'
  return problems
}

export function termsBody(draft: TermsDraft): TermsBody {
  const parcels = draft.parcels.trim()
  return {
    shipDate: blank(draft.shipDate),
    expectedDate: blank(draft.expectedDate),
    parcels: /^\d+$/.test(parcels) ? Number.parseInt(parcels, 10) : null,
    carrier: blank(draft.carrier),
    trackingNumber: blank(draft.trackingNumber),
    ddtNumber: blank(draft.ddtNumber),
    ddtDate: blank(draft.ddtDate),
    supplierRef: blank(draft.supplierRef),
    note: blank(draft.note),
  }
}

export function termsChanged(draft: TermsDraft, notice: Notice | null): boolean {
  const before = termsDraftOf(notice)
  return TERM_FIELDS.some((field) => draft[field].trim() !== before[field].trim())
}

export function termsHeld(draft: TermsDraft, facts: WriteFacts): string | null {
  const held = writeHeld(facts)
  if (held) return held
  return Object.keys(termsProblemsOf(draft)).length > 0 ? 'held.fixTerms' : null
}

// ── step 4: review and send ──────────────────────────────────────────────────────────────────────────────────────────
/**
 * What still holds the send, in this page's words: no line, no ship day, no arrival day (the API's own three), documents
 * our company requires for a delivery (counted from the API's list: its sentences are English), and a note for our dock
 * when something is not as ordered (design "differences can still be sent with a note").
 */
export function sendReasonsOf(page: Pick<NoticePage, 'notice' | 'sendHeld'>, note: string): Words[] {
  const notice = page.notice
  const own: Words[] = []
  if (notice.lines.length === 0) own.push({ key: 'send.noLines' })
  if (!notice.shipDate) own.push({ key: 'send.noShipDate' })
  if (!notice.expectedDate) own.push({ key: 'send.noExpected' })
  const documents = Math.max(0, page.sendHeld.length - own.length)
  if (documents > 0) own.push({ key: 'send.documents', params: { count: documents } })
  if (notice.verdict === 'NOT_AS_ORDERED' && !note.trim()) own.push({ key: 'send.needNote' })
  if (note.trim().length > MAX_NOTE) own.push({ key: 'terms.problem.long2000' })
  return own
}

export function sendHeld(page: Pick<NoticePage, 'notice' | 'sendHeld'>, note: string, facts: WriteFacts): string | null {
  const held = writeHeld(facts)
  if (held) return held
  if (page.notice.status !== 'DRAFT') return 'held.sent'
  return sendReasonsOf(page, note).length > 0 ? 'held.send' : null
}

// ── the checks in words ──────────────────────────────────────────────────────────────────────────────────────────────
/** The reasons this page words (B-W2b-182's REASON_CODES; a test holds them equal). */
export const KNOWN_REASONS = ['GRADE', 'NO_GRADE', 'THICKNESS', 'NO_THICKNESS', 'DYE_BATCH', 'NO_DYE_BATCH', 'DYE_BATCHES', 'EARLIER_DYE_BATCH', 'OVER_ORDER', 'LIST_VS_LINE', 'HIDE_COUNT', 'NO_PACKING_LIST', 'CR_VI'] as const

const NUMBER = /^\d+(?:\.\d+)?$/

/** A reason in the page's words: its code's sentence with its figures written in the page's language. */
export function reasonWords(reason: Pick<Reason, 'code' | 'params'>, t: Translate, locale: Locale): string {
  if (!(KNOWN_REASONS as readonly string[]).includes(reason.code)) return t('reason.unknown')
  const params: Record<string, string | number> = {}
  for (const [name, value] of Object.entries(reason.params)) {
    if (name === 'uom') params[name] = t(`uom.${String(value)}`)
    else if (typeof value === 'string' && NUMBER.test(value)) params[name] = quantityShown(value, locale)
    else params[name] = value
  }
  return t(`reason.${reason.code}`, params)
}

/** A row of the packing list as the table shows it: from the notice (kept) or from a sheet (read, not kept yet). */
export interface HideRow {
  readonly id: string
  /** The sheet's row number (a sheet only). */
  readonly row: number | null
  /** The order line it belongs to (10, 20 …). */
  readonly line: number | null
  readonly hideNumber: string
  readonly area: string | null
  readonly unit: string | null
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly dyeBatch: string | null
  readonly note: string | null
  /** null: the row could not be read (its problems say why). */
  readonly verdict: Verdict | null
  readonly reasons: readonly Pick<Reason, 'code' | 'verdict' | 'params'>[]
  readonly problems: readonly Words[]
}

export function hidesOfNotice(notice: Notice): HideRow[] {
  return notice.lines.flatMap((line) =>
    line.hides.map((hide) => ({
      id: hide.id,
      row: null,
      line: line.orderSeq,
      hideNumber: hide.hideNumber,
      area: hide.area,
      unit: hide.areaUom,
      grade: hide.grade,
      thicknessMm: hide.thicknessMm,
      dyeBatch: hide.dyeBatch,
      note: hide.note,
      verdict: hide.verdict,
      reasons: hide.reasons,
      problems: [],
    })),
  )
}

/** Why a sheet row could not be read or placed, from its columns (the API's English is dropped). */
export function rowProblemsOf(row: SheetRow, rows: readonly SheetRow[]): Words[] {
  const out: Words[] = []
  const seen = new Set<string>()
  const add = (words: Words) => {
    const key = `${words.key}:${JSON.stringify(words.params ?? {})}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(words)
    }
  }
  for (const error of row.errors) {
    switch (error.column) {
      case 'hideNumber': {
        const number = row.hideNumber?.trim().toUpperCase()
        const other = number ? rows.find((entry) => entry.rowNumber !== row.rowNumber && entry.hideNumber?.trim().toUpperCase() === number) : undefined
        add(other ? { key: 'sheetRow.twice', params: { hide: row.hideNumber!.trim(), other: other.rowNumber } } : { key: 'sheetRow.hideNumber' })
        break
      }
      case 'area':
        add({ key: 'sheetRow.area' })
        break
      case 'unit':
        add({ key: 'sheetRow.unit' })
        break
      case 'line':
        add(row.line === null ? { key: 'sheetRow.lineNeeded' } : { key: 'sheetRow.lineUnknown', params: { line: row.line } })
        break
      case 'thicknessMm':
        add({ key: 'sheetRow.thickness' })
        break
      case 'grade':
      case 'dyeBatch':
        add({ key: `sheetRow.${error.column}` })
        break
      case 'note':
        add({ key: 'sheetRow.note' })
        break
      default:
        add({ key: 'sheetRow.unreadable' })
    }
  }
  return out
}

export function hidesOfSheet(sheet: Pick<SheetRead, 'rows'>): HideRow[] {
  return sheet.rows.map((row) => ({
    id: `row-${row.rowNumber}`,
    row: row.rowNumber,
    line: row.line,
    hideNumber: row.hideNumber ?? '',
    area: row.area,
    unit: row.unit,
    grade: row.grade,
    thicknessMm: row.thicknessMm,
    dyeBatch: row.dyeBatch,
    note: null,
    verdict: row.errors.length > 0 ? null : row.verdict,
    reasons: row.reasons,
    problems: rowProblemsOf(row, sheet.rows),
  }))
}

/** The verdicts of the list: how many rows read OK, Check, Not as ordered, or not at all. */
export function hideCounts(rows: readonly HideRow[]): { ok: number; check: number; notAsOrdered: number; unreadable: number } {
  return {
    ok: rows.filter((row) => row.verdict === 'OK').length,
    check: rows.filter((row) => row.verdict === 'CHECK').length,
    notAsOrdered: rows.filter((row) => row.verdict === 'NOT_AS_ORDERED').length,
    unreadable: rows.filter((row) => row.verdict === null).length,
  }
}

/** A line's verdict as the tables show it (the notice's own, or a sheet's before it is kept). */
export interface LineCheck {
  readonly id: string
  readonly seq: number | null
  readonly title: string
  readonly uom: string
  readonly leather: boolean
  readonly quantity: string
  readonly verdict: Verdict
  readonly reasons: readonly Pick<Reason, 'code' | 'verdict' | 'params'>[]
  readonly hides: number
  readonly area: string | null
  readonly openAfter: string | null
  readonly receivedQuantity: string | null
  readonly differs: boolean
}

export const lineTitleOf = (line: { readonly supplierArticleCode: string | null; readonly item: { readonly code: string; readonly name: string } | null }): string =>
  [line.supplierArticleCode, line.item?.code, line.item?.name].filter((part): part is string => Boolean(part && part.trim())).filter((part, index, all) => all.indexOf(part) === index).join(' · ') || '—'

export function lineChecksOf(notice: Notice, sheetLines?: readonly LineVerdict[] | null): LineCheck[] {
  return notice.lines.map((line) => {
    const fresh = sheetLines?.find((entry) => entry.lineId === line.id)
    return {
      id: line.id,
      seq: line.orderSeq,
      title: lineTitleOf(line),
      uom: line.uom,
      leather: line.item?.leather ?? false,
      quantity: line.quantity,
      verdict: fresh?.verdict ?? line.verdict,
      reasons: fresh?.reasons ?? line.reasons,
      hides: fresh?.hides ?? line.figures?.hides ?? line.hides.length,
      area: fresh ? fresh.area : (line.figures?.area ?? null),
      openAfter: fresh?.openAfter ?? line.figures?.openAfter ?? null,
      receivedQuantity: line.receivedQuantity,
      differs: notice.differing.includes(line.id),
    }
  })
}

/** The notice has a leather line: its hides make the packing list (design step 2). */
export const hasLeather = (notice: Notice): boolean => notice.lines.some((line) => line.item?.leather)

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Problem = 'changed' | 'invalid' | 'forbidden' | 'missing' | 'rateLimited' | 'unavailable' | 'internal'

export function problemOf(kind: string | null | undefined): Problem {
  switch (kind) {
    case 'conflict':
      return 'changed'
    case 'invalid':
      return 'invalid'
    case 'forbidden':
      return 'forbidden'
    case 'not_found':
      return 'missing'
    case 'rate_limited':
      return 'rateLimited'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'internal'
  }
}

/** A refusal's issues in this page's words, from their paths (the API's sentences are English, for its logs). */
export function issueKeysOf(issues: readonly ApiIssue[]): string[] {
  const keys: string[] = []
  for (const issue of issues) {
    const path = issuePath(issue).replace(/\./g, '/')
    const key = /shipDate$/.test(path)
      ? 'issue.shipDate'
      : /expectedDate$/.test(path)
        ? 'issue.expectedDate'
        : /ddtDate$/.test(path)
          ? 'issue.ddtDate'
          : /parcels$/.test(path)
            ? 'issue.parcels'
            : /note$/.test(path)
              ? 'issue.note'
              : /reason$/.test(path)
                ? 'issue.reason'
                : /lines\/\d+\/purchaseOrderLineId$/.test(path)
                  ? 'issue.lineGone'
                  : /lines\/\d+$/.test(path)
                    ? 'issue.lineEnded'
                    : /lines(\/\d+\/quantity)?$/.test(path)
                      ? 'issue.lines'
                      : /headers/.test(path)
                        ? 'issue.headers'
                        : /(content|fileName|sheet)/.test(path)
                          ? 'issue.file'
                          : /rows/.test(path)
                            ? 'issue.rows'
                            : 'issue.other'
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

// ── cancel ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CancelTarget {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly orderNumber: string
}

/** Why "Cancel ship notice" waits (a key): a sent notice says why (our dock reads it). */
export function cancelHeld(target: CancelTarget, reason: string, facts: WriteFacts): string | null {
  const held = writeHeld(facts)
  if (held) return held
  if (!isOpenNotice(target.status)) return 'held.closed'
  if (target.status === 'SENT' && reason.trim() === '') return 'cancel.held.reason'
  if (reason.trim().length > MAX_NOTE) return 'terms.problem.long2000'
  return null
}

/** Numbers of the page in its language ("1.200,5"). */
export const shown = (value: string, locale: Locale): string => (NUMBER.test(value.trim()) ? quantityShown(value.trim(), locale) : value)
