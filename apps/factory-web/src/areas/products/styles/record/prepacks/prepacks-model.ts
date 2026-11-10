import { PREPACK_LIMITS, ratioText, type PrepackScope, type PrepackStatus } from '@nexus/factory-domain/product/prepacks/rules'
import type { PrepackLineInput, PrepackView, StylePrepacksView } from './api'

/**
 * The Prepacks section's rules, pure (B-W2b-233; SCR-287; design products.styles › Sizes & measurements › Prepacks: Prepack
 * · Ratio per size (1-2-3-2-1) · Pieces per pack): who may change which pack now and why not, what a typed cell does to the
 * lines, the pack dialog's draft (a grid of sizes, per colourway or not) with the same checks as the API in this app's
 * words, and the selection's held reasons. The view and the container use these; the tests hold them.
 */

/** The section's read: like the studio's other parts, it loads and fails alone. */
export type PrepacksPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: StylePrepacksView } | { status: 'error'; problem: string }

/** A size cell's save: saving (sent), waiting (offline, queued on this page), refused (with our words); nothing once saved. */
export interface PrepackMark {
  state: 'saving' | 'waiting' | 'refused'
  value?: string | null
  /** A message key of `products-prepacks` (refused). */
  problem?: string
}

export const markKey = (prepackId: string, size: string): string => `${prepackId}:${size}`

export type PrepacksDialog = { kind: 'prepack'; prepackId: string | null } | { kind: 'status'; ids: string[]; status: PrepackStatus }

export interface PrepacksNotice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

export interface PrepacksModel {
  part: PrepacksPart
  marks: Record<string, PrepackMark>
  selected: string[]
  dialog: PrepacksDialog | null
  offline: boolean
  notice: PrepacksNotice | null
  busy: boolean
  /** Archived packs listed too (off: only the active ones). */
  showArchived: boolean
  /** The person may keep prepacks (product.prepacks.manage; the API checks the company too). */
  canManage: boolean
  /** Design cases: the pack dialog already filled. */
  draft?: PrepackDraft
  focusRow?: number
}

export interface PrepacksActions {
  onRetry?: () => void
  onCell?: (prepack: PrepackView, size: string, value: string | null) => void
  onSelect?: (ids: string[]) => void
  onDialog?: (dialog: PrepacksDialog | null) => void
  onSave?: (prepackId: string | null, draft: PrepackDraft) => Promise<boolean>
  onStatus?: (ids: string[], status: PrepackStatus) => Promise<boolean>
  onShowArchived?: (show: boolean) => void
  onDismissNotice?: () => void
}

export const NO_PREPACKS: PrepacksModel = { part: { status: 'idle' }, marks: {}, selected: [], dialog: null, offline: false, notice: null, busy: false, showArchived: false, canManage: false }

// ---- who may change what now --------------------------------------------------------------------------------------------

/** Why no pack of THIS style can be added now (a message key), or null. A scale's pack does not follow the style's rule. */
export function styleHeld(view: Pick<StylePrepacksView, 'style' | 'styleRefusal'>, canManage: boolean): string | null {
  if (!canManage) return 'prepacks.held.noManage'
  if (view.style.status === 'ARCHIVED') return 'prepacks.held.archivedStyle'
  return view.styleRefusal ? 'prepacks.held.rule' : null
}

/** Why one pack cannot be changed now (a message key), or null. */
export function prepackHeld(prepack: Pick<PrepackView, 'scope' | 'status'>, view: Pick<StylePrepacksView, 'style' | 'styleRefusal'>, canManage: boolean): string | null {
  if (!canManage) return 'prepacks.held.noManage'
  if (prepack.status === 'ARCHIVED') return 'prepacks.held.archived'
  return prepack.scope === 'STYLE' ? styleHeld(view, canManage) : null
}

/** A size cell is typed into only for a pack that can change and has no colourway lines (those change in the pack's dialog). */
export const cellEditable = (prepack: PrepackView, view: StylePrepacksView, canManage: boolean): boolean => prepackHeld(prepack, view, canManage) === null && !prepack.byColourway

/** Pieces of a size, every colourway together (null: none). */
export const quantityOf = (prepack: Pick<PrepackView, 'bySize'>, size: string): number | null => prepack.bySize.find((entry) => entry.size === size)?.quantity ?? null

/** A whole number of pieces from 1 to 10 000 typed (or null for an empty text), or undefined when it is not one. */
export function piecesTyped(value: string | null): number | null | undefined {
  if (value === null || value.trim() === '') return null
  const text = value.trim()
  if (!/^\d{1,5}$/.test(text)) return undefined
  const number = Number(text)
  return number >= 1 && number <= PREPACK_LIMITS.quantity ? number : undefined
}

/** What a typed size cell does to a pack without colourways: the new lines, or why not (a message key). */
export function cellLines(prepack: PrepackView, size: string, value: string | null): { lines: PrepackLineInput[] } | { problem: string } {
  const typed = piecesTyped(value)
  if (typed === undefined) return { problem: 'prepacks.problem.quantity' }
  const others = prepack.lines.filter((line) => line.size !== size).map((line) => ({ size: line.size, colourwayId: line.colourwayId, quantity: line.quantity }))
  const lines = typed === null ? others : [...others, { size, colourwayId: null, quantity: typed }]
  if (lines.length === 0) return { problem: 'prepacks.problem.lastSize' }
  return { lines }
}

/** The packs the list shows: this style's and the scale's, the archived ones only on request. */
export const visibleRows = (view: StylePrepacksView, showArchived: boolean): PrepackView[] => view.prepacks.filter((prepack) => showArchived || prepack.status === 'ACTIVE')

export function prepackCounts(view: StylePrepacksView): { active: number; usable: number; archived: number } {
  return {
    active: view.prepacks.filter((prepack) => prepack.status === 'ACTIVE').length,
    usable: view.prepacks.filter((prepack) => prepack.usable).length,
    archived: view.prepacks.filter((prepack) => prepack.status === 'ARCHIVED').length,
  }
}

/** Why "Archive N" / "Restore N" is held for the selection (a message key), or null. */
export function bulkHeld(view: StylePrepacksView, selected: readonly string[], status: PrepackStatus, canManage: boolean): string | null {
  if (!canManage) return 'prepacks.held.noManage'
  const picked = view.prepacks.filter((prepack) => selected.includes(prepack.id))
  const moving = picked.filter((prepack) => prepack.status !== status)
  if (moving.length === 0) return status === 'ARCHIVED' ? 'prepacks.bulk.noneActive' : 'prepacks.bulk.noneArchived'
  if (moving.some((prepack) => prepack.scope === 'STYLE') && styleHeld(view, canManage)) return styleHeld(view, canManage)
  return null
}

// ---- the pack dialog ----------------------------------------------------------------------------------------------------

/** The dialog's draft: the pieces typed per colourway ('' = any colourway) and size, as text. */
export interface PrepackDraft {
  scope: PrepackScope
  code: string
  name: string
  byColour: boolean
  cells: Record<string, Record<string, string>>
}

export const ANY_COLOUR = ''

export function draftOf(prepack: PrepackView | null): PrepackDraft {
  if (!prepack) return { scope: 'STYLE', code: '', name: '', byColour: false, cells: { [ANY_COLOUR]: {} } }
  const cells: Record<string, Record<string, string>> = {}
  for (const line of prepack.lines) {
    const row = line.colourwayId ?? ANY_COLOUR
    cells[row] = { ...(cells[row] ?? {}), [line.size]: String(line.quantity) }
  }
  return { scope: prepack.scope, code: prepack.code, name: prepack.name, byColour: prepack.byColourway, cells: Object.keys(cells).length > 0 ? cells : { [ANY_COLOUR]: {} } }
}

/** The sizes the draft's lines may name, in order: the style's range, or the scale's sizes for a scale's pack. */
export const draftSizes = (draft: Pick<PrepackDraft, 'scope'>, view: StylePrepacksView): string[] => (draft.scope === 'SCALE' ? view.sizeScale.sizes : view.style.sizes)

/** The rows of the draft's grid: any colourway, or each active colourway of the style (and one a line still names). */
export function draftRows(draft: PrepackDraft, view: StylePrepacksView): { id: string; code: string | null; name: string | null }[] {
  if (!draft.byColour || draft.scope === 'SCALE') return [{ id: ANY_COLOUR, code: null, name: null }]
  return view.colourways.filter((colourway) => colourway.status === 'ACTIVE' || Object.values(draft.cells[colourway.id] ?? {}).some((text) => text.trim() !== '')).map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name }))
}

/** The lines the draft makes (cells left empty are no line; a cell that is not a whole number is left out: `draftProblems` says so). */
export function draftLines(draft: PrepackDraft, view: StylePrepacksView): PrepackLineInput[] {
  const sizes = draftSizes(draft, view)
  return draftRows(draft, view).flatMap((row) =>
    sizes.flatMap((size) => {
      const typed = piecesTyped(draft.cells[row.id]?.[size] ?? null)
      return typeof typed === 'number' ? [{ size, colourwayId: row.id === ANY_COLOUR ? null : row.id, quantity: typed }] : []
    }),
  )
}

/** What is wrong with the draft, per field (message keys); empty: it can be saved. */
export function draftProblems(draft: PrepackDraft, view: StylePrepacksView, prepackId: string | null): Record<string, string> {
  const problems: Record<string, string> = {}
  const code = draft.code.trim()
  if (code === '') problems.code = 'prepacks.problem.codeMissing'
  else if (/\s/.test(code) || code.length > PREPACK_LIMITS.code) problems.code = 'prepacks.problem.codeShape'
  else if (view.prepacks.some((prepack) => prepack.id !== prepackId && prepack.code === code)) problems.code = 'prepacks.problem.codeTaken'
  if (draft.name.trim() === '') problems.name = 'prepacks.problem.nameMissing'
  const sizes = draftSizes(draft, view)
  const rows = draftRows(draft, view)
  const typedBad = rows.some((row) => sizes.some((size) => piecesTyped(draft.cells[row.id]?.[size] ?? null) === undefined))
  if (typedBad) problems.cells = 'prepacks.problem.quantity'
  else if (draftLines(draft, view).length === 0) problems.cells = 'prepacks.problem.noLine'
  return problems
}

/** The draft's pieces per pack and its ratio, as the list will show them. */
export function draftTotals(draft: PrepackDraft, view: StylePrepacksView): { pieces: number; ratio: string } {
  const lines = draftLines(draft, view)
  return { pieces: lines.reduce((sum, line) => sum + line.quantity, 0), ratio: ratioText(lines, draftSizes(draft, view)) }
}

/** What a save sends for an existing pack: only what changed (the lines whole, when any changed). */
export function draftPatch(draft: PrepackDraft, prepack: PrepackView, view: StylePrepacksView): { code?: string; name?: string; lines?: PrepackLineInput[] } {
  const patch: { code?: string; name?: string; lines?: PrepackLineInput[] } = {}
  if (draft.code.trim() !== prepack.code) patch.code = draft.code.trim()
  if (draft.name.trim() !== prepack.name) patch.name = draft.name.trim()
  const lines = draftLines(draft, view)
  const key = (list: readonly PrepackLineInput[]) =>
    [...list]
      .map((line) => `${line.size}|${line.colourwayId ?? ''}|${line.quantity}`)
      .sort()
      .join(',')
  if (key(lines) !== key(prepack.lines)) patch.lines = lines
  return patch
}

/** The colourway lines of a pack in words ("52 BLK ×2 · 52 RED ×1"), for a cell's tooltip and a phone card. */
export const linesText = (prepack: Pick<PrepackView, 'lines'>): string => prepack.lines.map((line) => `${line.size}${line.colourway ? ` ${line.colourway.code}` : ''} ×${line.quantity}`).join(' · ')
