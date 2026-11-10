import { PLACEMENT_LIMITS, POCKET_STANDARD, PROTECTOR_LEVELS, type ProtectorLevel, type ProtectorPocket } from '@nexus/factory-domain/product/protectors/rules'
import type { PlacementFinding, PlacementPatch, PlacementView, ProtectorChoice, ProtectorPlacementView } from './api'

/**
 * The Protector placement section's rules, pure (B-W2b-233; SCR-287; design products.styles › Sizes & measurements ›
 * Protector placement: pocket · protector part, standard and level per size · pocket position; revision-bound): why the
 * list cannot be changed now, a cell's change checked before it goes (the same rules as the API, in this app's words),
 * what to look at said from the API's codes and figures (never its English), the sizes read as people read them, the
 * placement dialog's draft and the order's moves. The view and the container use these; the tests hold them.
 */

export type ProtectorsPart = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: ProtectorPlacementView } | { status: 'error'; problem: string }

export const PLACEMENT_CELLS = ['pocket', 'protectorItemId', 'standard', 'level', 'sizes', 'positionNote'] as const
export type PlacementCell = (typeof PLACEMENT_CELLS)[number]

export interface PlacementMark {
  state: 'saving' | 'waiting' | 'refused'
  value?: unknown
  /** A message key of `products-prepacks` (refused). */
  problem?: string
}

export const markKey = (placementId: string, cell: PlacementCell): string => `${placementId}:${cell}`

export type ProtectorsDialog = { kind: 'placement'; placementId: string | null } | { kind: 'sizes'; placementId: string } | { kind: 'remove'; ids: string[] }

export interface ProtectorsModel {
  part: ProtectorsPart
  marks: Record<string, PlacementMark>
  selected: string[]
  dialog: ProtectorsDialog | null
  offline: boolean
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  busy: boolean
  /** Design cases: the placement dialog already filled. */
  draft?: PlacementDraft
  focusRow?: number
}

export interface ProtectorsActions {
  onRetry?: () => void
  onCell?: (placement: PlacementView, cell: PlacementCell, value: unknown) => void
  onSelect?: (ids: string[]) => void
  onDialog?: (dialog: ProtectorsDialog | null) => void
  onSave?: (placementId: string | null, draft: PlacementDraft) => Promise<boolean>
  onRemove?: (ids: string[]) => Promise<boolean>
  onMove?: (placementId: string, delta: -1 | 1) => void
  onDismissNotice?: () => void
}

export const NO_PROTECTORS: ProtectorsModel = { part: { status: 'idle' }, marks: {}, selected: [], dialog: null, offline: false, notice: null, busy: false }

// ---- who may change the list now ------------------------------------------------------------------------------------------

/** Why the list is read only now (a message key), or null: no edit right, a frozen revision, an archived style, the style's rule. */
export function protectorsHeld(view: Pick<ProtectorPlacementView, 'editable' | 'revision' | 'style'>, canManage: boolean): string | null {
  if (!canManage) return 'protectors.held.noManage'
  if (view.revision.status !== 'DRAFT') return 'protectors.held.frozen'
  if (view.style.status === 'ARCHIVED') return 'protectors.held.archived'
  return view.editable ? null : 'protectors.held.rule'
}

// ---- words ----------------------------------------------------------------------------------------------------------------

/**
 * The sizes as people read them: none = every size; a run of the range = "52–54"; otherwise the codes ("50, 54"). A code the
 * range no longer has stays named at the end.
 */
export function sizesText(sizes: readonly string[], range: readonly string[]): { key: string; params?: Record<string, string> } {
  if (sizes.length === 0) return { key: 'protectors.sizes.all' }
  const inRange = range.filter((size) => sizes.includes(size))
  const outside = sizes.filter((size) => !range.includes(size))
  const first = range.indexOf(inRange[0] ?? '')
  const run = inRange.length >= 3 && outside.length === 0 && inRange.every((size, index) => range[first + index] === size)
  if (run) return { key: 'protectors.sizes.run', params: { from: inRange[0]!, to: inRange[inRange.length - 1]! } }
  return { key: 'protectors.sizes.some', params: { sizes: [...inRange, ...outside].join(', ') } }
}

export const choiceLabel = (choice: Pick<ProtectorChoice, 'code' | 'name'>): string => `${choice.code} · ${choice.name}`

/**
 * A finding in this app's words: the message key and its parameters from the API's code and figures. The pocket comes as
 * a key of its own (`pocket`, translated by the view), the sizes as written.
 */
export function findingWords(finding: PlacementFinding): { key: string; params: Record<string, string>; pocket: ProtectorPocket | null } {
  const params = { ...finding.params, sizes: finding.sizes.join(', ') }
  const pocket = (finding.params.pocket as ProtectorPocket | undefined) ?? null
  const key = finding.code === 'BOM_NOT_PLACED' && finding.params.all === 'yes' ? 'protectors.finding.BOM_NOT_PLACED_ALL' : `protectors.finding.${finding.code}`
  return { key, params, pocket }
}

// ---- checks before a save -------------------------------------------------------------------------------------------------

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** A cell's change as a write, or why not (a message key). */
export function cellPatch(placement: PlacementView, cell: PlacementCell, value: unknown, view: Pick<ProtectorPlacementView, 'style' | 'placements' | 'choices'>): { patch: PlacementPatch } | { problem: string } {
  const range = view.style.sizes
  switch (cell) {
    case 'pocket': {
      const pocket = String(value) as ProtectorPocket
      if (!(pocket in POCKET_STANDARD)) return { problem: 'protectors.problem.pocket' }
      if (overlapWith(view.placements, { id: placement.id, pocket, sizes: placement.sizes }, range)) return { problem: 'protectors.problem.overlap' }
      return { patch: { pocket } }
    }
    case 'protectorItemId': {
      const id = String(value)
      if (!view.choices.some((choice) => choice.id === id)) return { problem: 'protectors.problem.protector' }
      return { patch: { protectorItemId: id } }
    }
    case 'standard': {
      const standard = String(value ?? '').trim()
      if (standard === '' || standard.length > PLACEMENT_LIMITS.standard || CONTROL.test(standard)) return { problem: 'protectors.problem.standard' }
      return { patch: { standard } }
    }
    case 'level': {
      const level = String(value) as ProtectorLevel
      if (!(PROTECTOR_LEVELS as readonly string[]).includes(level)) return { problem: 'protectors.problem.level' }
      return { patch: { level } }
    }
    case 'sizes': {
      const sizes = (Array.isArray(value) ? value.map(String) : []).filter((size, index, all) => all.indexOf(size) === index)
      if (sizes.some((size) => !range.includes(size))) return { problem: 'protectors.problem.size' }
      const ordered = range.filter((size) => sizes.includes(size))
      if (overlapWith(view.placements, { id: placement.id, pocket: placement.pocket, sizes: ordered }, range)) return { problem: 'protectors.problem.overlap' }
      return { patch: { sizes: ordered } }
    }
    case 'positionNote': {
      const text = String(value ?? '').trim()
      if (text.length > PLACEMENT_LIMITS.positionNote || CONTROL.test(text)) return { problem: 'protectors.problem.note' }
      return { patch: { positionNote: text === '' ? null : text } }
    }
  }
}

const covered = (sizes: readonly string[], range: readonly string[]): string[] => (sizes.length === 0 ? [...range] : range.filter((size) => sizes.includes(size)))

/** Another placement of the same pocket on one of these sizes (the API's refusal, said before the write). */
export function overlapWith(placements: readonly Pick<PlacementView, 'id' | 'pocket' | 'sizes' | 'seq'>[], next: { id: string | null; pocket: ProtectorPocket; sizes: readonly string[] }, range: readonly string[]): Pick<PlacementView, 'id' | 'seq'> | null {
  const mine = covered(next.sizes, range)
  return placements.find((other) => other.id !== next.id && other.pocket === next.pocket && covered(other.sizes, range).some((size) => mine.includes(size))) ?? null
}

/** The value a cell shows: the one typed while it saves or waits, else the stored one. */
export function shownValue(placement: PlacementView, cell: PlacementCell, marks: Record<string, PlacementMark>): unknown {
  const mark = marks[markKey(placement.id, cell)]
  if (mark && mark.state !== 'refused' && mark.value !== undefined) return mark.value
  if (cell === 'protectorItemId') return placement.protector.id
  return placement[cell]
}

// ---- the placement dialog ---------------------------------------------------------------------------------------------

export interface PlacementDraft {
  pocket: ProtectorPocket
  protectorItemId: string
  standard: string
  level: ProtectorLevel
  sizes: string[]
  positionNote: string
}

export function draftOf(placement: PlacementView | null, view: Pick<ProtectorPlacementView, 'choices'>): PlacementDraft {
  if (placement) return { pocket: placement.pocket, protectorItemId: placement.protector.id, standard: placement.standard, level: placement.level, sizes: [...placement.sizes], positionNote: placement.positionNote ?? '' }
  const first = view.choices.find((choice) => choice.inBom) ?? view.choices[0]
  return withProtector({ pocket: 'SHOULDER', protectorItemId: '', standard: POCKET_STANDARD.SHOULDER, level: '1', sizes: [], positionNote: '' }, first ?? null)
}

/** A protector picked: its own standard and level fill the fields (else the pocket's standard, level 1). */
export function withProtector(draft: PlacementDraft, choice: Pick<ProtectorChoice, 'id' | 'standard' | 'level'> | null): PlacementDraft {
  if (!choice) return { ...draft, protectorItemId: '' }
  const level = (PROTECTOR_LEVELS as readonly string[]).includes(choice.level ?? '') ? (choice.level as ProtectorLevel) : draft.level
  return { ...draft, protectorItemId: choice.id, standard: choice.standard ?? POCKET_STANDARD[draft.pocket], level }
}

/** What is wrong with the draft, per field (message keys); empty: it can be saved. */
export function draftProblems(draft: PlacementDraft, view: Pick<ProtectorPlacementView, 'style' | 'placements' | 'choices'>, placementId: string | null, only: boolean): Record<string, string> {
  const problems: Record<string, string> = {}
  if (!view.choices.some((choice) => choice.id === draft.protectorItemId)) problems.protectorItemId = 'protectors.problem.protector'
  const standard = draft.standard.trim()
  if (standard === '' || standard.length > PLACEMENT_LIMITS.standard || CONTROL.test(standard)) problems.standard = 'protectors.problem.standard'
  if (draft.positionNote.length > PLACEMENT_LIMITS.positionNote || CONTROL.test(draft.positionNote)) problems.positionNote = 'protectors.problem.note'
  if (only && draft.sizes.length === 0) problems.sizes = 'protectors.sizes.pickOne'
  else if (overlapWith(view.placements, { id: placementId, pocket: draft.pocket, sizes: only ? draft.sizes : [] }, view.style.sizes)) problems.sizes = 'protectors.problem.overlap'
  return problems
}

/** What a save sends: every field for a new placement; only what changed for one that exists. */
export function draftPatch(draft: PlacementDraft, placement: PlacementView | null, only: boolean): PlacementPatch & { pocket: ProtectorPocket; protectorItemId: string } {
  const sizes = only ? draft.sizes : []
  const full = { pocket: draft.pocket, protectorItemId: draft.protectorItemId, standard: draft.standard.trim(), level: draft.level, sizes, positionNote: draft.positionNote.trim() === '' ? null : draft.positionNote.trim() }
  if (!placement) return full
  const patch: PlacementPatch = {}
  if (full.pocket !== placement.pocket) patch.pocket = full.pocket
  if (full.protectorItemId !== placement.protector.id) patch.protectorItemId = full.protectorItemId
  if (full.standard !== placement.standard) patch.standard = full.standard
  if (full.level !== placement.level) patch.level = full.level
  if (sizes.join(',') !== placement.sizes.join(',')) patch.sizes = sizes
  if (full.positionNote !== placement.positionNote) patch.positionNote = full.positionNote
  return patch as PlacementPatch & { pocket: ProtectorPocket; protectorItemId: string }
}

/** The order after moving one placement up or down, or null at an end. */
export function movedOrder(placements: readonly Pick<PlacementView, 'id' | 'seq'>[], id: string, delta: -1 | 1): string[] | null {
  const sorted = [...placements].sort((a, b) => a.seq - b.seq)
  const index = sorted.findIndex((placement) => placement.id === id)
  const target = index + delta
  if (index < 0 || target < 0 || target >= sorted.length) return null
  const ids = sorted.map((placement) => placement.id)
  ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
  return ids
}
