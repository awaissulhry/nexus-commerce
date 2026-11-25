import { formatNumber } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import { addressLine } from '../address-line'
import { LIMITS, type CustomLine, type CustomLineFields, type CustomLineKind, type DraftFile, type DraftFilePart, type DraftLine, type DraftPerson, type DraftRecord, type DraftRequest, type HeaderBody, type MadeToMeasure, type MeasureBy, type NoticeCode, type OwnNumber, type PersonFields, type Problem, type ShipTo, type SizeAsk } from './schema'
// F-CP-150: the draft's checklist is the domain's (the office's Drafts view reads the same rule, B-CP-071).
import { DRAFT_LATER_PARTS, DRAFT_PARTS, draftReadiness, problemsByPartOf, type DraftFacts, type DraftLaterPart, type DraftPart, type DraftPartState } from '@nexus/factory-domain/sales/portal-ordering/office'
import { DRAFT_FILES_MAX } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { PEOPLE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/people'
import { CUSTOM_LINE_LIMITS, lineHasPieces } from '@nexus/factory-domain/sales/portal-ordering/rules'

/**
 * The ONE draft order, pure (THE SIMPLE ORDER START, od-w1.1 — moved out of the portal's New order, `portal/customer/neworder/model.ts`,
 * B-W2b-194 and the customer page's F-CP-150…154): the header's autosave (only what changed, checked by the API's limits), the
 * delivery addresses it offers, a line's size grid and what its save sends, every problem and notice in the page's words from codes
 * and figures, the files, the lines of every kind and their people. No door's words, no fetch: each host gives its commands
 * (`api-port.ts`) and its words (`words.ts`, the part's own catalogue `order-draft`). The containers read and write; the views draw.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** Where a reorder line came from, in words: "from your order 12 (your PO BA-PO-4410)", else by its day — never SO-…. */
export function fromOrderText(source: { readonly yourNumber: OwnNumber; readonly customerRef: string | null; readonly orderDate: string | null }, t: Translate, day: (date: string) => string): string {
  const ref = source.customerRef
  if (source.yourNumber) return ref ? t('lines.fromOwnRef', { seq: source.yourNumber.seq, ref }) : t('lines.fromOwn', { seq: source.yourNumber.seq })
  const when = source.orderDate ? day(source.orderDate) : '—'
  return ref ? t('lines.fromDayRef', { day: when, ref }) : t('lines.fromDay', { day: when })
}

export const pieces = (n: number, locale: Locale): string => formatNumber(n, locale, { maximumFractionDigits: 0 })

/** Today in the site's zone (YYYY-MM-DD). */
export const todayIn = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

// ── the header ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HeaderDraft {
  customerRef: string
  shipToAddressId: string
  requestedDate: string
  note: string
}
export type HeaderField = keyof HeaderDraft

export const headerDraftOf = (request: Pick<DraftRequest, 'customerRef' | 'shipToAddressId' | 'requestedDate' | 'note'> | null): HeaderDraft => ({
  customerRef: request?.customerRef ?? '',
  shipToAddressId: request?.shipToAddressId ?? '',
  requestedDate: request?.requestedDate ?? '',
  note: request?.note ?? '',
})

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The fields typed differently from what the draft holds (what the autosave sends; blank = null). */
export function headerChanges(saved: HeaderDraft, draft: HeaderDraft, only?: HeaderField): HeaderBody {
  const out: HeaderBody = {}
  const fields: HeaderField[] = only ? [only] : ['customerRef', 'shipToAddressId', 'requestedDate', 'note']
  for (const field of fields) {
    if ((blank(saved[field]) ?? '') === (blank(draft[field]) ?? '')) continue
    out[field] = blank(draft[field])
  }
  return out
}

export const headerDirty = (saved: HeaderDraft, draft: HeaderDraft): boolean => Object.keys(headerChanges(saved, draft)).length > 0

/** A field's problem (a key) by the API's limits, or null. */
export function headerProblem(field: HeaderField, draft: HeaderDraft, today: string): string | null {
  if (field === 'customerRef' && draft.customerRef.trim().length > LIMITS.customerRef) return 'head.problem.refLong'
  if (field === 'note' && draft.note.trim().length > LIMITS.note) return 'head.problem.noteLong'
  if (field === 'requestedDate' && draft.requestedDate !== '' && draft.requestedDate < today) return 'head.problem.datePast'
  return null
}

// ── delivery addresses ──────────────────────────────────────────────────────────────────────────────────────────────────
export type ShipToState = 'OK' | 'WAITING' | 'ARCHIVED'
export interface ShipToOption {
  id: string
  name: string | null
  line: string
  isDefault: boolean
  state: ShipToState
}

/**
 * The delivery addresses the order offers: every active one of ours or one we checked (the default first). A waiting one
 * (a customer's, not checked yet) only when it is the draft's own — the one just added here (design "waits for our
 * approval — you can still send"; F13b: accepting the request approves it). The draft's own archived one stays shown so
 * its problem reads.
 */
export function shipToOptions(addresses: readonly ShipTo[], chosen: string | null): ShipToOption[] {
  const out: ShipToOption[] = []
  for (const row of addresses) {
    const refused = row.approval?.status === 'REFUSED'
    const waiting = row.approval?.status === 'WAITING'
    const state: ShipToState = row.status !== 'ACTIVE' || refused ? 'ARCHIVED' : waiting ? 'WAITING' : 'OK'
    if (state !== 'OK' && row.id !== chosen) continue
    out.push({ id: row.id, name: row.name, line: addressLine(row), isDefault: row.isDefault && state === 'OK', state })
  }
  return out.sort((a, b) => (a.isDefault !== b.isDefault ? (a.isDefault ? -1 : 1) : 0))
}

// ── a line's size grid ──────────────────────────────────────────────────────────────────────────────────────────────────
export type Cells = Readonly<Record<string, number>>

/** The quantities a line holds, by size. */
export const cellsOf = (line: Pick<DraftLine, 'sizes'>): Record<string, number> => Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))

/** The grid's columns: the sizes offered today, then any size the line asks that is no longer offered. */
export const columnsOf = (line: Pick<DraftLine, 'sizes' | 'offered'>): string[] => [...line.offered, ...line.sizes.map((row) => row.size).filter((size) => !line.offered.includes(size))]

/** What a line's save sends: every size with pieces, in the grid's order. */
export function sizesBody(columns: readonly string[], cells: Cells): SizeAsk[] {
  const order = [...columns, ...Object.keys(cells).filter((size) => !columns.includes(size))]
  return order.flatMap((size) => {
    const quantity = Math.trunc(cells[size] ?? 0)
    return quantity > 0 ? [{ size, quantity: Math.min(quantity, LIMITS.quantity) }] : []
  })
}

export const piecesOfCells = (cells: Cells): number => Object.values(cells).reduce((sum, value) => sum + (value > 0 ? Math.trunc(value) : 0), 0)

/** The typed grid differs from what the line holds. */
export function lineChanged(line: Pick<DraftLine, 'sizes' | 'offered'>, cells: Cells): boolean {
  const saved = sizesBody(columnsOf(line), cellsOf(line))
  const typed = sizesBody(columnsOf(line), cells)
  return saved.length !== typed.length || saved.some((row, index) => row.size !== typed[index]!.size || row.quantity !== typed[index]!.quantity)
}

/** Why a typed line cannot be saved (a key), or null. */
export const lineHeld = (cells: Cells): string | null => (piecesOfCells(cells) === 0 ? 'lines.held.empty' : null)

// ── words from codes ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WordsKit {
  t: Translate
  price: (value: string | null | undefined) => string | null
  /** F-CP-154: the page's language (a garment type's words); absent: its code. */
  locale?: Locale
}

/** A problem that holds the send, in the page's words (F-CP-154: a described or made-to-measure line's too — `custom`). */
export function problemWords(problem: Problem, lines: readonly DraftLine[], kit: WordsKit, custom: readonly CustomLine[] = []): string {
  const { t } = kit
  const line = problem.lineId ? lines.find((entry) => entry.id === problem.lineId) : undefined
  const own = problem.lineId ? custom.find((entry) => entry.id === problem.lineId) : undefined // F-CP-154
  const style = line?.style.code ?? own?.style?.code ?? t('problem.thisStyle')
  switch (problem.code) {
    case 'NO_LINES':
      return t('problem.NO_LINES')
    case 'TOO_MANY_LINES':
      return t('problem.TOO_MANY_LINES', { max: LIMITS.lines })
    case 'DATE_PAST':
      return t('problem.DATE_PAST')
    case 'SHIP_TO_ARCHIVED':
      return t('problem.SHIP_TO_ARCHIVED')
    case 'STYLE_NOT_SOLD':
      return t('problem.STYLE_NOT_SOLD', { style })
    case 'COLOUR_DISCONTINUED':
      return t('problem.COLOUR_DISCONTINUED', { colour: line?.colourway.name ?? own?.colourway?.name ?? '' })
    case 'SIZE_NOT_OFFERED':
      return t('problem.SIZE_NOT_OFFERED', { size: problem.size ?? '', style })
    case 'NO_SIZES':
      return t('problem.NO_SIZES')
    case 'PRICE_CHANGED': {
      const now = kit.price(line?.priceNow)
      const was = kit.price(line?.unitPriceShown)
      return now && was ? t('problem.PRICE_CHANGED', { now, was }) : now ? t('problem.PRICE_NEW', { now }) : t('problem.PRICE_ANY')
    }
    // F-CP-154 (B-CP-075): a described or made-to-measure line's own problems, from codes and figures.
    case 'NO_TOTAL':
      return t('draftPage.problem.NO_TOTAL')
    case 'SIZES_NOT_TOTAL': {
      const sum = own ? own.sizes.reduce((total, row) => total + row.quantity, 0) : null
      return own && own.quantity !== null && sum !== null ? t('draftPage.problem.SIZES_NOT_TOTAL', { sum, total: own.quantity }) : t('draftPage.problem.SIZES_NOT_TOTAL_ANY')
    }
    case 'NO_PEOPLE':
      return t('draftPage.problem.NO_PEOPLE')
    case 'MTM_CLOSED':
      return t('draftPage.mtmOff')
    case 'GARMENT_TYPE_GONE': {
      const type = own?.garmentType ? (kit.locale ? own.garmentType.words[kit.locale] : own.garmentType.code) : null
      return type ? t('draftPage.problem.GARMENT_TYPE_GONE', { type }) : t('draftPage.problem.GARMENT_TYPE_GONE_ANY')
    }
  }
}

/**
 * Where "Show me" goes for a problem: the line's card, or the order details. F-CP-154: a person's problem goes to their row of the
 * roster, a line with no one named to its roster.
 */
export const problemPlace = (problem: Problem): string =>
  problem.personId ? `person-${problem.personId}` : problem.code === 'NO_PEOPLE' && problem.lineId ? `people-${problem.lineId}` : problem.lineId ? `line-${problem.lineId}` : problem.code === 'NO_LINES' || problem.code === 'TOO_MANY_LINES' ? 'lines' : 'order-head'

export interface NoticeFacts {
  style?: string | null
  colour?: string | null
  priceNow?: string | null
  priceThen?: string | null
  /** Sizes left out (a past order's line: ordered then, not offered now). */
  dropped?: readonly string[] | null
}

/** A reorder's difference in the page's words. */
export function noticeWords(code: NoticeCode, facts: NoticeFacts, kit: WordsKit): string {
  const { t } = kit
  switch (code) {
    case 'PRICE_CHANGED': {
      const now = kit.price(facts.priceNow)
      const was = kit.price(facts.priceThen)
      return now && was ? t('notice.PRICE_CHANGED', { now, was }) : t('notice.PRICE_ANY')
    }
    case 'REVISION_CHANGED':
      return t('notice.REVISION_CHANGED')
    case 'SIZES_DROPPED':
      return facts.dropped && facts.dropped.length > 0 ? t('notice.SIZES_DROPPED', { sizes: facts.dropped.join(', ') }) : t('notice.SIZES_DROPPED_SOME')
    case 'COLOUR_DISCONTINUED':
      return t('notice.COLOUR_DISCONTINUED', { colour: facts.colour ?? '' })
    case 'STYLE_NOT_SOLD':
      return t('notice.STYLE_NOT_SOLD', { style: facts.style ?? '' })
    case 'MADE_TO_MEASURE':
      return t('notice.MADE_TO_MEASURE')
    case 'NO_SIZES_LEFT':
      return t('notice.NO_SIZES_LEFT')
  }
}

export const noticeTone = (code: NoticeCode): 'info' | 'warning' | 'danger' => (code === 'PRICE_CHANGED' || code === 'REVISION_CHANGED' ? 'info' : code === 'STYLE_NOT_SOLD' || code === 'MADE_TO_MEASURE' || code === 'NO_SIZES_LEFT' ? 'danger' : 'warning')

// ── the send ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface WriteFacts {
  /** An office person previewing the portal: nothing is written. */
  preview: boolean
  offline: boolean
  busy: boolean
}

/** Why nothing can be written now (a key), or null. */
export function writeHeld(facts: WriteFacts): string | null {
  if (facts.preview) return 'held.preview'
  if (facts.offline) return 'held.offline'
  if (facts.busy) return 'held.busy'
  return null
}

// ---- F-CP-150 (customer page plan C5, D9–D11; 12 §2): the draft order page v1 ----------------------------------------------
// The ONE draft (PortalOrderRequest, D9): a band ("Draft order · <title>", Discard…, Send to the factory), ONE banner, the
// checklist of seven parts as chips (the domain's own `draftReadiness`, the rule the office's Drafts view reads too), section
// cards, "The factory can read this draft. Work starts only when you send it." Lines and people keep their `seq` (rows never jump
// under the cursor). What only the schema wave and B-CP-075 add (line kinds, the roster, laterParts, "by <name>") is read as
// optional: absent, the page says less, never something false.

/** The seven parts of a draft, in the page's order (the domain's: factory-domain sales/portal-ordering/office DRAFT_PARTS). */
export { DRAFT_PARTS }
export type { DraftPart, DraftPartState }

/** Where a chip scrolls to (each part's card; the page focuses it). "Show me" goes to the same places (`problemPlace`). */
export const DRAFT_PART_TARGET: Readonly<Record<DraftPart, string>> = Object.freeze({
  NEED: 'lines',
  LOGOS: 'part-logos',
  REFERENCES: 'part-references',
  PEOPLE: 'part-people',
  DATE: 'order-head',
  PRICE: 'part-price',
  NOTES: 'part-notes',
})

/** The parts the customer marked "we send it later" (B-CP-075; an older answer: none; an unknown word is left out). */
export const laterPartsOf = (request: Pick<DraftRequest, 'laterParts'>): DraftLaterPart[] => (request.laterParts ?? []).filter((part): part is DraftLaterPart => (DRAFT_LATER_PARTS as readonly string[]).includes(part))

/** The header's own problems (a date that passed, an address no longer in use): the date part is missing while one is left. */
const HEADER_CODES: readonly Problem['code'][] = ['DATE_PAST', 'SHIP_TO_ARCHIVED']

/** The lines in their order (by `seq`, never by when they were read: a row never jumps under the cursor). */
export const linesInOrder = <Line extends Pick<DraftLine, 'seq'>>(lines: readonly Line[]): Line[] => [...lines].sort((a, b) => a.seq - b.seq)

/** What the checklist counts, from the draft as read (the files with F-CP-151; the customer's own prices with F-CP-154). */
export function draftFactsOf(record: Pick<DraftRecord, 'request' | 'seesPrices'>): DraftFacts {
  const request = record.request
  // F-CP-154 (B-CP-075): the lines of every kind count — a described line by its total or sizes, a by-person line by its people or
  // the measurement sheet on it (the domain's own rule, as the office's Drafts view counts them).
  const custom = customLinesOf(request)
  const sheetLines = new Set(draftFilesOf(request).sheets.flatMap((file) => (file.lineId ? [file.lineId] : [])))
  const customWithout = custom.filter((line) => !lineHasPieces({ kind: line.kind, quantity: line.quantity, sizes: line.sizes, byPerson: line.byPerson, people: line.people.length, sheetOnLine: sheetLines.has(line.id) || line.peopleInSheet })).length
  return {
    lines: request.lines.length + custom.length,
    linesWithoutPieces: request.lines.filter((line) => line.pieces === 0).length + customWithout,
    // F-CP-151: the draft's own files and its lines' (B-CP-072).
    logos: draftFilesOf(request).logos.length,
    references: draftFilesOf(request).references.length,
    requestedDate: request.requestedDate !== null && request.requestedDate !== '',
    headerProblems: request.problems.filter((problem) => problem.lineId === null && HEADER_CODES.includes(problem.code)).length,
    note: (request.note ?? '').trim() !== '',
    later: laterPartsOf(request),
    // Part 6 is not counted for a reader without the price grain (review B4). F-CP-154: a price holder's lines with their own price.
    pricedLines: record.seesPrices ? [...request.lines, ...custom].filter((line) => line.brandUnitPrice !== undefined && line.brandUnitPrice !== null).length : null,
    problems: request.problems.length,
    problemsByPart: problemsByPartOf(request.problems), // F-CP-154: a part with a problem is not ready (the domain's own rule)
  }
}

export interface DraftChip {
  part: DraftPart
  /** 1–7, the card's number. */
  n: number
  state: DraftPartState
  /** The card's element id (a chip scrolls to it and focuses it). */
  target: string
}

/**
 * The checklist strip: the seven parts with their states. A reader without prices still sees part 6 in the strip, "Optional"
 * (picture 22, the brand's Designer: its card says prices are not part of the access) — it is never counted for them.
 */
export function draftChips(record: Pick<DraftRecord, 'request' | 'seesPrices'>): DraftChip[] {
  const readiness = draftReadiness(draftFactsOf(record))
  const states = new Map(readiness.parts.map((entry) => [entry.part, entry.state]))
  return DRAFT_PARTS.map((part, index) => ({ part, n: index + 1, state: states.get(part) ?? 'OPTIONAL', target: DRAFT_PART_TARGET[part] }))
}

/** A part's state as a DS tone: Ready green, Sending later amber, Missing red, Optional plain. */
export const partTone = (state: DraftPartState): 'success' | 'warning' | 'danger' | 'neutral' => (state === 'READY' ? 'success' : state === 'LATER' ? 'warning' : state === 'MISSING' ? 'danger' : 'neutral')

/**
 * The draft's name: its first line (by seq) — the style's code and name —, else "Untitled draft". F-CP-154: a line in the customer's
 * own words names its words (the first line, cut), else its garment type, else its style.
 */
export function draftTitleOf(request: Pick<DraftRequest, 'lines'> & Partial<Pick<DraftRequest, 'customLines'>>, t: Translate, locale?: Locale): string {
  const first = entriesInOrder(request)[0]
  if (!first) return t('draftPage.untitled')
  return first.kind === 'CATALOGUE' ? `${first.line.style.code} ${first.line.style.name}` : customTitleOf(first.line, t, locale)
}

/** "Saved 14:02 by Marta Bianchi · v14" (the name once B-CP-075 says who changed it last; else "Saved 14:02 · v14"). */
export function savedWords(request: Pick<DraftRequest, 'updatedAt' | 'version' | 'lastEditedAt' | 'lastEditedBy'>, t: Translate, time: (iso: string) => string): string {
  const when = time(request.lastEditedAt ?? request.updatedAt)
  const saved = request.lastEditedBy ? t('draftPage.savedBy', { time: when, name: request.lastEditedBy }) : t('draftPage.saved', { time: when })
  return `${saved} · ${t('draftPage.version', { n: request.version })}`
}

export type DraftBannerKind = 'offline' | 'stale' | 'refused' | 'notice' | 'problems'

/** The page's ONE banner, by weight: offline, changed elsewhere, a refusal, a done line (with Undo), the problems that hold Send. */
export function draftBannerOf(input: { offline: boolean; stale: boolean; refused: boolean; notice: boolean; problems: number }): DraftBannerKind | null {
  if (input.offline) return 'offline'
  if (input.stale) return 'stale'
  if (input.refused) return 'refused'
  if (input.notice) return 'notice'
  return input.problems > 0 ? 'problems' : null
}

/** "Line 1: size grid, 24 pieces" — the People and sizes card of v1 (the roster comes with F-CP-154). */
export const peopleLineWords = (line: Pick<DraftLine, 'seq' | 'pieces'>, t: Translate, pieces: (n: number) => string): string =>
  line.pieces > 0 ? t('draftPage.people.grid', { seq: line.seq, pieces: pieces(line.pieces) }) : t('draftPage.people.none', { seq: line.seq })
// ---- end F-CP-150

// ---- F-CP-151 (customer page plan C5; 12 §2 parts 2–4; D14): the draft's files cards ------------------------------------------
// Logos (filed as artwork; vector prints best, a picture is never refused for it), references (pictures or PDFs), measurement
// sheets (body data). On live the virus scanner does not run yet (O7 not approved): the cards say to e-mail the files, naming the
// draft; lines, sizes and notes still work. At most DRAFT_FILES_MAX files on a draft (its own and its lines' together).

export { DRAFT_FILES_MAX }

const NO_FILES = Object.freeze({ logos: [] as DraftFile[], references: [] as DraftFile[], sheets: [] as DraftFile[] })

/** The draft's files by part (an answer from before B-CP-072: none). */
export const draftFilesOf = (request: Pick<DraftRequest, 'files'>): { logos: readonly DraftFile[]; references: readonly DraftFile[]; sheets: readonly DraftFile[] } => request.files ?? NO_FILES

/** How many files the draft holds (the cap counts them all). */
export const draftFileCount = (request: Pick<DraftRequest, 'files'>): number => {
  const files = draftFilesOf(request)
  return files.logos.length + files.references.length + files.sheets.length
}

/** Files go up here now: only when the API says so (an answer without it: closed — the e-mail way). */
export const uploadsOpenOf = (request: Pick<DraftRequest, 'uploads'>): boolean => request.uploads?.open ?? false

/** Why a file cannot be added now (a key), or null: a preview or offline first, then the draft's cap. */
export function filesAddHeld(request: Pick<DraftRequest, 'files'>, facts: WriteFacts): string | null {
  return writeHeld(facts) ?? (draftFileCount(request) >= DRAFT_FILES_MAX ? 'draftPage.files.full' : null)
}

/** The part a card's files are, and the list they come from. */
export const FILE_PART_OF: Readonly<Record<'logos' | 'references' | 'sheets', DraftFilePart>> = Object.freeze({ logos: 'LOGO', references: 'REFERENCE', sheets: 'SHEET' })

/** The checklist part a file part marks "we send it later" (sheets belong to People and sizes). */
export const LATER_PART_OF: Readonly<Record<DraftFilePart, DraftLaterPart>> = Object.freeze({ LOGO: 'LOGOS', REFERENCE: 'REFERENCES', SHEET: 'PEOPLE' })

/**
 * The "Sending later" toggle of a part: shown once the API keeps the mark (B-CP-075 answers `laterParts`; before it, null: no
 * toggle, never one that saves nothing), whether it is on, and the parts a change sends.
 */
export function laterToggleOf(request: Pick<DraftRequest, 'laterParts'>, part: DraftLaterPart): { on: boolean; next: DraftLaterPart[] } | null {
  if (request.laterParts === undefined) return null
  const later = laterPartsOf(request)
  const on = later.includes(part)
  return { on, next: on ? later.filter((entry) => entry !== part) : DRAFT_LATER_PARTS.filter((entry) => entry === part || later.includes(entry)) }
}

const VECTOR = /\.(ai|eps|ps|pdf)$/i
const VECTOR_TYPES = ['application/pdf', 'application/postscript', 'application/illustrator', 'application/vnd.adobe.illustrator']

/** What a file is, in a word: a vector file (prints best), a picture, or a document. */
export function fileKindOf(file: Pick<DraftFile, 'originalName' | 'contentType' | 'kind'>): 'vector' | 'picture' | 'document' {
  if (VECTOR.test(file.originalName) || VECTOR_TYPES.includes(file.contentType)) return 'vector'
  return file.kind === 'PHOTO' || file.contentType.startsWith('image/') ? 'picture' : 'document'
}

/** Where a file sits: "on the draft", or "on line 2" (by the line's seq). */
export function fileWhereWords(file: Pick<DraftFile, 'lineId'>, lines: readonly Pick<DraftLine, 'id' | 'seq'>[], t: Translate): string {
  const line = file.lineId ? lines.find((entry) => entry.id === file.lineId) : undefined
  return line ? t('draftPage.files.onLine', { seq: line.seq }) : t('draftPage.files.onDraft')
}

/** A file still held for the virus scan (where one runs) says so; an available one says nothing. */
export const fileHeldKey = (file: Pick<DraftFile, 'status'>): string | null => (file.status === 'AVAILABLE' ? null : 'draftPage.files.scanning')

/** How the draft is named in the e-mail way ("naming «BA-PO-4521»"): their PO, else its title. */
export const draftMailName = (request: Pick<DraftRequest, 'customerRef' | 'lines'>, t: Translate): string => request.customerRef ?? draftTitleOf(request, t)
// ---- end F-CP-151

// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4 and 6; review A5, E4, G6; 11 §1.3 D3): lines of every kind, the People and
// sizes roster, "Your price" -----------------------------------------------------------------------------------------------------
// The draft holds three kinds of line, one list by seq (rows never jump): From the catalogue (style × colour, the size grid), Described
// by you (their words, colours in words, maybe their own-label style, a total — sizes may follow —, or one row per person), Made to
// measure (a garment type, maybe a style, always one row per person). A by-person line has a roster: each person a name, maybe a
// number, and ONE of Size · Measurement sheet · Sending later (no "Saved measurements" in v1: lead pick). A measurement sheet on the
// line stands for its roster ("People: in the attached sheet", review A5). Made to measure is open by default; only where the office
// switched it off it says "Made to measure is not open for you yet". The ONE "Your price (without VAT)" cell, per line, only for a
// price holder (the customer's Buyer, Finance, Admin): anyone else reads "Prices are not part of your access." — the API sends no
// price to them and refuses one from them (M-CP-2).

/** The draft's lines in the customer's own words (an older answer: none). */
export const customLinesOf = (request: Partial<Pick<DraftRequest, 'customLines'>>): readonly CustomLine[] => request.customLines ?? []

/** One line of the draft, of any kind. */
export type DraftEntry = { readonly kind: 'CATALOGUE'; readonly line: DraftLine } | { readonly kind: CustomLineKind; readonly line: CustomLine }

/** Every line of the draft, catalogue and custom, in ONE order: by seq (both carry it; a row never jumps under the cursor). */
export function entriesInOrder(request: Pick<DraftRequest, 'lines'> & Partial<Pick<DraftRequest, 'customLines'>>): DraftEntry[] {
  const entries: DraftEntry[] = [...request.lines.map((line) => ({ kind: 'CATALOGUE' as const, line })), ...customLinesOf(request).map((line) => ({ kind: line.kind, line }))]
  return entries.sort((a, b) => a.line.seq - b.line.seq)
}

/** How many lines the draft holds, of every kind. */
export const lineCountOf = (request: Pick<DraftRequest, 'lines'> & Partial<Pick<DraftRequest, 'customLines'>>): number => request.lines.length + customLinesOf(request).length

/** The kinds a new line may be in the customer's own words ("Describe it", "Made to measure" in "Add a line ▾"). */
export const ADD_KINDS = ['described', 'mtm'] as const
export type AddKind = (typeof ADD_KINDS)[number]
export const isAddKind = (value: unknown): value is AddKind => typeof value === 'string' && (ADD_KINDS as readonly string[]).includes(value)
export const ADD_KIND_OF: Readonly<Record<AddKind, CustomLineKind>> = Object.freeze({ described: 'DESCRIBED', mtm: 'MADE_TO_MEASURE' })

/** A line's kind in words: "From the catalogue" · "Described by you" · "Made to measure". */
export const kindKey = (kind: DraftEntry['kind']): string => `draftPage.kind.${kind}`

/** Made to measure for this customer: open unless the office switched it off; never offered once the draft is no longer one. */
export function mtmOf(request: Pick<DraftRequest, 'status'> & Partial<Pick<DraftRequest, 'madeToMeasure'>>): { open: boolean; garmentTypes: MadeToMeasure['garmentTypes'] } {
  if (request.status !== 'DRAFT' || request.madeToMeasure === null) return { open: false, garmentTypes: [] }
  if (request.madeToMeasure === undefined) return { open: true, garmentTypes: [] }
  return { open: request.madeToMeasure.open, garmentTypes: request.madeToMeasure.garmentTypes }
}

/** Why a made-to-measure line cannot be added (a key), or null: "not open for you yet" only where the office switched it off. */
export const mtmHeldKey = (request: Pick<DraftRequest, 'status'> & Partial<Pick<DraftRequest, 'madeToMeasure'>>): string | null => (mtmOf(request).open ? null : 'draftPage.mtmOff')

const TITLE_MAX = 60
const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== '')?.trim() ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** A custom line's name: its words (the first line, cut), else its garment type, else its style, else "Untitled line". */
export function customTitleOf(line: Pick<CustomLine, 'style' | 'description' | 'garmentType'>, t: Translate, locale?: Locale): string {
  if (line.description && line.description.trim() !== '') return firstLine(line.description)
  if (line.garmentType) return locale ? line.garmentType.words[locale] : line.garmentType.code
  if (line.style) return `${line.style.code} ${line.style.name}`.trim()
  return t('draftPage.line.untitled')
}

/** A custom line's quantities in words: "30 pieces · sizes later", "30 pieces · in sizes: S 10 · M 20", "By person · 4 people", "By person · People: in the attached sheet". */
export function customDetailWords(line: Pick<CustomLine, 'byPerson' | 'quantity' | 'sizes' | 'people' | 'peopleInSheet'>, t: Translate, pieces: (n: number) => string): string {
  if (line.byPerson) {
    const who = line.people.length > 0 ? t('draftPage.line.people', { count: line.people.length }) : line.peopleInSheet ? t('draftPage.line.inSheet') : t('draftPage.line.noPeople')
    return `${t('draftPage.line.byPerson')} · ${who}`
  }
  if (line.quantity === null) return t('draftPage.line.noTotal')
  const total = t('draftPage.line.total', { pieces: pieces(line.quantity) })
  return line.sizes.length > 0 ? `${total} · ${t('draftPage.line.inSizes', { sizes: line.sizes.map((row) => `${row.size} ${row.quantity}`).join(' · ') })}` : `${total} · ${t('draftPage.line.sizesLater')}`
}

/** Part 4's line of a custom line: "Line 2: 30 pieces · sizes later", "Line 3, by person: 4 people" or "… in the attached sheet". */
export function customPeopleWords(line: Pick<CustomLine, 'seq' | 'byPerson' | 'quantity' | 'sizes' | 'people' | 'peopleInSheet'>, t: Translate, pieces: (n: number) => string): string {
  if (line.byPerson) {
    if (line.people.length > 0) return t('draftPage.people.byPerson', { seq: line.seq, count: line.people.length })
    return line.peopleInSheet ? t('draftPage.people.inSheet', { seq: line.seq }) : t('draftPage.people.noOne', { seq: line.seq })
  }
  if (line.quantity === null) return t('draftPage.people.noTotal', { seq: line.seq })
  return line.sizes.length > 0 ? t('draftPage.people.totalSizes', { seq: line.seq, pieces: pieces(line.quantity) }) : t('draftPage.people.total', { seq: line.seq, pieces: pieces(line.quantity) })
}

/** Part 4's line of any line: its pieces as the draft holds them; missing while it has none (and no sheet stands for its people). */
export function entryPeopleOf(entry: DraftEntry, t: Translate, pieces: (n: number) => string): { words: string; missing: boolean; target: string } {
  if (entry.kind === 'CATALOGUE') return { words: peopleLineWords(entry.line, t, pieces), missing: entry.line.pieces === 0, target: `line-${entry.line.id}` }
  const line = entry.line
  const missing = line.byPerson ? line.people.length === 0 && !line.peopleInSheet : line.quantity === null
  return { words: customPeopleWords(line, t, pieces), missing, target: line.byPerson ? `people-${line.id}` : `line-${line.id}` }
}

// ── a custom line typed in its window ──────────────────────────────────────────────────────────────────────────────────────
export interface CustomLineDraft {
  kind: CustomLineKind
  description: string
  colourText: string
  /** '' = none. */
  styleId: string
  /** MADE_TO_MEASURE: a garment type's code ('' = none chosen yet). */
  garmentType: string
  /** DESCRIBED: a total in pieces as typed ('' = none yet: sizes later). */
  total: string
  /** DESCRIBED: one row per person instead of a total (made to measure: always). */
  byPerson: boolean
  note: string
}

export type CustomLineField = 'description' | 'colourText' | 'garmentType' | 'total' | 'note'

export function customLineDraftOf(kind: CustomLineKind, line: CustomLine | null = null): CustomLineDraft {
  return {
    kind,
    description: line?.description ?? '',
    colourText: line?.colourText ?? '',
    styleId: line?.style?.id ?? '',
    garmentType: line?.garmentType?.code ?? '',
    total: line && line.quantity !== null ? String(line.quantity) : '',
    byPerson: kind === 'MADE_TO_MEASURE' ? true : (line?.byPerson ?? false),
    note: line?.note ?? '',
  }
}

const blankOr = (value: string): string | null => (value.trim() === '' ? null : value.trim())
/** A total as typed: null (empty), a whole number, or NaN (not one). */
const totalOf = (value: string): number | null => (value.trim() === '' ? null : /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN)

/** The window's problems by field (keys of this catalogue), by the API's limits: what it needs before it saves. */
export function customLineProblems(draft: CustomLineDraft): Partial<Record<CustomLineField, string>> {
  const out: Partial<Record<CustomLineField, string>> = {}
  if (draft.kind === 'DESCRIBED' && draft.description.trim() === '') out.description = 'draftPage.customLine.problem.description'
  else if (draft.description.trim().length > CUSTOM_LINE_LIMITS.description) out.description = 'draftPage.customLine.problem.descriptionLong'
  if (draft.colourText.trim().length > CUSTOM_LINE_LIMITS.colourText) out.colourText = 'draftPage.customLine.problem.coloursLong'
  if (draft.kind === 'MADE_TO_MEASURE' && draft.garmentType.trim() === '') out.garmentType = 'draftPage.customLine.problem.garment'
  if (draft.kind === 'DESCRIBED' && !draft.byPerson) {
    const total = totalOf(draft.total)
    if (total !== null && (!Number.isInteger(total) || total < 1 || total > CUSTOM_LINE_LIMITS.total)) out.total = 'draftPage.customLine.problem.total'
  }
  if (draft.note.trim().length > LIMITS.lineNote) out.note = 'draftPage.customLine.problem.noteLong'
  return out
}

/**
 * What a new custom line sends: its own fields only (blanks left out). A described line by person sends no total; a described total may
 * stay empty ("sizes later" — the send asks for it). Made to measure: always by person, never a total.
 */
export function customLineBody(draft: CustomLineDraft): { kind: CustomLineKind } & CustomLineFields {
  const body: { kind: CustomLineKind } & CustomLineFields = { kind: draft.kind }
  const description = blankOr(draft.description)
  const colourText = blankOr(draft.colourText)
  const styleId = blankOr(draft.styleId)
  const lineNote = blankOr(draft.note)
  if (description) body.description = description
  if (colourText) body.colourText = colourText
  if (styleId) body.styleId = styleId
  if (lineNote) body.note = lineNote
  if (draft.kind === 'MADE_TO_MEASURE') {
    body.garmentType = draft.garmentType.trim()
    return body
  }
  if (draft.byPerson) body.byPerson = true
  else {
    const total = totalOf(draft.total)
    if (total !== null && Number.isInteger(total)) body.quantity = total
  }
  return body
}

/** What a change of a custom line sends: only the fields typed differently (blank = null); nothing changed → an empty body. */
export function customLineChanges(line: CustomLine, draft: CustomLineDraft): CustomLineFields {
  const out: CustomLineFields = {}
  const before = customLineDraftOf(line.kind, line)
  if ((blankOr(before.description) ?? '') !== (blankOr(draft.description) ?? '')) out.description = blankOr(draft.description)
  if ((blankOr(before.colourText) ?? '') !== (blankOr(draft.colourText) ?? '')) out.colourText = blankOr(draft.colourText)
  if (before.styleId !== draft.styleId) {
    out.styleId = blankOr(draft.styleId)
    // A colour of ours goes with its style: a new style (or none) drops the old one's colour.
    if (line.colourway) out.colourwayId = null
  }
  if ((blankOr(before.note) ?? '') !== (blankOr(draft.note) ?? '')) out.note = blankOr(draft.note)
  if (line.kind === 'MADE_TO_MEASURE') {
    if (before.garmentType !== draft.garmentType && draft.garmentType.trim() !== '') out.garmentType = draft.garmentType.trim()
    return out
  }
  if (before.byPerson !== draft.byPerson) {
    out.byPerson = draft.byPerson
    // One row per person takes its pieces from its people: no total and no sizes beside it.
    if (draft.byPerson && line.sizes.length > 0) out.sizes = []
  }
  const total = totalOf(draft.total)
  const next = draft.byPerson ? null : total !== null && Number.isInteger(total) ? total : null
  if (next !== line.quantity) out.quantity = next
  return out
}

// ── the roster ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export { PEOPLE_LIMITS }

/** The ways a person is measured, in the window's order (v1: no saved measurements — lead pick). */
export const MEASURES: readonly MeasureBy[] = Object.freeze(['SIZE', 'SHEET', 'LATER'] as MeasureBy[])

/** How we get a person's size, in words: Size · Measurement sheet · Sending later. */
export const measureKey = (measureBy: MeasureBy): string => `draftPage.measure.${measureBy}`

/** The draft's by-person lines (each has its own roster), in the draft's order. */
export const rosterLinesOf = (request: Partial<Pick<DraftRequest, 'customLines'>>): CustomLine[] => [...customLinesOf(request)].filter((line) => line.byPerson).sort((a, b) => a.seq - b.seq)

/** The people of a roster in their places (by seq: a row never jumps). */
export const peopleInOrder = (people: readonly DraftPerson[]): DraftPerson[] => [...people].sort((a, b) => a.seq - b.seq)

/** The measurement sheets on one line (they stand for its roster while no one is named). */
export const sheetsOfLine = (request: Pick<DraftRequest, 'files'>, lineId: string): readonly DraftFile[] => draftFilesOf(request).sheets.filter((file) => file.lineId === lineId)

/** What is there for a person: their size, their sheet's name (a sheet gone from the draft says so), or "Sending later". */
export function personWhat(person: Pick<DraftPerson, 'measureBy' | 'size' | 'sheet'>, t: Translate): string {
  if (person.measureBy === 'SIZE') return person.size ?? '—'
  if (person.measureBy === 'SHEET') return person.sheet?.originalName ?? t('draftPage.roster.sheetGone')
  return t('draftPage.measure.LATER')
}

export interface PersonDraft {
  name: string
  number: string
  measureBy: MeasureBy
  size: string
  /** SHEET: a measurement sheet of this draft ('' = none chosen yet). */
  sheetId: string
  note: string
}

export type PersonField = 'name' | 'number' | 'size' | 'sheet' | 'note'

export const EMPTY_PERSON: Readonly<PersonDraft> = Object.freeze({ name: '', number: '', measureBy: 'SIZE' as MeasureBy, size: '', sheetId: '', note: '' })

export const personDraftOf = (person: DraftPerson | null): PersonDraft =>
  person ? { name: person.name, number: person.number ?? '', measureBy: person.measureBy, size: person.size ?? '', sheetId: person.sheet?.id ?? '', note: person.note ?? '' } : { ...EMPTY_PERSON }

/** The person window's problems by field (keys), by the API's limits; a sheet must be one of this draft's measurement sheets. */
export function personProblems(draft: PersonDraft, sheets: readonly Pick<DraftFile, 'id'>[]): Partial<Record<PersonField, string>> {
  const out: Partial<Record<PersonField, string>> = {}
  const name = draft.name.trim()
  if (name === '' || name.length > PEOPLE_LIMITS.name) out.name = 'draftPage.person.problem.name'
  if (draft.number.trim().length > PEOPLE_LIMITS.number) out.number = 'draftPage.person.problem.number'
  if (draft.measureBy === 'SIZE' && (draft.size.trim() === '' || draft.size.trim().length > PEOPLE_LIMITS.size)) out.size = 'draftPage.person.problem.size'
  if (draft.measureBy === 'SHEET' && !sheets.some((sheet) => sheet.id === draft.sheetId)) out.sheet = 'draftPage.person.problem.sheet'
  if (draft.note.trim().length > PEOPLE_LIMITS.note) out.note = 'draftPage.person.problem.note'
  return out
}

/** What a new person sends: the name, maybe a number and a note, and only the field of their way of being measured. */
export function personBody(draft: PersonDraft): PersonFields {
  const body: PersonFields = { name: draft.name.trim(), measureBy: draft.measureBy }
  const number = blankOr(draft.number)
  const personNote = blankOr(draft.note)
  if (number) body.number = number
  if (personNote) body.note = personNote
  if (draft.measureBy === 'SIZE') body.size = draft.size.trim()
  if (draft.measureBy === 'SHEET') body.measurementFileId = draft.sheetId
  return body
}

/** What a change of a person sends: only what changed; a new way of being measured sends its field and clears the other one. */
export function personChanges(person: DraftPerson, draft: PersonDraft): Partial<PersonFields> {
  const out: Partial<PersonFields> = {}
  const before = personDraftOf(person)
  if (before.name.trim() !== draft.name.trim()) out.name = draft.name.trim()
  if ((blankOr(before.number) ?? '') !== (blankOr(draft.number) ?? '')) out.number = blankOr(draft.number)
  if ((blankOr(before.note) ?? '') !== (blankOr(draft.note) ?? '')) out.note = blankOr(draft.note)
  if (before.measureBy !== draft.measureBy) {
    out.measureBy = draft.measureBy
    out.size = draft.measureBy === 'SIZE' ? draft.size.trim() : null
    out.measurementFileId = draft.measureBy === 'SHEET' ? draft.sheetId : null
  } else if (draft.measureBy === 'SIZE' && before.size.trim() !== draft.size.trim()) out.size = draft.size.trim()
  else if (draft.measureBy === 'SHEET' && before.sheetId !== draft.sheetId) out.measurementFileId = draft.sheetId
  return out
}

// ---- od-w1.1 (THE SIMPLE ORDER START; plan § 8 the money wall): the draft as the shared part reads it ----------------------------
// The record comes grain-filtered from the API, with the reader's prices when they hold the price grain. The shared part (both doors,
// every role) never gets one: its view model is the record without a single price, a price count or a currency. Prices live only in
// the hosts' own cards (portal "Your price", office "Price").

/** A catalogue line without its prices. */
export type DraftViewLine = Omit<DraftLine, 'unitPriceShown' | 'priceNow' | 'amount' | 'brandUnitPrice'>
/** A line in the customer's own words without its price. */
export type DraftViewCustomLine = Omit<CustomLine, 'brandUnitPrice'>
export type DraftViewRequest = Omit<DraftRequest, 'lines' | 'customLines' | 'summary' | 'pricesChanged' | 'currency'> & {
  lines: DraftViewLine[]
  customLines?: DraftViewCustomLine[]
  summary: { lines: number; pieces: number }
}
export interface DraftView {
  request: DraftViewRequest
  addresses: readonly ShipTo[]
}

/** The record without a single price: what the shared part draws (the hosts keep the record for their own price cards). */
export function draftViewOf(record: Pick<DraftRecord, 'request' | 'addresses'>): DraftView {
  const { lines, customLines, summary, pricesChanged: _pricesChanged, currency: _currency, ...rest } = record.request
  return {
    request: {
      ...rest,
      lines: lines.map(({ unitPriceShown: _shown, priceNow: _now, amount: _amount, brandUnitPrice: _brand, ...line }) => line),
      ...(customLines ? { customLines: customLines.map(({ brandUnitPrice: _brand, ...line }) => line) } : {}),
      summary: { lines: summary.lines, pieces: summary.pieces },
    },
    addresses: record.addresses,
  }
}
// ---- end od-w1.1
