import type { MaterialDepthView, MaterialWhereUsedView } from '@nexus/factory-domain/product/materials-depth/contracts'
import {
  APPROVALS_WITH_NOTE,
  APPROVAL_NOTE_MAX,
  MATERIAL_APPROVALS,
  PROPERTY_KEYS,
  propertyDecimalProblem,
  type MaterialApproval,
  type PropertyKey,
  type PropertyShape,
} from '@nexus/factory-domain/product/materials-depth/rules'
import type { Notice, WriteProblem } from '../../library/model'

/**
 * Materials in depth on the material record (B-W2b-238; SCR-048 Properties & grades › Properties by kind, Compliance ›
 * Approval status, the Where used tab), pure: the record's depth model (each read failing on its own), what a person may
 * do, the approval and properties drafts with their held reasons (the domain's own rules, as typed), the tones.
 */

export { MATERIAL_APPROVALS }
export type { MaterialApproval, MaterialDepthView, MaterialWhereUsedView, PropertyShape, PropertyKey }

/** A read of one part: idle (its tab is not shown), loading, the answer, or why there is none. */
export type PartRead<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface DepthCan {
  /** product.materials.approve: decide the approval (over the material's company: the API says so otherwise). */
  approve: boolean
  /** product.materials.manage: write the properties of its kind. */
  manage: boolean
  /** product.styles.view: the styles in Where used. */
  styles: boolean
  /** workorders.view: the open work orders in Where used. */
  workOrders: boolean
}

export const depthCan = (permissions: readonly string[]): DepthCan => {
  const held = new Set(permissions)
  return { approve: held.has('product.materials.approve'), manage: held.has('product.materials.manage'), styles: held.has('product.styles.view'), workOrders: held.has('workorders.view') }
}

export interface MaterialDepthModel {
  can: DepthCan
  depth: PartRead<MaterialDepthView>
  whereUsed: PartRead<MaterialWhereUsedView>
  /** Where used: one colour of the material only (null: every colour). */
  colourId: string | null
  busy: boolean
  /** The browser is offline: writes are held (the drafts stay on this page). */
  offline: boolean
  /** The last refused write of these parts (our words first; the API's sentences kept as data). */
  refused: WriteProblem | null
  notice: Notice | null
  /** Design cases: a draft already typed, the block confirmation open, rows selected. */
  approvalDraft?: { approval: MaterialApproval; note: string }
  confirmBlock?: boolean
  propertiesDraft?: Record<string, string>
  selected?: string[]
}

export interface MaterialDepthActions {
  onRetryDepth?: () => void
  onRetryWhereUsed?: () => void
  onColour?: (colourId: string | null) => void
  /** A decision; resolves true when it was saved. */
  onDecide?: (approval: MaterialApproval, note: string | null) => Promise<boolean>
  /** The properties of its kind, all at once (null clears them); resolves true when saved. */
  onSaveProperties?: (properties: Record<string, string | boolean> | null) => Promise<boolean>
  onExport?: (lineIds: string[]) => void
  onDismissNotice?: () => void
}

export const NO_DEPTH: MaterialDepthModel = {
  can: { approve: false, manage: false, styles: false, workOrders: false },
  depth: { status: 'idle' },
  whereUsed: { status: 'idle' },
  colourId: null,
  busy: false,
  offline: false,
  refused: null,
  notice: null,
}

// ---- the approval ------------------------------------------------------------------------------------------------------

export const APPROVAL_TONE: Readonly<Record<MaterialApproval, 'neutral' | 'success' | 'warning' | 'danger'>> = { PENDING: 'neutral', APPROVED: 'success', CONDITIONAL: 'warning', BLOCKED: 'danger' }

export const needsNote = (approval: MaterialApproval): boolean => APPROVALS_WITH_NOTE.includes(approval)

/** The note as the API wants it: trimmed; '' is none. */
export const noteText = (note: string): string | null => (note.trim() === '' ? null : note.trim())

/**
 * Why Apply waits (a key of this catalogue), or null: nothing changed, why missing for a condition or a block, too long or
 * on two lines, offline, a write running.
 */
export function approvalHeld(current: { approval: MaterialApproval; note: string | null }, draft: { approval: MaterialApproval; note: string }, state: { offline: boolean; busy: boolean }): string | null {
  const note = noteText(draft.note)
  if (draft.approval === current.approval && note === current.note) return 'approval.held.unchanged'
  if (needsNote(draft.approval) && note === null) return draft.approval === 'BLOCKED' ? 'approval.held.whyBlocked' : 'approval.held.whyCondition'
  if (note !== null && (note.length > APPROVAL_NOTE_MAX || /[\r\n]/.test(note))) return 'approval.held.noteLong'
  if (state.offline) return 'wait.offline'
  if (state.busy) return 'wait.busy'
  return null
}

// ---- the properties of its kind ----------------------------------------------------------------------------------------

export const keysOf = (shape: PropertyShape): readonly PropertyKey[] => PROPERTY_KEYS[shape]

/** The draft as typed: every key of its kind as text ('' = none; nickel free 'yes' | 'no' | ''). */
export function propertiesDraft(depth: MaterialDepthView, locale: 'it' | 'en'): Record<string, string> {
  const shape = depth.properties.shape
  if (!shape) return {}
  const values = depth.properties.values ?? {}
  return Object.fromEntries(
    keysOf(shape).map((key) => {
      const value = values[key]
      if (typeof value === 'boolean') return [key, value ? 'yes' : 'no']
      if (typeof value !== 'string') return [key, '']
      return [key, key === 'weightGsm' || key === 'widthCm' ? (locale === 'it' ? value.replace('.', ',') : value) : value]
    }),
  )
}

/** A typed decimal as the API wants it ("150,5" → "150.5"). */
export const plainDecimal = (text: string): string => text.trim().replace(/\s/g, '').replace(',', '.')

/** The properties the draft sends (null: none left). */
export function propertiesBodyOf(shape: PropertyShape, draft: Record<string, string>): Record<string, string | boolean> | null {
  const body: Record<string, string | boolean> = {}
  for (const key of keysOf(shape)) {
    const text = (draft[key] ?? '').trim()
    if (text === '') continue
    if (key === 'nickelFree') body[key] = text === 'yes'
    else body[key] = key === 'weightGsm' || key === 'widthCm' ? plainDecimal(text) : text
  }
  return Object.keys(body).length === 0 ? null : body
}

/** The fields whose typed value is not one the API takes (a number above 0 with at most 4 decimals). */
export function propertiesInvalid(shape: PropertyShape, draft: Record<string, string>): PropertyKey[] {
  return keysOf(shape).filter((key) => (key === 'weightGsm' || key === 'widthCm') && (draft[key] ?? '').trim() !== '' && propertyDecimalProblem(plainDecimal(draft[key] ?? '')) !== null)
}

/** How many fields the draft changes. */
export function propertiesChanged(shape: PropertyShape, base: Record<string, string>, draft: Record<string, string>): number {
  return keysOf(shape).filter((key) => (base[key] ?? '').trim() !== (draft[key] ?? '').trim()).length
}
