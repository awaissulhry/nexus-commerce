import type { PatternFileFormat, PatternFileKind } from '@nexus/factory-domain/product/images/rules'
import { inRangeOrder, noteProblem, PATTERN_NOTE_MAX } from '@nexus/factory-domain/product/images/rules'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { PatternTypeError, type PatternFilesView, type PatternFileView } from './api'

/**
 * Files & patterns › Pattern files (B-W2b-236; PRD-218; design products.styles rec:Style style.files.files "Pattern files per
 * revision and size range (Lectra, Gerber, DXF-AAMA; W2b)"), pure: the section's state, who may do what and why not, the
 * sizes in words, the fields a dialog sends and the words of a refusal.
 */

export type PatternsPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: PatternFilesView } | { status: 'error'; problem: string }

export type PatternsDialog =
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'version'; id: string }
  | { kind: 'versions'; id: string }
  | { kind: 'remove'; ids: string[] }

export interface PatternsNotice {
  key: string
  tone: 'success' | 'info' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

export interface PatternsModel {
  part: PatternsPart
  /** product.bom.manage AND files.upload. */
  canManage: boolean
  /** product.bom.manage: change and remove rows (no upload). */
  canEdit: boolean
  dialog: PatternsDialog | null
  selected: string[]
  busy: boolean
  /** A file being sent from this device. */
  sending: { state: 'idle' | 'sending' | 'failed'; problem: string | null }
  notice: PatternsNotice | null
  offline?: boolean
}

export const NO_PATTERNS: PatternsModel = { part: { status: 'idle' }, canManage: false, canEdit: false, dialog: null, selected: [], busy: false, sending: { state: 'idle', problem: null }, notice: null }

export interface PatternFields {
  kind: PatternFileKind
  format: PatternFileFormat | null
  sizes: string[]
  note: string | null
}

export interface PatternsActions {
  onRetry?: () => void
  onDialog?: (dialog: PatternsDialog | null) => void
  onSelect?: (ids: string[]) => void
  onAdd?: (file: File, fields: PatternFields) => void
  onSave?: (id: string, fields: Partial<PatternFields>) => void
  onNewVersion?: (id: string, file: File) => void
  onRemove?: (ids: string[]) => void
  onDownload?: (id: string, fileId?: string) => void
  onDismissNotice?: () => void
}

/** Why the section changes nothing now (a `products-gallery` key), or null. `upload`: also sending a file. */
export function patternsHeld(model: Pick<PatternsModel, 'canManage' | 'canEdit' | 'offline'>, view: PatternFilesView, what: 'upload' | 'edit'): string | null {
  if (!model.canEdit) return 'patterns.held.noRight'
  if (what === 'upload' && !model.canManage) return 'patterns.held.noUpload'
  if (view.style.status === 'ARCHIVED') return 'patterns.held.archived'
  if (view.refusal) return 'patterns.held.rule'
  if (model.offline) return 'patterns.held.offline'
  return null
}

/** Why a row cannot be changed or removed (frozen with its revision), else the section's hold, else null. */
export function rowHeld(model: Pick<PatternsModel, 'canManage' | 'canEdit' | 'offline'>, view: PatternFilesView, row: PatternFileView): string | null {
  return row.frozen ? 'patterns.frozenRow' : patternsHeld(model, view, 'edit')
}

/** The kinds a new file may be on this revision (a released revision takes markers and other files only). */
export const kindsOpen = (view: PatternFilesView): PatternFileKind[] => (Object.keys(view.kinds) as PatternFileKind[]).filter((kind) => view.kinds[kind] === null)

/** The sizes in words: every size, or the list in the range's order. */
export const sizesWords = (row: Pick<PatternFileView, 'sizes'>, range: readonly string[]): { key: string; params?: Record<string, string> } =>
  row.sizes.length === 0 ? { key: 'patterns.sizes.all' } : { key: 'patterns.sizes.some', params: { sizes: inRangeOrder(row.sizes, range).join(', ') } }

export const rowOf = (view: PatternFilesView, id: string | null | undefined): PatternFileView | null => view.files.find((row) => row.id === id) ?? null

/** A note typed: trimmed, empty → none; the key of its problem. */
export function noteToSend(typed: string): { note: string | null; problem: string | null } {
  const note = typed.trim() === '' ? null : typed.trim()
  return { note, problem: noteProblem(note) ? 'patterns.field.noteLong' : null }
}
export { PATTERN_NOTE_MAX }

export const FORMAT_CHOICES: readonly (PatternFileFormat | '')[] = ['DXF_AAMA', 'LECTRA', 'GERBER', 'PDF', '']

/** A refused write in the section's own words. */
export function patternsProblem(error: unknown): string {
  if (error instanceof PatternTypeError) return 'patterns.add.wrongType'
  if (!isApiError(error)) return 'patterns.problem.write'
  if (error.kind === 'conflict') return error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version')) ? 'patterns.problem.moved' : 'patterns.problem.state'
  if (error.kind === 'forbidden') return 'patterns.held.noRight'
  if (error.kind === 'invalid') return 'patterns.problem.invalid'
  if (error.kind === 'not_found') return 'patterns.problem.gone'
  if (error.kind === 'unavailable' || error.code === 'network') return 'patterns.held.offline'
  return 'patterns.problem.write'
}

export function patternsReadProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'patterns.problem.readForbidden'
  if (isApiError(error) && (error.kind === 'unavailable' || error.code === 'network')) return 'patterns.held.offline'
  return 'patterns.problem.read'
}
