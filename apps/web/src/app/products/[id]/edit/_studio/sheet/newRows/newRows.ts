/**
 * Add rows (plan docs/sheet-ids-sku-rows/PLAN.md, R2–R3; C-add-rows.md D1 A, D2 A) — the pure rules of the EMPTY rows a
 * person adds from the product sheet's footer. The Owner (2026-10-05): "On the bottom left of the footer, I should have
 * the ability to add more empty rows, etc., like we had on the flat file, so that I'm able to add and control all the
 * listings or create new ones directly from the grid (and also for the aliases)."
 *
 *   - An empty row lives in the page only (never in browser storage: the old flat file's stored rows were sent again
 *     later). It is left out of the row count, selection, Action, Publish, export, formulas and search.
 *   - Only its SKU takes input. Typing the SKU CREATES the real thing at once — a Variation row a DRAFT child of the
 *     family (in Nexus only), a "Listing (alias)" row a new listing of the product on this channel · market · account
 *     whose SKU is its channel SKU. A refusal stays on the row in the server's words.
 *   - A paste fills the empty rows in order and says how many SKUs were left over.
 *   - A page reload drops the empty rows; nothing is lost (only the SKU could be typed, and a typed SKU is saved).
 *
 * Pure (no React, no grid runtime), so the node suite reads it. S11's `identitySkuEdit.ts` answers `create` for a row
 * whose `unsaved` is true; that intent comes here.
 */
import { newProductProblems } from '@nexus/shared/product-create'
import { blocking, validateNewVariation } from '../master/addVariation'
import type { FamilyResponse } from '../master/family'

/** What an empty row creates. The Shared scope adds variations; a channel scope variations or listings (aliases). */
export type NewRowKind = 'variation' | 'alias'

/**
 * Where an empty row is:
 *   empty    nothing typed yet (or a refused SKU was cleared);
 *   saving   its SKU is on its way;
 *   refused  the client check or the server said no — `reason` holds the words, the row keeps the SKU so it can be fixed;
 *   unknown  no answer arrived: it may have been created. The row keeps its Idempotency-Key, so typing the SAME SKU again
 *            never creates it twice;
 *   created  the server made it; the row stays until the sheet's next read shows the real one (`landedRows`).
 */
export type NewRowState = 'empty' | 'saving' | 'refused' | 'unknown' | 'created'

export interface NewRow {
  /** `new-row:<uuid>` — the grid row id, and the key slot of its create command (one intent per row). */
  id: string
  kind: NewRowKind
  /** S11's seam (`IdentitySkuRow.unsaved`): this row's first SKU creates. */
  unsaved: true
  /** The SKU as typed (trimmed); '' while empty. */
  sku: string
  state: NewRowState
  /** The refusal or the lost answer, in the words the person reads. */
  reason: string | null
  /** The product (variation) or listing alias (alias) the SKU created. */
  createdId: string | null
}

export const NEW_ROW_ID_PREFIX = 'new-row:'
export const ROWS_TO_ADD_MIN = 1
export const ROWS_TO_ADD_MAX = 50
export const ROWS_TO_ADD_DEFAULT = 1

/** The words of the footer control, the row and its locked cells — one place, so the screen and the tests agree. */
export const NEW_ROWS_WORDS = {
  rowsToAdd: 'Rows to add',
  addRows: 'Add rows',
  variations: 'Variations',
  alias: 'Listing (alias)',
  variationsNote: 'Each SKU you type creates a variation of this family: a draft, in Nexus only.',
  aliasNote: 'Each SKU you type creates another listing of this product here, with that SKU.',
  notSaved: 'Not saved',
  saving: 'Saving…',
  refused: 'Refused',
  unknown: 'Not confirmed',
  created: 'Created',
  typeSku: 'Type the SKU',
  /** Every cell of an empty row but its SKU. */
  locked: 'Type the SKU first; it creates the row.',
  newVariation: 'New variation: type its SKU to create it',
  newAlias: 'New listing: type its SKU to create it',
  creating: 'Creating…',
  createdLoading: 'Created. Loading it into the sheet…',
  savingLocked: 'This row is being created. Wait for the answer.',
  createdLocked: 'This row is created. Its cells open once the sheet shows it.',
  /** A scope change while a create is on its way. */
  wait: 'New rows are being created. Wait for them, then change the view.',
  noPermission: 'You do not have permission to add rows to this product.',
  noParent: 'Only a parent can hold variations. Promote this product first.',
  /** The cell menu's one item on an empty row. */
  removeRow: 'Remove this row',
} as const

/** "Rows to add": a whole number from 1 to 50; anything else falls back into that range. */
export function clampRowsToAdd(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ROWS_TO_ADD_DEFAULT
  return Math.min(ROWS_TO_ADD_MAX, Math.max(ROWS_TO_ADD_MIN, Math.round(n)))
}

export const isNewRowId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(NEW_ROW_ID_PREFIX)

const randomId = (): string => globalThis.crypto.randomUUID()

/** `count` empty rows of one kind (clamped to 1–50). Ids are random: a row is one intent, never derived from its content. */
export function makeNewRows(kind: NewRowKind, count: number, mint: () => string = randomId): NewRow[] {
  return Array.from({ length: clampRowsToAdd(count) }, () => ({
    id: `${NEW_ROW_ID_PREFIX}${mint()}`, kind, unsaved: true as const, sku: '', state: 'empty' as const, reason: null, createdId: null,
  }))
}

/** A row that can take a (new) SKU: empty, refused, or waiting for a lost answer (the same SKU replays it). */
export const takesSku = (row: NewRow): boolean => row.state === 'empty' || row.state === 'refused' || row.state === 'unknown'

/** A row the person may remove: anything but a create on its way. A created row is only hidden; the record stays. */
export const removable = (row: NewRow): boolean => row.state !== 'saving'

export interface NewRowSkuContext {
  kind: NewRowKind
  /** The family the sheet shows: a variation's SKU is checked against it (`validateNewVariation`, reused). */
  family: FamilyResponse | null
  /** Every SKU on screen: the family's products and the listings' own SKUs. */
  takenSkus: Iterable<string>
  /** The SKUs typed into the OTHER empty rows (on their way, or created). */
  otherNewSkus: Iterable<string>
}

const findSame = (sku: string, list: Iterable<string>): string | null => {
  const key = sku.toLowerCase()
  for (const other of list) if (typeof other === 'string' && other.trim().toLowerCase() === key) return other.trim()
  return null
}

/**
 * Why this SKU cannot create the row's record, or null. The client checks only what the server checks too, so a typo is
 * named at once: the product-SKU rule (`@nexus/shared/product-create`, reused), the add-variation check
 * (`validateNewVariation`, reused: a SKU already in this family), a SKU already on this sheet, a SKU typed into another
 * empty row. The server decides the rest (another product of this business, another listing on this account) and its
 * sentence is the row's.
 */
export function newRowSkuProblem(raw: string, ctx: NewRowSkuContext): string | null {
  const sku = raw.trim()
  if (!sku) return null
  const rule = newProductProblems({ sku }).sku
  if (rule) return rule
  if (ctx.kind === 'variation') {
    const family = blocking(validateNewVariation({ sku, name: sku, axisValues: {} }, ctx.family)).find((p) => p.field === 'sku')
    if (family) return `${family.message}.`
  }
  const onSheet = findSame(sku, ctx.takenSkus)
  if (onSheet) return `${onSheet} is already on this sheet. Choose another SKU.`
  const typed = findSame(sku, ctx.otherNewSkus)
  if (typed) return `${typed} is already typed into another new row.`
  return null
}

/** The SKUs of a paste: the first column of each line, trimmed; blank lines are skipped. */
export function pastedSkus(data: ReadonlyArray<ReadonlyArray<string> | string>): { skus: string[]; extraColumns: boolean } {
  let extraColumns = false
  const skus: string[] = []
  for (const line of data) {
    const cells = typeof line === 'string' ? [line] : line
    if (cells.length > 1 && cells.slice(1).some((c) => String(c ?? '').trim())) extraColumns = true
    const sku = String(cells[0] ?? '').trim()
    if (sku) skus.push(sku)
  }
  return { skus, extraColumns }
}

export interface PastePlan {
  /** Row → SKU, in the rows' order from the row the paste starts on. */
  fill: Array<{ rowId: string; sku: string }>
  /** SKUs with no empty row left to take them. */
  leftOver: number
}

/**
 * A paste fills the empty rows in order, starting on the row it was pasted into; rows on their way or created are
 * skipped. What does not fit is counted, never dropped silently.
 */
export function planPaste(rows: readonly NewRow[], startRowId: string, skus: readonly string[]): PastePlan {
  const start = rows.findIndex((row) => row.id === startRowId)
  const open = start < 0 ? [] : rows.slice(start).filter(takesSku)
  const fill = open.slice(0, skus.length).map((row, i) => ({ rowId: row.id, sku: skus[i] }))
  return { fill, leftOver: Math.max(0, skus.length - fill.length) }
}

/** The one sentence a paste into empty rows says; null when it filled them and there was nothing else to say. */
export function pasteSentence(plan: PastePlan, extraColumns: boolean): string | null {
  const parts: string[] = []
  if (plan.leftOver > 0) {
    const n = plan.leftOver
    parts.push(`${n} ${n === 1 ? 'SKU was' : 'SKUs were'} left over: add ${n} more ${n === 1 ? 'row' : 'rows'}, then paste ${n === 1 ? 'it' : 'them'} again.`)
  }
  if (extraColumns && plan.fill.length > 0) parts.push('Only the SKUs were used. The other cells open once each row is created.')
  return parts.length ? parts.join(' ') : null
}

/** What the identity cell of an empty row says under its SKU. */
export function newRowLine(row: NewRow): string {
  if (row.state === 'refused' || row.state === 'unknown') return row.reason ?? NEW_ROWS_WORDS.refused
  if (row.state === 'saving') return NEW_ROWS_WORDS.creating
  if (row.state === 'created') return NEW_ROWS_WORDS.createdLoading
  return row.kind === 'alias' ? NEW_ROWS_WORDS.newAlias : NEW_ROWS_WORDS.newVariation
}

/** The pill an empty row wears, by state. */
export function newRowPill(row: NewRow): { label: string; tone: 'warning' | 'info' | 'danger' | 'success' } {
  switch (row.state) {
    case 'saving': return { label: NEW_ROWS_WORDS.saving, tone: 'info' }
    case 'refused': return { label: NEW_ROWS_WORDS.refused, tone: 'danger' }
    case 'unknown': return { label: NEW_ROWS_WORDS.unknown, tone: 'warning' }
    case 'created': return { label: NEW_ROWS_WORDS.created, tone: 'success' }
    default: return { label: NEW_ROWS_WORDS.notSaved, tone: 'warning' }
  }
}

/**
 * The sheet read the server answered after a create: rows whose record it now shows are done (the real row takes their
 * place). `presentIds`: the product ids (variations) and listing alias ids (aliases) on the sheet now.
 */
export function landedRows(rows: readonly NewRow[], presentIds: ReadonlySet<string>): NewRow[] {
  const kept = rows.filter((row) => !(row.state === 'created' && row.createdId && presentIds.has(row.createdId)))
  return kept.length === rows.length ? rows as NewRow[] : kept
}

/**
 * An empty row's cells (`row` = the empty row, or null/undefined for a real row): only its SKU takes input, and only while
 * the row can take one; every other cell says why it is locked.
 */
export function newRowCellEditable(row: NewRow | null | undefined, isSkuColumn: boolean): { editable: boolean; reason: string | null } {
  if (!row) return { editable: true, reason: null }
  if (!isSkuColumn) return { editable: false, reason: NEW_ROWS_WORDS.locked }
  if (row.state === 'saving') return { editable: false, reason: NEW_ROWS_WORDS.savingLocked }
  if (row.state === 'created') return { editable: false, reason: NEW_ROWS_WORDS.createdLocked }
  return { editable: true, reason: null }
}
