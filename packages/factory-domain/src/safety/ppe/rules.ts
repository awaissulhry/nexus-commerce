import { createHash } from 'node:crypto'
import type { Issue } from '../../core/errors'
import { businessDate, type BusinessDate } from '../../core/time'
import { addMonths } from '../calendar/rules'

/**
 * PPE for workers (B-W2b-134; QHS-259 PPE catalogue, QHS-260 PPE kit per role, QHS-261 issue PPE to a worker with receipt;
 * design plant.ppe and floor.training "Receive PPE"): the rules apps/factory-api modules/safety/ppe applies. Pure.
 *
 *   the catalogue      an item of a company: a code (capitals, no spaces, unique in the tenant), a name, category I, II or III
 *                      (Regulation (EU) 2016/425; never NOT_PPE), the standard it meets, its sizes (each once; none: one size),
 *                      how many months it lasts (1 to 120; none: replaced when worn), the supplier, its unit cost (the cost
 *                      grain). Archived, never deleted; archived only when no ACTIVE role's kit names it (a kit is the role
 *                      sheet's, B-W2b-128, read here and never typed twice).
 *   an issue           one or more lines (item, size, how many, why: new, a replacement, lost) handed to ONE person, with the
 *                      person's receipt: signed on the floor with their badge and PIN (FLOOR_PIN; the floor's own sign-in
 *                      rules and lockout, never an office session) or recorded from a paper receipt in the office (PAPER; the
 *                      scan a file of the receipt). Lines handed over together are one receipt: the rows of one person at one
 *                      site at the same instant with the same method (`receiptKeyOf`); its id is the smallest row id.
 *   a void             a wrong line is voided by a VOID row with the reason (once); the receipt stays, marked void.
 *   gaps               a person's role kit minus the units they hold (factory-domain rolesheets `kitHeld`: ISSUE rows no VOID
 *                      voids), and the units in use whose life is over (`unitsDue`: the newest units up to the kit's quantity,
 *                      replaced after `lifeMonths`).
 *
 * The law in words (plan and design): art. 18 c.1 d (the employer provides suitable PPE), art. 77 c.1 (choosing PPE), art. 77
 * c.4 (keeping it efficient, instructing, the receipt), art. 77 c.5 (category III asks training). No money but the item's
 * unit cost (cost grain); never on the floor.
 */

export const ISSUE_LAW = 'D.Lgs. 81/2008 art. 18 c.1 d'
export const RECEIPT_LAW = 'D.Lgs. 81/2008 art. 77 c.4'
export const CATALOGUE_LAW = 'D.Lgs. 81/2008 art. 77 c.1'
export const CATEGORY_III_LAW = 'D.Lgs. 81/2008 art. 77 c.5'
export const PPE_LAW = { issue: ISSUE_LAW, receipt: RECEIPT_LAW, catalogue: CATALOGUE_LAW, categoryIII: CATEGORY_III_LAW } as const

export const PPE_CATEGORIES = ['CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'] as const
export type PpeCategory = (typeof PPE_CATEGORIES)[number]
export const PPE_ISSUE_REASONS = ['NEW', 'REPLACEMENT', 'LOST'] as const
export type PpeIssueReason = (typeof PPE_ISSUE_REASONS)[number]
export const PPE_ISSUE_KINDS = ['ISSUE', 'VOID'] as const
export type PpeIssueKind = (typeof PPE_ISSUE_KINDS)[number]
export const PPE_RECEIPT_METHODS = ['FLOOR_PIN', 'PAPER'] as const
export type PpeReceiptMethod = (typeof PPE_RECEIPT_METHODS)[number]
export const PPE_ITEM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type PpeItemStatus = (typeof PPE_ITEM_STATUSES)[number]
/** A receipt's state: signed with the PIN, signed on paper (its scan on file), on paper without its scan yet, every line voided. */
export const RECEIPT_STATES = ['SIGNED_PIN', 'SIGNED_PAPER', 'NOT_SIGNED', 'VOIDED'] as const
export type ReceiptState = (typeof RECEIPT_STATES)[number]

export const PPE_LIMITS = {
  code: 40,
  name: 120,
  standard: 120,
  size: 20,
  sizes: 30,
  note: 500,
  quantity: 99,
  lifeMonths: 120,
  /** One unit's cost in minor units (100 000 € at most: a typing guard). */
  unitCost: 10_000_000,
  /** Lines of one receipt. */
  lines: 20,
  reason: 500,
  /** Rows of a list. */
  list: 500,
  /** People a gap list reads at once. */
  people: 2000,
  /** A paper receipt recorded late: at most this many days ago. */
  lateDays: 366,
} as const

/** An item's code: capitals, digits and . _ / - (stored in capitals). */
export const PPE_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/
export const normalPpeCode = (code: string): string => code.trim().toUpperCase()

export const PPE_REFUSALS = {
  CODE_TAKEN: 'Another PPE item already has this code.',
  ARCHIVED: 'This PPE item is archived: restore it first.',
  NOT_ARCHIVED: 'This PPE item is not archived.',
  IN_KIT: 'A role kit still names this item: take it out of the role sheets first.',
  SUPPLIER_NOT_FOUND: 'The supplier is not found.',
  ITEM_NOT_AVAILABLE: 'This item is not in the person’s company catalogue, or it is archived.',
  SIZE_UNKNOWN: 'Pick one of the item’s sizes (a one-size item takes none).',
  NOT_ACTIVE: 'This person no longer works here: PPE is handed only to people who work for the company.',
  NO_EMPLOYEE: 'This floor sign-in is not linked to a person’s record: ask the office to link it first.',
  OTHER_COMPANY: 'This person works for another company than this site’s.',
  SAME_TIME: 'A receipt of this person is already recorded at that time: change the time by a minute.',
  TOO_LATE: `A paper receipt is recorded within ${PPE_LIMITS.lateDays} days of the day it was signed.`,
  IN_FUTURE: 'A receipt is never dated in the future.',
  NOT_AN_ISSUE: 'Only an issue is voided (this row voids another).',
  VOIDED_ALREADY: 'This issue is voided already.',
  PAPER_RECEIPT: 'A paper receipt is its signed scan: the PDF is kept for receipts signed with badge and PIN.',
  NOT_PPE_STEP: 'This leaver step is not "PPE returned".',
  NOT_HELD: 'Name an issue of this person that is not voided.',
} as const
export type PpeRefusalCode = keyof typeof PPE_REFUSALS

// ---- the catalogue ----------------------------------------------------------------------------------------------------------

export interface ItemDraft {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly standard?: string | null | undefined
  readonly sizes?: readonly string[] | undefined
  readonly lifeMonths?: number | null | undefined
  readonly unitCost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** The sizes as stored: trimmed, in the order given, each once (case aside). */
export const cleanSizes = (sizes: readonly string[]): string[] => {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const size of sizes.map((entry) => entry.trim())) {
    if (size === '' || seen.has(size.toLowerCase())) continue
    seen.add(size.toLowerCase())
    kept.push(size)
  }
  return kept
}

/** What a draft item gets wrong, at its fields (`<field>`: the API says `body/<field>`). Only the fields sent are checked. */
export function itemProblems(draft: ItemDraft): Issue[] {
  const L = PPE_LIMITS
  const problems: Issue[] = []
  if (draft.code !== undefined) {
    const code = normalPpeCode(draft.code)
    if (code.length === 0 || code.length > L.code || !PPE_CODE.test(code)) problems.push({ path: 'code', message: `A code of up to ${L.code} letters, digits and . _ / - (no spaces).` })
  }
  if (draft.name !== undefined && (draft.name.trim().length === 0 || draft.name.trim().length > L.name)) problems.push({ path: 'name', message: `A name of 1 to ${L.name} characters.` })
  if (draft.nameI18n) {
    for (const [language, words] of Object.entries(draft.nameI18n)) {
      if (!/^[a-z]{2,3}$/.test(language) || words.trim().length === 0 || words.trim().length > L.name) problems.push({ path: `nameI18n/${language}`, message: `A name of 1 to ${L.name} characters per language.` })
    }
  }
  if (draft.standard !== undefined && draft.standard !== null && (draft.standard.trim().length === 0 || draft.standard.trim().length > L.standard)) problems.push({ path: 'standard', message: `The standard in words, up to ${L.standard} characters ("EN 388:2016").` })
  if (draft.sizes !== undefined) {
    if (draft.sizes.length > L.sizes) problems.push({ path: 'sizes', message: `At most ${L.sizes} sizes.` })
    draft.sizes.forEach((size, index) => {
      if (size.trim().length === 0 || size.trim().length > L.size) problems.push({ path: `sizes/${index}`, message: `A size of 1 to ${L.size} characters.` })
    })
    const trimmed = draft.sizes.map((size) => size.trim().toLowerCase()).filter((size) => size !== '')
    if (new Set(trimmed).size !== trimmed.length) problems.push({ path: 'sizes', message: 'Each size once.' })
  }
  if (draft.lifeMonths !== undefined && draft.lifeMonths !== null && (!Number.isInteger(draft.lifeMonths) || draft.lifeMonths < 1 || draft.lifeMonths > L.lifeMonths)) {
    problems.push({ path: 'lifeMonths', message: `It lasts 1 to ${L.lifeMonths} months (leave it empty: replaced when worn).` })
  }
  if (draft.unitCost !== undefined && draft.unitCost !== null && (!Number.isInteger(draft.unitCost) || draft.unitCost < 0 || draft.unitCost > L.unitCost)) problems.push({ path: 'unitCost', message: 'A unit cost from 0, in cents.' })
  if (draft.note !== undefined && draft.note !== null && draft.note.trim().length > L.note) problems.push({ path: 'note', message: `At most ${L.note} characters.` })
  return problems
}

/** "Start from common items" (the catalogue's empty state): the PPE a leather and garment workshop usually hands out. */
export interface CommonItem {
  readonly code: string
  readonly name: string
  readonly nameI18n: Readonly<Record<'it' | 'en', string>>
  readonly category: PpeCategory
  readonly standard: string
  readonly sizes: readonly string[]
  readonly lifeMonths: number | null
}

export const COMMON_PPE: readonly CommonItem[] = Object.freeze([
  { code: 'GLOVES-CUT', name: 'Cut-resistant gloves', nameI18n: { it: 'Guanti antitaglio', en: 'Cut-resistant gloves' }, category: 'CATEGORY_II', standard: 'EN 388:2016', sizes: ['7', '8', '9', '10'], lifeMonths: 6 },
  { code: 'SHOES-S3', name: 'Safety shoes S3', nameI18n: { it: 'Scarpe antinfortunistiche S3', en: 'Safety shoes S3' }, category: 'CATEGORY_II', standard: 'EN ISO 20345:2022', sizes: ['38', '39', '40', '41', '42', '43', '44', '45', '46'], lifeMonths: 12 },
  { code: 'GLASSES', name: 'Safety glasses', nameI18n: { it: 'Occhiali di protezione', en: 'Safety glasses' }, category: 'CATEGORY_II', standard: 'EN 166:2001', sizes: [], lifeMonths: 12 },
  { code: 'EAR-DEF', name: 'Hearing protection', nameI18n: { it: 'Protezione dell’udito', en: 'Hearing protection' }, category: 'CATEGORY_III', standard: 'EN 352-1:2020', sizes: [], lifeMonths: 24 },
  { code: 'APRON', name: 'Work apron', nameI18n: { it: 'Grembiule da lavoro', en: 'Work apron' }, category: 'CATEGORY_I', standard: 'EN ISO 13688:2013', sizes: ['S', 'M', 'L', 'XL'], lifeMonths: 12 },
  { code: 'MASK-FFP2', name: 'Filtering half mask FFP2', nameI18n: { it: 'Facciale filtrante FFP2', en: 'Filtering half mask FFP2' }, category: 'CATEGORY_III', standard: 'EN 149:2001+A1:2009', sizes: [], lifeMonths: null },
])

// ---- issue lines ------------------------------------------------------------------------------------------------------------

export interface IssueLineDraft {
  readonly ppeItemId: string
  readonly size?: string | null | undefined
  readonly quantity: number
  readonly reason: PpeIssueReason
}

export interface CatalogueItem {
  readonly id: string
  readonly companyId: string
  readonly status: string
  readonly sizes: readonly string[]
}

/** The lines' own problems against the items of the person's company (`lines/<i>/...`): one line per item and size. */
export function lineProblems(lines: readonly IssueLineDraft[], items: ReadonlyMap<string, CatalogueItem>, companyId: string): Issue[] {
  const problems: Issue[] = []
  if (lines.length === 0) problems.push({ path: 'lines', message: 'Hand over at least one item.' })
  if (lines.length > PPE_LIMITS.lines) problems.push({ path: 'lines', message: `At most ${PPE_LIMITS.lines} lines on one receipt.` })
  const seen = new Set<string>()
  lines.forEach((line, index) => {
    const at = `lines/${index}`
    const item = items.get(line.ppeItemId)
    if (!item || item.companyId !== companyId || item.status !== 'ACTIVE') {
      problems.push({ path: `${at}/ppeItemId`, message: PPE_REFUSALS.ITEM_NOT_AVAILABLE })
      return
    }
    const size = line.size?.trim() || null
    if (item.sizes.length === 0 ? size !== null : size === null || !item.sizes.includes(size)) problems.push({ path: `${at}/size`, message: `${PPE_REFUSALS.SIZE_UNKNOWN} (${item.sizes.length > 0 ? item.sizes.join(', ') : 'one size'})` })
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > PPE_LIMITS.quantity) problems.push({ path: `${at}/quantity`, message: `1 to ${PPE_LIMITS.quantity}.` })
    const key = `${line.ppeItemId}|${size ?? ''}`
    if (seen.has(key)) problems.push({ path: at, message: 'One line per item and size.' })
    seen.add(key)
  })
  return problems
}

// ---- receipts ---------------------------------------------------------------------------------------------------------------

/** The rows handed over together: one person, one site, the same instant, the same method. */
export const receiptKeyOf = (row: { readonly siteId: string; readonly employeeId: string; readonly issuedAt: Date; readonly method: string | null }): string =>
  `${row.siteId}|${row.employeeId}|${row.issuedAt.toISOString()}|${row.method ?? ''}`

/** The receipts of ISSUE rows, each named by its smallest row id, rows in their id order, receipts newest first. */
export function receiptsOf<Row extends { readonly id: string; readonly siteId: string; readonly employeeId: string; readonly issuedAt: Date; readonly method: string | null }>(rows: readonly Row[]): { readonly receiptId: string; readonly rows: Row[] }[] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = receiptKeyOf(row)
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { receiptId: sorted[0]!.id, rows: sorted }
    })
    .sort((a, b) => b.rows[0]!.issuedAt.getTime() - a.rows[0]!.issuedAt.getTime() || (a.receiptId < b.receiptId ? -1 : 1))
}

/** A receipt's state: every line voided; signed with the PIN; on paper with its scan on file, or not yet. */
export function receiptState(method: string | null, linesVoided: number, lines: number, scanOnFile: boolean): ReceiptState {
  if (lines > 0 && linesVoided === lines) return 'VOIDED'
  if (method === 'FLOOR_PIN') return 'SIGNED_PIN'
  return scanOnFile ? 'SIGNED_PAPER' : 'NOT_SIGNED'
}

/** What the person signs on the tablet ("I received these items and their instructions"), in the person's language. */
export const RECEIPT_STATEMENT = {
  it: 'Ho ricevuto questi dispositivi di protezione individuale e le relative istruzioni (D.Lgs. 81/2008 art. 77 c.4).',
  en: 'I received these items and their instructions (D.Lgs. 81/2008 art. 77 c.4).',
} as const
export type StatementLanguage = keyof typeof RECEIPT_STATEMENT
export const statementLanguageOf = (locale: string | null | undefined): StatementLanguage => (locale?.toLowerCase().startsWith('it') ? 'it' : 'en')

export interface SignedReceipt {
  readonly language: StatementLanguage
  readonly companyId: string
  readonly siteId: string
  readonly employeeId: string
  /** The person's own floor sign-in, and the tablet. */
  readonly workerId: string
  readonly deviceId: string
  /** ISO instant. */
  readonly issuedAt: string
  /** Each line by its item and the item's code (never its name: a later rename must not change what was signed). */
  readonly lines: readonly { readonly ppeItemId: string; readonly code: string; readonly size: string | null; readonly quantity: number; readonly reason: PpeIssueReason }[]
}

/** The text a FLOOR_PIN receipt binds (its SHA-256 is kept on each row): the statement and exactly what was handed over. */
export const signedReceiptText = (receipt: SignedReceipt): string =>
  JSON.stringify({
    statement: RECEIPT_STATEMENT[receipt.language],
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    employeeId: receipt.employeeId,
    workerId: receipt.workerId,
    deviceId: receipt.deviceId,
    issuedAt: receipt.issuedAt,
    lines: receipt.lines.map((line) => ({ ppeItemId: line.ppeItemId, code: line.code, size: line.size, quantity: line.quantity, reason: line.reason })),
  })

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Which statement a kept SHA-256 binds (the person's language at the tablet), or null when neither reproduces it. */
export function signedLanguageOf(receipt: Omit<SignedReceipt, 'language'>, sha256: string): StatementLanguage | null {
  for (const language of ['it', 'en'] as const) if (sha256Hex(signedReceiptText({ ...receipt, language })) === sha256) return language
  return null
}

/** The tablet's id of a receipt's line (unique per device): the event's id and the line's place. */
export const lineEventId = (eventId: string, index: number): string => `${eventId}.${index + 1}`

/** When a paper receipt may be dated: not in the future, not more than PPE_LIMITS.lateDays ago. */
export function paperDateRefusal(issuedAt: Date, now: Date): 'IN_FUTURE' | 'TOO_LATE' | null {
  if (issuedAt.getTime() > now.getTime() + 60_000) return 'IN_FUTURE'
  if (now.getTime() - issuedAt.getTime() > PPE_LIMITS.lateDays * 86_400_000) return 'TOO_LATE'
  return null
}

// ---- gaps -------------------------------------------------------------------------------------------------------------------

export interface HeldRow {
  readonly id: string
  readonly kind: PpeIssueKind
  readonly ppeItemId: string
  readonly quantity: number
  readonly issuedAt: Date
  readonly voidsId: string | null
}

/** The ISSUE rows no VOID row voids, newest first. */
export function standingIssues<Row extends HeldRow>(rows: readonly Row[]): Row[] {
  const voided = new Set(rows.filter((row) => row.kind === 'VOID' && row.voidsId).map((row) => row.voidsId!))
  return rows.filter((row) => row.kind === 'ISSUE' && !voided.has(row.id)).sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1))
}

/**
 * The units in use whose life is over (the lifeMonths rule for replacements): of one person's standing issues of one item,
 * the newest units up to `keep` (the kit's quantity) are in use; a unit is due when its issue day + lifeMonths has come.
 * A replacement handed over makes the newest units new again, so the old ones fall out of use. No life: never due.
 */
export function unitsDue(standing: readonly Pick<HeldRow, 'quantity' | 'issuedAt'>[], keep: number, lifeMonths: number | null, today: BusinessDate): number {
  if (lifeMonths === null || keep <= 0) return 0
  let left = keep
  let due = 0
  for (const row of [...standing].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())) {
    if (left <= 0) break
    const units = Math.min(left, row.quantity)
    if (addMonths(businessDate(row.issuedAt), lifeMonths) <= today) due += units
    left -= units
  }
  return due
}

export interface KitLine {
  readonly ppeItemId: string
  readonly quantity: number
  readonly whenToWear: string
}

export interface GapLine {
  readonly ppeItemId: string
  /** The kit's units, the units held (standing issues), the units missing, the units in use whose life is over. */
  readonly quantity: number
  readonly held: number
  readonly missing: number
  readonly replace: number
  readonly whenToWear: string
}

/** One person against their role's kit (held = factory-domain rolesheets `kitHeld` of their rows). */
export function gapLines(kit: readonly KitLine[], held: (ppeItemId: string) => number, standing: readonly HeldRow[], lifeOf: (ppeItemId: string) => number | null, today: BusinessDate): GapLine[] {
  return kit.map((line) => {
    const units = held(line.ppeItemId)
    return {
      ppeItemId: line.ppeItemId,
      quantity: line.quantity,
      held: units,
      missing: Math.max(0, line.quantity - units),
      replace: unitsDue(
        standing.filter((row) => row.ppeItemId === line.ppeItemId),
        line.quantity,
        lifeOf(line.ppeItemId),
        today,
      ),
      whenToWear: line.whenToWear,
    }
  })
}

/** The leaver step's link: the issue named is one of the person's, an ISSUE no VOID voids. */
export const heldIssueOf = <Row extends HeldRow & { readonly employeeId: string }>(rows: readonly Row[], employeeId: string, issueId: string): Row | null =>
  standingIssues(rows.filter((row) => row.employeeId === employeeId)).find((row) => row.id === issueId) ?? null
