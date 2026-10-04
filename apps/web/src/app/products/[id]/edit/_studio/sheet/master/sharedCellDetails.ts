/**
 * Cell details on the Shared scope (2026-10-04, `docs/shared-cell-details/PLAN.md`): what the ONE window says about a
 * Shared cell. The window, its menu item and its ⋯ item are the shared control's (`useSheetControl`); this file is only
 * "describe this cell" (`CellDetailsSource`).
 *
 * Every sentence comes from the function the cell itself uses, so the window can never disagree with the cell:
 *  - the value, as the cell formats it (option labels, Yes/No, records, protectors, lists, measures, the theme's axes);
 *  - where it comes from: the mark's own sentence (`sharedCellNotes` → `sharedCellSentence`, what the mark draws);
 *  - the family count from the wire's own inheritance (`inheritedFrom` = the family row), told only when it adds up;
 *  - the action: exactly the cell menu's own one (`masterResetOffer` behind `controlColumnFacts`, Owner decision 1).
 *
 * Words: plain and true; never "Master" (the API's name for the Shared record, `requirementLabel`).
 */
import { composeCellTooltip, isEmptyShape, longTextTooltipLine, saveNote, shapeTooltipLine, sheetValidationFor, variationThemeText, variationThemeTooltip, VARIATION_THEME_CHILD_REASON, formatList, formatMeasure, asList, type VariationThemeCell } from '@/design-system/grid'
import { booleanLabel } from '@/design-system/grid/editors/scalarValue'
import { familyRowHoldsValue, isProductRelationshipColumn } from '@nexus/shared/master-sheet'

import { cellDetailsValue, type CellDetailsAction, type CellDetailsContent, type CellDetailsSource } from '../cellDetails'
import { protectorSummary } from '../ImpactProtectorsInput'
import { recordSummary } from '../StructuredAttributeEditor'
import { languageLabel } from '../../scopes'
import { fallbackLanguage } from '../languages'
import { optionLabel } from '../optionLabel'
import { referenceTooltip } from '../referenceLabels'
import { controlColumnFacts, masterResetOffer, MASTER_RESET_EXCLUDED, type ResetOffer, type ResetTarget } from '../sheetReset'
import { cellIsEditable, cellOf, editRefusalReason, holdsFamilyValue, isVariationAxisCell, requiredByOnRow, sharedCellNotes, validationApplies, type AiDraft, type SharedCellFacts } from './columnRules'
import type { SheetColumn, StudioRow } from './types'

/** The Shared window's own words (the shared ones are `CELL_DETAILS_COPY`). */
export const SHARED_CELL_DETAILS_COPY = {
  /** ⋯ on the photo column: it has its own editor (`productMediaColumn`: Enter, F2 or a double-click opens it). */
  photos: 'Photos have their own editor: press Enter on the cell.',
  ownValue: 'This row’s own value',
  noValue: 'No value yet',
  /** The column's label as written ("Size (EU)", "Colore"): lower-casing it broke names ("size (eu)", "own colore"). */
  ownAxis: (label: string) => `This variation’s own ${label}`,
  /** What an edit changes. A Shared content edit reaches every listing that follows it (`master-content.service.ts`). */
  edit: (language: string | null) => `Saved on the Shared product${language ? `, as its ${language} text` : ''}. `
    + 'Listings that follow the Shared product for this field change with it; a listing with its own value keeps it.',
  /** A language-tier edit is saved as REVIEWED text (`content-write.ts`: `state ?? 'reviewed'`; the sheet sends none). */
  editReviews: 'Editing the cell saves your text as reviewed.',
  resetDescription: (formula: boolean) => formula
    ? 'Removes this cell’s formula (its last value is kept), then its own value, so the cell shows the value it inherits again.'
    : 'Removes this cell’s own value, so the cell shows the value it inherits again.',
} as const

/** The photo column's id (`media/productMediaColumn.tsx` `PRODUCT_MEDIA_COLUMN`; `sheetReset.controlColumnFacts` names it too). */
const PHOTOS_COLUMN = 'productMedia'

/** What the window reads beside the row: the family's rows and the cell's live facts (all read when it opens). */
export interface SharedCellDetailsContext {
  /** Every row of the family on the sheet (names the parent; counts the variations). */
  rows: readonly StudioRow[]
  /** The cell's save state (`CellSaveTracker.get`). */
  saveOf?: (rowId: string, colId: string) => Parameters<typeof saveNote>[0]
  /** PES.8's pending AI draft (`useAiDraftLayer().draftFor`). */
  draftFor?: (rowId: string, colId: string) => AiDraft | null
  /** The cell's stored formula, without its `=` (`useCellFormulas().exprFor`). */
  exprFor?: (rowId: string, colId: string) => string | null
  /** The server's reason the formula produced nothing (`useCellFormulas().errorFor`). */
  errorFor?: (rowId: string, colId: string) => string | null
  /** The cell menu's own reset writer (`useSheetControl().reset`). */
  reset: (targets: ResetTarget[]) => void
}

/** Which columns open the window. Progress, Status, Action and the Product band: no. Photos: their own editor. */
export function sharedCellExplains(column: SheetColumn | undefined): boolean | { refusal: string } {
  if (!column) return false
  if (column.key === PHOTOS_COLUMN || column.managedBy === 'productMedia') return { refusal: SHARED_CELL_DETAILS_COPY.photos }
  // `managedBy: 'progress'`: the progress columns and the Shared Status and Action columns (they are not attributes).
  if (column.managedBy === 'progress' || column.key.startsWith('progress:')) return false
  return true
}

/** The cell menu's own reset for this cell, by the menu's own rule (`useSheetControl.offer`): none on a column it skips. */
export function sharedCellResetOffer(row: StudioRow, column: SheetColumn, formula: boolean): ResetOffer | null {
  return controlColumnFacts(column) ? masterResetOffer(row, column, formula) : null
}

/**
 * The family row's count: of its variations on the sheet, how many follow this value and how many hold their own.
 *
 * It is NOT the column menu's "Reset column to inherited (n)": that counts only the rows on screen, and on a language
 * column it also counts the family row's own translation. This count is about the family's value, read per variation:
 *
 *   follows   the variation inherits from the FAMILY row (`inheritedFrom` = the family row) — the wire's word for "shows
 *             the family's value", whatever its mark (an unreviewed machine translation it inherits is still the family's);
 *   own       it holds a value, a pin or a formula of its own;
 *   neither   anything else — a language fallback (German asked, the variation's own Italian text shown: the wire names
 *             the variation itself), or an empty cell that does not inherit. Then there is no count: a count that does
 *             not add up would be false.
 *
 * And no count where the family row's own cell is empty (the variations follow nothing: the wire sends them an empty,
 * non-inherited cell) or is itself a language fallback (no family text in this language to follow). Null too where the
 * variations never take the family's value (an axis, a price, …).
 */
export function familyFollowCount(row: StudioRow, column: SheetColumn, rows: readonly StudioRow[], exprFor?: SharedCellDetailsContext['exprFor']): { variations: number; follow: number; own: number } | null {
  if (!row.isParent || !controlColumnFacts(column) || isProductRelationshipColumn(column.key)) return null
  if (!(column.scope === 'global' || familyRowHoldsValue(column)) || MASTER_RESET_EXCLUDED.has(column.writeField ?? column.key)) return null
  const family = cellOf(row, column.key)
  if (!family || isEmptyShape(column.shape, family.value) || fallbackLanguage(family)) return null
  const variations = rows.filter((r) => r.parentId === row.id)
  if (!variations.length) return null
  let follow = 0, own = 0
  for (const v of variations) {
    const cell = cellOf(v, column.key)
    if (exprFor?.(v.id, column.key)) own++
    else if (!cell || fallbackLanguage(cell)) return null
    else if (cell.inheritedFrom === row.id) follow++
    else if (cell.inherited !== true && (!isEmptyShape(column.shape, cell.value) || cell.pinned === true)) own++
    else return null
  }
  return { variations: variations.length, follow, own }
}

/** "17 of 20 variations follow this value; 3 have their own." */
export function familyFollowWords(count: { variations: number; follow: number; own: number }): string {
  const { variations: n, follow, own } = count
  if (own === 0 && follow === n) return n === 1 ? 'Its one variation follows this value.' : `All ${n} variations follow this value.`
  if (follow === 0 && own === n) return n === 1 ? 'Its one variation has its own value.' : `All ${n} variations have their own value.`
  return `${follow} of ${n} ${n === 1 ? 'variation follows' : 'variations follow'} this value; ${own} ${own === 1 ? 'has its' : 'have their'} own.`
}

/** The value as the Shared cell formats it — the branch order of `buildMasterColumns` — or `''` for an empty value. */
export function sharedCellValueText(column: SheetColumn, value: unknown): string {
  if (column.kind === 'variationTheme' || column.shape === 'axes') {
    const theme = (value ?? null) as VariationThemeCell | null
    return theme && theme.axes.some((a) => a.included) ? variationThemeText(theme) : ''
  }
  if (Array.isArray(column.validation?.recordFields)) return recordSummary(value, column.validation!.recordFields as never)
  if (column.key === 'impactProtectors') return protectorSummary(value)
  if (column.shape === 'list') return formatList(asList(value).map((item) => column.optionLabels?.[item] ?? item))
  if (column.shape === 'measure') return formatMeasure(value)
  if (value == null || value === '') return ''
  if (column.kind === 'boolean') return booleanLabel(value)
  if (typeof value === 'object') return cellDetailsValue(value)
  return optionLabel(value, column.optionLabels)
}

/** The language a cell's text is in, and what state it is in — "German text, written by machine, not reviewed". */
function languageState(row: StudioRow, column: SheetColumn): string | null {
  const cell = cellOf(row, column.key)
  const shown = fallbackLanguage(cell)
  if (shown && cell?.requested) return `There is no ${languageLabel(cell.requested)} text yet.`
  const t = cell?.translation
  if (!t || !cell?.language) return null
  const machine = t.source !== 'manual'
  if (!machine && !t.outdated) return null
  const state = [`${languageLabel(cell.language)} text`, machine ? 'written by machine' : null, machine && !t.reviewedAt ? 'not reviewed' : null, t.outdated ? 'out of date' : null]
  return `${state.filter(Boolean).join(', ')}.${cellIsEditable(column, row) ? ` ${SHARED_CELL_DETAILS_COPY.editReviews}` : ''}`
}

/** The window's content for one Shared cell, or null when this column does not open it. */
export function sharedCellDetails(row: StudioRow, column: SheetColumn, ctx: SharedCellDetailsContext): CellDetailsContent | null {
  if (sharedCellExplains(column) !== true) return null
  const title = `${column.label}: ${row.sku}`
  const cell = cellOf(row, column.key)
  const value = cell?.value
  const save = saveNote(ctx.saveOf?.(row.id, column.key))
  const editable = cellIsEditable(column, row)
  const readOnly = editable ? null : editRefusalReason(column, row)

  /* The variation theme: the structure the family varies by. Its words are the server's (`variationThemeTooltip`). */
  if (column.kind === 'variationTheme' || column.shape === 'axes') {
    const theme = (value ?? null) as VariationThemeCell | null
    return { title, value: sharedCellValueText(column, value) || cellDetailsValue(null),
      notes: composeCellTooltip(save, theme ? variationThemeTooltip(theme) : VARIATION_THEME_CHILD_REASON, readOnly, column.helpText) }
  }
  /* A relationship (role, parent SKU): the catalogue's structure, not a value with a source. */
  if (isProductRelationshipColumn(column.key)) {
    return { title, value: optionLabel(value, column.optionLabels) || cellDetailsValue(null), notes: composeCellTooltip(save, readOnly, column.helpText) }
  }

  const expr = ctx.exprFor?.(row.id, column.key) ?? null
  const refusedReason = ctx.errorFor?.(row.id, column.key) ?? null
  const draft = ctx.draftFor?.(row.id, column.key) ?? null
  const facts: SharedCellFacts = { draft, formula: !!expr, refusedReason }
  const notes = sharedCellNotes(row, column, ctx.rows, facts)
  const applies = validationApplies(column, row)
  const family = holdsFamilyValue(column, row)
  const empty = isEmptyShape(column.shape, value)
  const validation = sheetValidationFor<StudioRow>(column, (r) => validationApplies(column, r)).validate(value ?? null, row, column.key).message

  /* Where it comes from: the mark's sentence, word for word; a cell with no mark says what it is. A column that does not
     apply to this row says why instead (the read-only reason below). */
  const source = notes.source
    || (!applies && !family ? null
      : family ? notes.familyValue
      : empty ? SHARED_CELL_DETAILS_COPY.noValue
      : isVariationAxisCell(row, column) ? SHARED_CELL_DETAILS_COPY.ownAxis(column.label)
      : SHARED_CELL_DETAILS_COPY.ownValue)
  const address = cell?.contentAddress
  const edit = editable && cell?.writeTarget !== 'channelListing'
    ? SHARED_CELL_DETAILS_COPY.edit(address?.tier === 'language' ? languageLabel(address.language) : null) : null
  const count = familyFollowCount(row, column, ctx.rows, ctx.exprFor)
  const required = requiredByOnRow(column, row)

  // The cell menu's own action and nothing else (Owner decision 1): no menu reset, no button.
  const offer = sharedCellResetOffer(row, column, !!expr)
  const action: CellDetailsAction | undefined = offer ? {
    label: offer.label,
    description: SHARED_CELL_DETAILS_COPY.resetDescription(offer.formula),
    run: () => ctx.reset([{ rowId: row.id, colId: column.key, intent: offer.intent, formula: offer.formula }]),
  } : undefined

  return {
    title,
    /* A pending AI draft is what the cell SHOWS (the value underneath is "Now: …" in the notes, as the hover says it). */
    value: draft
      ? (draft.draftValue == null || draft.draftValue === '' ? cellDetailsValue(null) : String(draft.draftValue))
      : sharedCellValueText(column, value) || cellDetailsValue(null),
    notes: composeCellTooltip(
      save,
      validation,
      source,
      ...notes.draft,
      edit,
      count ? familyFollowWords(count) : null,
      required.length ? `Required by ${required.join(', ')}` : null,
      languageState(row, column),
      expr ? `Formula: =${expr}` : null,
      refusedReason,
      readOnly,
      column.kind === 'longtext' ? longTextTooltipLine(value, { maxLength: column.maxLength, maxBytes: column.maxBytes, capFrom: column.capFrom }) : null,
      shapeTooltipLine(column, value),
      referenceTooltip(value, column.optionLabels),
      column.helpText,
    ),
    ...(action ? { action } : {}),
  }
}

/** The Shared scope's `CellDetailsSource` for `useSheetControl({ details })`. Both readers are called when the window opens. */
export function sharedCellDetailsSource(columnOf: (colId: string) => SheetColumn | undefined, context: () => SharedCellDetailsContext): CellDetailsSource<StudioRow> {
  return {
    explains: (colId) => sharedCellExplains(columnOf(colId)),
    describe: (row, colId) => {
      const column = columnOf(colId)
      return column ? sharedCellDetails(row, column, context()) : null
    },
  }
}
