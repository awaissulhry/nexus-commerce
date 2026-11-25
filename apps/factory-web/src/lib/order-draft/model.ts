import { formatNumber } from '../i18n/format'
import type { Locale } from '../i18n/locales'
import { addressLine } from '../address-line'
import { LIMITS, STILL_OPEN_KINDS, type CustomLine, type CustomLineKind, type DraftChoice, type DraftFile, type DraftLine, type DraftPerson, type DraftRecord, type DraftRequest, type HeaderBody, type MadeToMeasure, type MeasureBy, type NoticeCode, type PersonFields, type Problem, type SavedBy, type ShipTo, type SizeAsk, type Sizing, type StillOpen, type StillOpenKind } from './schema'
import { DRAFT_FILES_MAX } from '@nexus/factory-domain/sales/portal-ordering/draft-files'
import { PEOPLE_LIMITS } from '@nexus/factory-domain/sales/portal-ordering/people'

/**
 * The ONE draft order, pure (THE SIMPLE ORDER START, od-w1.1 — moved out of the portal's New order, `portal/customer/neworder/model.ts`,
 * B-W2b-194 and the customer page's F-CP-150…154): the header's autosave (only what changed, checked by the API's limits), the
 * delivery addresses it offers, a line's size grid and what its save sends, every problem and notice in the page's words from codes
 * and figures, the files, the lines of every kind and their people. No door's words, no fetch: each host gives its commands
 * (`api-port.ts`) and its words (`words.ts`, the part's own catalogue `order-draft`). The containers read and write; the views draw.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export const pieces = (n: number, locale: Locale): string => formatNumber(n, locale, { maximumFractionDigits: 0 })

/** Today in the site's zone (YYYY-MM-DD). */
export const todayIn = (now: Date = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)

// ── the header ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HeaderDraft {
  /** od- R2: the mail's subject (the draft's title). */
  subject: string
  customerRef: string
  shipToAddressId: string
  requestedDate: string
  note: string
}
export type HeaderField = keyof HeaderDraft
/** Every field of the header, in the page's order (od- R2: the subject first). */
export const HEADER_FIELDS: HeaderField[] = ['subject', 'note', 'customerRef', 'shipToAddressId', 'requestedDate']
/** The subject's limit (addendum R2: 1–200, trimmed). */
export const SUBJECT_MAX = 200

export const headerDraftOf = (request: (Pick<DraftRequest, 'customerRef' | 'shipToAddressId' | 'requestedDate' | 'note'> & Partial<Pick<DraftRequest, 'subject'>>) | null): HeaderDraft => ({
  subject: request?.subject ?? '',
  customerRef: request?.customerRef ?? '',
  shipToAddressId: request?.shipToAddressId ?? '',
  requestedDate: request?.requestedDate ?? '',
  note: request?.note ?? '',
})

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

/** The fields typed differently from what the draft holds (what the autosave sends; blank = null). */
export function headerChanges(saved: HeaderDraft, draft: HeaderDraft, only?: HeaderField): HeaderBody {
  const out: HeaderBody = {}
  const fields: HeaderField[] = only ? [only] : HEADER_FIELDS
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
      return t('problem.COLOUR_DISCONTINUED', { colour: line?.colourway?.name ?? own?.colourway?.name ?? '' })
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

// ---- F-CP-150 (customer page plan C5, D9–D11; 12 §2): the ONE draft — rows keep their `seq` (a row never jumps under the cursor).

/** The lines in their order (by `seq`, never by when they were read: a row never jumps under the cursor). */
export const linesInOrder = <Line extends Pick<DraftLine, 'seq'>>(lines: readonly Line[]): Line[] => [...lines].sort((a, b) => a.seq - b.seq)

/**
 * The draft's name (od- R2): its subject; else its first row's product (by seq) — the style's code and name, or the customer's own
 * words (the first line, cut), or its garment type —; else "Draft order {date}" (the day it was started).
 */
export function draftTitleOf(request: Pick<DraftRequest, 'lines'> & Partial<Pick<DraftRequest, 'customLines' | 'subject' | 'createdAt'>>, t: Translate, locale?: Locale, day?: (iso: string) => string): string {
  const subject = request.subject?.trim()
  if (subject) return subject
  const first = entriesInOrder(request)[0]
  const named = first ? (first.kind === 'CATALOGUE' ? `${first.line.style.code} ${first.line.style.name}` : customNameOf(first.line, locale)) : null
  if (named) return named
  return t('head.untitled', { date: day && request.createdAt ? day(request.createdAt) : '' }).trim()
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

const VECTOR = /\.(ai|eps|ps|pdf)$/i
const VECTOR_TYPES = ['application/pdf', 'application/postscript', 'application/illustrator', 'application/vnd.adobe.illustrator']

/** What a file is, in a word: a vector file (prints best), a picture, or a document. */
export function fileKindOf(file: Pick<DraftFile, 'originalName' | 'contentType' | 'kind'>): 'vector' | 'picture' | 'document' {
  if (VECTOR.test(file.originalName ?? '') || VECTOR_TYPES.includes(file.contentType)) return 'vector'
  return file.kind === 'PHOTO' || file.contentType.startsWith('image/') ? 'picture' : 'document'
}

/** A file still held for the virus scan (where one runs) says so; an available one says nothing. */
export const fileHeldKey = (file: Pick<DraftFile, 'status'>): string | null => (file.status === 'AVAILABLE' ? null : 'draftPage.files.scanning')

/** How the draft is named in the e-mail way ("naming «BA-PO-4521»"): their PO, else its title. */
export const draftMailName = (request: Pick<DraftRequest, 'customerRef' | 'lines'> & Partial<Pick<DraftRequest, 'customLines' | 'subject'>>, t: Translate): string => request.customerRef ?? draftTitleOf(request, t)
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

/** A line's kind in words: "From the catalogue" · "Described by you" · "Made to measure". */
export const kindKey = (kind: DraftEntry['kind']): string => `draftPage.kind.${kind}`

/** Made to measure for this customer: open unless the office switched it off; never offered once the draft is no longer one. */
export function mtmOf(request: Pick<DraftRequest, 'status'> & Partial<Pick<DraftRequest, 'madeToMeasure'>>): { open: boolean; garmentTypes: MadeToMeasure['garmentTypes'] } {
  if (request.status !== 'DRAFT' || request.madeToMeasure === null) return { open: false, garmentTypes: [] }
  if (request.madeToMeasure === undefined) return { open: true, garmentTypes: [] }
  return { open: request.madeToMeasure.open, garmentTypes: request.madeToMeasure.garmentTypes }
}

const TITLE_MAX = 60
const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find((part) => part.trim() !== '')?.trim() ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** A custom row's product (od- R1): its words (the first line, cut), else its garment type, else its style; null = not decided yet. */
export function customNameOf(line: Pick<CustomLine, 'style' | 'description' | 'garmentType'>, locale?: Locale): string | null {
  if (line.description && line.description.trim() !== '') return firstLine(line.description)
  if (line.garmentType) return locale ? line.garmentType.words[locale] : line.garmentType.code
  if (line.style) return `${line.style.code} ${line.style.name}`.trim()
  return null
}

/** A custom row's name in words: its product, else "Not decided yet". */
export const customTitleOf = (line: Pick<CustomLine, 'style' | 'description' | 'garmentType'>, t: Translate, locale?: Locale): string => customNameOf(line, locale) ?? t('state.OPEN')

const blankOr = (value: string): string | null => (value.trim() === '' ? null : value.trim())

// ── the roster ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export { PEOPLE_LIMITS }

/** The ways a person is measured, in the window's order (v1: no saved measurements — lead pick). */
export const MEASURES: readonly MeasureBy[] = Object.freeze(['SIZE', 'SHEET', 'LATER'] as MeasureBy[])

/** How we get a person's size, in words: Size · Measurement sheet · Sending later. */
export const measureKey = (measureBy: MeasureBy): string => `draftPage.measure.${measureBy}`

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

// ---- od-w1.2 (THE SIMPLE ORDER START R1; 10-design-r1 § 2–§ 4): the mail, the products table, Still open ------------------------
// Nothing is required: every cell may read "Not decided yet". One row per product, catalogue or the customer's own words; its Sizing
// (Standard sizes · Custom size · Not decided yet), Colour, Pieces (a total, a size run or N people), Options (names only) and Files.
// No price anywhere in the table: the rows come from the price-free view (`draftViewOf`).

export type RowPieces =
  | { readonly mode: 'NONE' }
  | { readonly mode: 'TOTAL'; readonly total: number }
  | { readonly mode: 'SIZES'; readonly total: number; readonly sizes: readonly SizeAsk[] }
  | { readonly mode: 'PEOPLE'; readonly people: number; readonly inSheet: boolean }

/** One product row of the table, whatever the line's kind (a row never jumps: by seq). */
export interface ProductRow {
  readonly id: string
  readonly seq: number
  readonly catalogue: boolean
  /** The customer's own words for it (a row in their words), or null. */
  readonly words: string | null
  /** The style it names (a catalogue row's, or the one a row in their words names), or null. */
  readonly style: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly sizing: Sizing | null
  /** The colour in words (a row in their words) or the colourway's name (a catalogue row); null = not decided yet. */
  readonly colour: string | null
  readonly colourwayId: string | null
  /** A catalogue row's colourways to pick from (null: the colour is typed). */
  readonly colours: readonly { readonly id: string; readonly code: string; readonly name: string }[] | null
  /** A catalogue row's sizes on offer (its size grid's columns). */
  readonly offered: readonly string[]
  readonly pieces: RowPieces
  readonly choices: readonly DraftChoice[]
  readonly files: readonly DraftFile[]
  readonly problems: readonly Problem[]
}

/** The rows of the table, in one order by seq (catalogue and the customer's own words together). */
export function productRowsOf(request: Pick<DraftViewRequest, 'lines' | 'files'> & Partial<Pick<DraftViewRequest, 'customLines'>>, locale?: Locale): ProductRow[] {
  const files = draftFilesOf(request)
  const all = [...files.logos, ...files.references, ...files.sheets]
  const filesOf = (lineId: string) => all.filter((file) => file.lineId === lineId)
  return entriesInOrder(request).map((entry): ProductRow => {
    if (entry.kind === 'CATALOGUE') {
      const line = entry.line
      const sizes = line.sizes.filter((row) => row.quantity > 0).map((row) => ({ size: row.size, quantity: row.quantity }))
      return {
        id: line.id,
        seq: line.seq,
        catalogue: true,
        words: null,
        style: line.style,
        sizing: line.sizing ?? null,
        colour: line.colourway?.name ?? null,
        colourwayId: line.colourway?.id ?? null,
        colours: line.colours,
        offered: columnsOf(line),
        pieces: line.pieces > 0 ? { mode: 'SIZES', total: line.pieces, sizes } : { mode: 'NONE' },
        choices: line.choices ?? [],
        files: filesOf(line.id),
        problems: line.problems,
      }
    }
    const line = entry.line
    const pieces: RowPieces = line.byPerson
      ? line.people.length > 0 || line.peopleInSheet
        ? { mode: 'PEOPLE', people: line.people.length, inSheet: line.peopleInSheet }
        : { mode: 'NONE' }
      : line.quantity !== null
        ? line.sizes.length > 0
          ? { mode: 'SIZES', total: line.quantity, sizes: line.sizes }
          : { mode: 'TOTAL', total: line.quantity }
        : { mode: 'NONE' }
    return {
      id: line.id,
      seq: line.seq,
      catalogue: false,
      words: line.description && line.description.trim() !== '' ? line.description.trim() : line.garmentType ? (locale ? line.garmentType.words[locale] : line.garmentType.code) : null,
      style: line.style,
      sizing: line.sizing ?? (line.kind === 'MADE_TO_MEASURE' ? 'MADE_TO_MEASURE' : null),
      colour: line.colourText ?? line.colourway?.name ?? null,
      colourwayId: line.colourway?.id ?? null,
      colours: null,
      offered: [],
      pieces,
      choices: line.choices ?? [],
      files: filesOf(line.id),
      problems: line.problems,
    }
  })
}

/** A row's product in words: the customer's words, else the style ("SEED-JKT-02 Seed crew jacket"); null = not decided yet. */
export const rowProductOf = (row: Pick<ProductRow, 'words' | 'style'>): string | null => row.words ?? (row.style ? `${row.style.code} ${row.style.name}`.trim() : null)

/** "Custom race suit · row 1", or "Row 3" while its product is not decided yet. */
export const rowLabelOf = (row: Pick<ProductRow, 'words' | 'style' | 'seq'>, t: Translate): string => {
  const product = rowProductOf(row)
  return product ? t('still.row', { product, seq: row.seq }) : t('row.label', { seq: row.seq })
}

/** A row's pieces in words: "6 people" · "12 pieces" · "5 pieces" (+ its size run on a second line); null = not decided yet. */
export function rowPiecesWords(pieces: RowPieces, t: Translate, count: (n: number) => string): { main: string; sizes: string | null } | null {
  switch (pieces.mode) {
    case 'NONE':
      return null
    case 'PEOPLE':
      return { main: pieces.people > 0 ? t('cell.people', { count: pieces.people }) : t('draftPage.line.inSheet'), sizes: null }
    case 'TOTAL':
      return { main: t('cell.total', { pieces: count(pieces.total) }), sizes: null }
    case 'SIZES':
      return { main: t('cell.total', { pieces: count(pieces.total) }), sizes: pieces.sizes.map((row) => t('cell.sizeRun', { size: row.size, quantity: row.quantity })).join(' · ') }
  }
}

/** An option as a chip: "Leather: Not decided yet" · "Protection class: AAA". */
export const choiceWords = (choice: DraftChoice, t: Translate): string => `${choice.topic}: ${choice.picked ?? t('state.OPEN')}`

/** The domain's limits on a row's options (13-backend § 1a): up to 10 options, each 2–6 choices, names only. */
export const CHOICE_LIMITS = Object.freeze({ options: 10, choices: 6, minChoices: 2, topic: 60, choice: 60 })

/** The choices typed in the Options window ("one per row"): trimmed, each once, at most six. */
export const choicesTyped = (text: string): string[] =>
  [...new Set(text.split(/\r?\n/).map((part) => part.trim()).filter((part) => part !== ''))].slice(0, CHOICE_LIMITS.choices).map((part) => part.slice(0, CHOICE_LIMITS.choice))

/** Why "Add the option" cannot go (a key), or null: a name, two choices at least, no name twice, room for one more. */
export function optionHeld(choices: readonly DraftChoice[], topic: string, typed: string): string | null {
  const name = topic.trim()
  if (choices.length >= CHOICE_LIMITS.options) return 'opt.full'
  if (name === '') return 'opt.needTopic'
  if (choices.some((choice) => choice.topic.trim().toLowerCase() === name.toLowerCase())) return 'opt.twice'
  if (choicesTyped(typed).length < CHOICE_LIMITS.minChoices) return 'opt.needChoices'
  return null
}

/** Still open (information only, R1): one item per row with what is open there, and the delivery date — from the server's list. */
export interface StillOpenEntry {
  readonly id: string
  /** "Custom race suit · row 1", "Requested delivery date". */
  readonly label: string
  /** "Sizing · Colour · Pieces", "Leather"; null for the date. */
  readonly what: string | null
  /** The row it moves the focus to (null: the date card). */
  readonly rowId: string | null
}

const STILL_OPEN_COLUMN: Readonly<Partial<Record<StillOpenKind, string>>> = { PRODUCT: 'col.product', SIZING: 'col.sizing', COLOUR: 'col.colour', PIECES: 'col.pieces' }

export function stillOpenEntries(stillOpen: StillOpen | undefined, rows: readonly ProductRow[], t: Translate): StillOpenEntry[] {
  if (!stillOpen) return []
  const open = stillOpen.items.filter((item) => item.state !== 'DECIDED' && (STILL_OPEN_KINDS as readonly string[]).includes(item.kind))
  const out: StillOpenEntry[] = []
  for (const row of rows) {
    const mine = open.filter((item) => item.lineId === row.id)
    if (mine.length === 0) continue
    const what = mine.map((item) => (item.kind === 'CHOICE' ? (item.topic ?? '') : t(STILL_OPEN_COLUMN[item.kind as StillOpenKind] ?? 'col.product'))).filter((word) => word !== '')
    out.push({ id: `row-${row.id}`, label: rowLabelOf(row, t), what: [...new Set(what)].join(' · '), rowId: row.id })
  }
  if (open.some((item) => item.kind === 'DATE')) out.push({ id: 'date', label: t('row.date'), what: null, rowId: null })
  if (open.some((item) => item.kind === 'SHIP_TO')) out.push({ id: 'shipTo', label: t('row.shipTo'), what: null, rowId: null })
  return out
}

/** Who saved the draft last, in words (R1): your own save "Draft saved 10:42", a colleague's "Saved 10:42 by …", the office's "… by the factory". */
export function savedByWords(request: Pick<DraftRequest, 'updatedAt' | 'lastEditedAt' | 'lastEditedBy'> & Partial<Pick<DraftRequest, 'savedBy'>>, t: Translate, time: (iso: string) => string): string {
  const when = time(request.lastEditedAt ?? request.updatedAt)
  const by = request.savedBy
  if (by?.who === 'FACTORY') return t('head.savedByFactory', { time: when })
  if (by?.who === 'COLLEAGUE' && by.name) return t('head.savedBy', { time: when, name: by.name })
  if (!by && request.lastEditedBy) return t('head.savedBy', { time: when, name: request.lastEditedBy })
  return t('save.draftSaved', { time: when })
}

/** Who changed the draft meanwhile (a 409's re-read): a colleague by name, any office save as "the factory". */
export const changedByOf = (request: Pick<DraftRequest, 'lastEditedBy'> & Partial<Pick<DraftRequest, 'savedBy'>>): SavedBy | null =>
  request.savedBy ?? (request.lastEditedBy ? { who: 'COLLEAGUE', name: request.lastEditedBy } : null)
// ---- end od-w1.2
