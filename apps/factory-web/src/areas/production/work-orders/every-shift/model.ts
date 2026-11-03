import { RELEASE_BULK_LIMIT, TRAVELLER_BULK_LIMIT } from '@nexus/factory-domain/production/work-orders/bulk'
import { MAX_CELL_PIECES } from '@nexus/factory-domain/production/work-orders/cells'
import { PRIORITY_LIMITS, RUSH_CHOICES } from '@nexus/factory-domain/production/work-orders/priority'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { WorkOrder, WorkOrderRow, WorkOrderWip } from '../../_shared/api'
import type { Phrase, ProductionCan } from '../../_shared/model'
import type { ReleasePreviewRow, ReleaseResultRow, SplitAsk, SplitPreview } from './api'

/**
 * The work order every shift (B-W2b-59; design production.workorders; MES-009, -010, -014, -017), pure: priority and rush,
 * "Release N work orders" with each row's blockers, the travellers' addresses, the split's ask and why it waits, and the
 * Minutes section (standard minutes planned · earned per operation: work order totals only, never a person). Keys of
 * `production-every-shift`.
 */

export const SHIFT_NAMESPACE = 'production-every-shift'
export { PRIORITY_LIMITS, RELEASE_BULK_LIMIT, RUSH_CHOICES, TRAVELLER_BULK_LIMIT }

const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })
const shift = (key: string, params?: Phrase['params']): Phrase => phrase(`${SHIFT_NAMESPACE}:${key}`, params)

// ---- release N -------------------------------------------------------------------------------------------------------------

/** "Release N work orders" (design wo-grid selection row): read through the preview, each row said, saved through the release. */
export type ReleasePhase = { phase: 'reading' } | { phase: 'failed'; words: Phrase } | { phase: 'ready' } | { phase: 'saving' } | { phase: 'done'; results: readonly ReleaseResultRow[] }

export interface BulkReleaseModel {
  rows: Array<{ id: string; number: string; styleCode: string }>
  preview: readonly ReleasePreviewRow[] | null
  state: ReleasePhase
}

/** Why Release N waits, or null: the right, a selection with a draft in it, the API's limit. */
export function releaseHeld(rows: readonly Pick<WorkOrderRow, 'status'>[], can: Pick<ProductionCan, 'release'>): Phrase | null {
  if (!can.release) return phrase('held.noRelease')
  if (rows.length === 0) return shift('release.pickFirst')
  if (rows.length > RELEASE_BULK_LIMIT) return shift('release.tooMany', { max: RELEASE_BULK_LIMIT })
  return rows.some((row) => row.status === 'DRAFT') ? null : shift('release.noDraft')
}

/** What a refused row says: the release checks that hold it (RELEASE_CHECKS codes the record's checklist words), or its state. */
export function refusedWords(refusal: NonNullable<ReleasePreviewRow['refusal']>): { checks: readonly string[]; key: string } {
  const checks = refusal.reasons ?? []
  if (checks.length > 0) return { checks, key: 'release.heldBy' }
  if (refusal.code === 'held') return { checks: [], key: 'release.heldState' }
  return { checks: [], key: `release.refusal.${refusal.code}` }
}

// ---- travellers --------------------------------------------------------------------------------------------------------------

/** The new tab of one work order's traveller, or of several in one PDF. */
export const travellersHref = (prefix: string, ids: readonly string[]): string => (ids.length === 1 ? `${prefix}/production/work-orders/${ids[0]}/traveller` : `${prefix}/production/work-orders/travellers?ids=${ids.join(',')}`)

/** Why "Print travellers" waits, or null. */
export function travellersHeld(ids: readonly string[]): Phrase | null {
  if (ids.length === 0) return shift('travellers.none')
  return ids.length > TRAVELLER_BULK_LIMIT ? shift('travellers.tooMany', { max: TRAVELLER_BULK_LIMIT }) : null
}

/** The ids of `?ids=a,b`: each once, in the order asked, at most the API's limit. */
export function travellerIdsOf(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ].slice(0, TRAVELLER_BULK_LIMIT)
}

// ---- split --------------------------------------------------------------------------------------------------------------------

/** Why "Split work order" waits, or null. Only a DRAFT of a size grid: the release freezes the cells (MES-005). */
export function splitHeld(workOrder: Pick<WorkOrder, 'status' | 'kind'>, can: Pick<ProductionCan, 'manage'>): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (workOrder.kind === 'REPAIR' || workOrder.kind === 'MADE_TO_MEASURE') return shift('split.heldKind')
  return workOrder.status === 'DRAFT' ? null : shift('split.heldFrozen')
}

export type SplitMoves = Readonly<Record<string, number>>

/** The cells that move, in the work order's order. */
export const splitAskOf = (cells: readonly Pick<WorkOrder['cells'][number], 'id'>[], moves: SplitMoves): SplitAsk[] => cells.flatMap((cell) => (moves[cell.id] ? [{ cellId: cell.id, quantity: moves[cell.id]! }] : []))

/** A cell asked above what it holds, by id. */
export const overCells = (cells: readonly Pick<WorkOrder['cells'][number], 'id' | 'quantity'>[], moves: SplitMoves): string[] => cells.filter((cell) => (moves[cell.id] ?? 0) > cell.quantity || (moves[cell.id] ?? 0) > MAX_CELL_PIECES).map((cell) => cell.id)

export interface SplitDraft {
  moves: SplitMoves
  dueDate: string
  priority: string
  rush: boolean
  note: string
}

export const priorityBad = (value: string): boolean => {
  const number = Number(value)
  return value.trim() === '' || !Number.isInteger(number) || number < PRIORITY_LIMITS.min || number > PRIORITY_LIMITS.max
}

/** Why the dialog's Split waits, or null: pieces move, some stay, the fields read well, the API's preview agrees. */
export function splitAskHeld(workOrder: Pick<WorkOrder, 'cells' | 'pieces'>, draft: SplitDraft, preview: SplitPreview | null, busy: boolean): Phrase | null {
  const moved = splitAskOf(workOrder.cells, draft.moves).reduce((sum, ask) => sum + ask.quantity, 0)
  if (moved === 0) return shift('split.heldNothing')
  if (overCells(workOrder.cells, draft.moves).length > 0) return shift('split.heldOver')
  if (moved >= workOrder.pieces) return shift('split.heldAll')
  if (priorityBad(draft.priority)) return phrase('overview.priorityBad')
  if (busy) return phrase('held.busy')
  if (!preview) return phrase('held.checking')
  return preview.refusal || preview.problems.length > 0 ? shift('split.heldApi') : null
}

/** A refused split, in words. */
export function splitProblem(error: unknown): Phrase {
  if (!isApiError(error)) return shift('split.failed')
  if (error.kind === 'conflict') return shift(error.issues.map(issuePath).some((path) => path.startsWith('body/')) ? 'split.heldApi' : 'split.changed')
  if (error.kind === 'forbidden') return phrase('held.noManage')
  return shift(error.kind === 'invalid' ? 'split.heldApi' : 'split.failed')
}

// ---- minutes -----------------------------------------------------------------------------------------------------------------

export interface MinutesRow {
  seq: number
  code: string
  name: string
  /** Standard minutes × the pieces of the work order. */
  planned: number
  /** Standard minutes × the good pieces reported; null when the operation is not scanned (nothing reports it). */
  earned: number | null
}

export interface Minutes {
  rows: MinutesRow[]
  planned: number
  /** Over the scanned operations only. */
  earned: number
  /** Any operation that nothing reports (its earned minutes are not known). */
  unscanned: number
}

const tenths = (value: number): number => Math.round(value * 10) / 10

/**
 * Standard minutes planned vs earned per operation (design wo-minutes; the same rule as the labour record, B-W2b-45:
 * good × the operation's frozen standard minutes). Before the release there are no scans: earned is 0. Per work order
 * and operation only: never a person, never money.
 */
export function minutesOf(workOrder: Pick<WorkOrder, 'pieces' | 'spec'>, wip: Pick<WorkOrderWip, 'operations'> | null): Minutes {
  const good = new Map((wip?.operations ?? []).map((operation) => [operation.seq, operation.good]))
  const rows = [...workOrder.spec.operations]
    .sort((a, b) => a.seq - b.seq)
    .map((operation) => {
      const standard = Number(operation.standardMinutes)
      // B-W2b-82: an unplanned operation earns what its scans report; nothing of it was planned.
      const unplanned = operation.routingSeq === null
      return {
        seq: operation.seq,
        code: operation.code,
        name: operation.name,
        planned: unplanned ? 0 : tenths(standard * workOrder.pieces),
        earned: operation.scanRequired || unplanned ? tenths(standard * (good.get(operation.seq) ?? 0)) : null,
      }
    })
  return {
    rows,
    planned: tenths(rows.reduce((sum, row) => sum + row.planned, 0)),
    earned: tenths(rows.reduce((sum, row) => sum + (row.earned ?? 0), 0)),
    unscanned: rows.filter((row) => row.earned === null).length,
  }
}
