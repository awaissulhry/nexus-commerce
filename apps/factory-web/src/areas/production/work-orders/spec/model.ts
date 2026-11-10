import type { VersionsCompareView } from '../../../products/changes/api'
import { CHANGE_LIMITS } from '@nexus/factory-domain/product/changes/rules'
import type { ChangePriority } from '../../../products/changes/model'
import type { WorkOrder } from '../../_shared/api'
import type { WorkOrderChangesView, WorkOrderSpecView } from './api'

/**
 * The work order's frozen spec against the master (design production.workorders: wo-frozen "Compare with the current master
 * → Spec differences", wo-sizegrid "Frozen at release: a change needs a change request", pop:wo-diff Spec differences,
 * pop:wo-change Change request; PRD-194, PRD-195, MES-006), pure: who may do what, whether a newer spec is due and what the
 * office decided, the compare's pair, the request's draft and why "Ask for approval" waits. Words are keys of
 * products-versions (`wo.*`), a refusal of products-changes.
 */

export const SPEC_NS = 'products-versions'

export interface SpecCan {
  /** The line-by-line compare (product.bom.view). */
  compare: boolean
  /** The work order's change requests (product.changes.view). */
  changes: boolean
  /** Raise one (product.changes.request). */
  request: boolean
}

export function specCan(permissions: readonly string[]): SpecCan {
  const held = new Set(permissions)
  return { compare: held.has('product.bom.view'), changes: held.has('product.changes.view'), request: held.has('product.changes.request') }
}

export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** A phrase of products-versions (or, `changes`, of products-changes: a refusal or a read's problem). */
export interface SpecPhrase {
  key: string
  params?: Record<string, string | number>
  changes?: boolean
}

export type SpecDialog = { kind: 'diff' } | { kind: 'change' }

export interface ChangeDraft {
  title: string
  reason: string
  priority: ChangePriority
}

export const EMPTY_DRAFT: ChangeDraft = { title: '', reason: '', priority: 'NORMAL' }

export interface SpecModel {
  can: SpecCan
  /** The work order's spec against the master (read once it is released; idle for a draft). */
  spec: Read<WorkOrderSpecView>
  dialog: SpecDialog | null
  /** Spec differences: the compare of the work order's revision against the released one (null: not read here). */
  compare: Read<VersionsCompareView> | null
  /** Change request: what is made and the requests already about it (null: not in the role). */
  changes: Read<WorkOrderChangesView> | null
  draft: ChangeDraft
  busy: boolean
  problem: SpecPhrase | null
  /** The request just raised (its record opens from the pop-up). */
  raised: { id: string; number: string | null } | null
}

export interface SpecActions {
  onOpen?: (dialog: SpecDialog) => void
  onClose?: () => void
  onDraft?: (patch: Partial<ChangeDraft>) => void
  onRaise?: () => void
  onRetry?: (part: 'spec' | 'compare' | 'changes') => void
}

/** The work order's spec is frozen (released and later): a change is a change request, a different spec a new work order. */
export const isFrozen = (workOrder: Pick<WorkOrder, 'status'>): boolean => workOrder.status !== 'DRAFT'

/** A banner is due (a newer released revision, or the work order's revision withdrawn), in words with what was decided. */
export function newerPhrase(spec: WorkOrderSpecView): SpecPhrase | null {
  const { newer, revision } = spec
  if (!newer.banner) return null
  if (newer.state === 'WITHDRAWN') return { key: 'wo.newer.WITHDRAWN', params: { revision: revision?.revision ?? '—' } }
  return { key: 'wo.newer.NEWER_RELEASED', params: { revision: revision?.revision ?? '—', newer: newer.newer?.revision ?? '—', day: newer.newer?.releasedOn ?? '—' } }
}

/** What the office decided for this work order in a change order, or that it has not decided yet. */
export function decisionPhrase(spec: WorkOrderSpecView): SpecPhrase | null {
  if (!spec.newer.banner) return null
  if (!spec.newer.decision) return { key: 'wo.decision.none', params: { revision: spec.revision?.revision ?? '—' } }
  return { key: `wo.decision.${spec.newer.decision.disposition}`, params: { order: spec.newer.decision.changeOrder, revision: spec.revision?.revision ?? '—', newer: spec.newer.newer?.revision ?? '—' } }
}

/** "BOM: 1 changed · Routing and minutes: 2 added" in this app's words (section names of products-changes). */
export function differsCount(spec: Pick<WorkOrderSpecView, 'differs'>): number {
  return spec.differs.reduce((sum, entry) => sum + entry.added + entry.removed + entry.changed, 0)
}

/** The compare's pair: the work order's revision against the style's released one (null: nothing to compare against). */
export function comparePair(spec: WorkOrderSpecView): { styleId: string; from: string; to: string } | null {
  if (!spec.revision || !spec.released) return null
  return { styleId: spec.workOrder.styleId, from: spec.revision.id, to: spec.released.id }
}

/** Why "Compare with the current master" waits (a key), or null. */
export function compareHeld(spec: Read<WorkOrderSpecView>): string | null {
  if (spec.status === 'loading' || spec.status === 'idle') return 'wo.held.reading'
  if (spec.status === 'error') return 'wo.held.unread'
  if (!spec.value.revision) return 'wo.held.noRevision'
  if (!spec.value.released) return 'wo.held.noReleased'
  return null
}

/** The line-by-line compare needs the BOM's right; without it the pop-up says what differs by part only. */
export const sameSpec = (spec: WorkOrderSpecView): boolean => !!spec.revision && !!spec.released && spec.revision.id === spec.released.id

/** Why "Change request…" (⋯ and the banners) waits, or null. */
export function requestHeld(can: SpecCan): string | null {
  return can.request ? null : 'wo.held.noRequest'
}

/** The API's limits (B-W2b-226's CHANGE_LIMITS). */
export const DRAFT_LIMITS = { title: CHANGE_LIMITS.title, reason: CHANGE_LIMITS.reason } as const

/** Why "Ask for approval" waits, or null. */
export function raiseHeld(draft: ChangeDraft, can: SpecCan, busy: boolean): string | null {
  if (!can.request) return 'wo.held.noRequest'
  if (draft.title.trim() === '') return 'wo.held.title'
  if (draft.reason.trim() === '') return 'wo.held.reason'
  if (draft.title.trim().length > DRAFT_LIMITS.title || draft.reason.trim().length > DRAFT_LIMITS.reason) return 'wo.held.long'
  if (busy) return 'wo.held.busy'
  return null
}

/** The request raised from the work order: OFFICE, the work order and its frozen revision, the style. */
export function requestBody(draft: ChangeDraft, workOrder: Pick<WorkOrder, 'id' | 'style' | 'revision'>) {
  return {
    styleId: workOrder.style.id,
    source: 'OFFICE' as const,
    workOrderId: workOrder.id,
    ...(workOrder.revision ? { revisionId: workOrder.revision.id } : {}),
    title: draft.title.trim(),
    reason: draft.reason.trim(),
    priority: draft.priority,
  }
}
