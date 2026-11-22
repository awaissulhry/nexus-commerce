import { MOVE_REFUSALS, TAKE_OFF_REFUSALS } from '@nexus/factory-domain/shipping/split/split'
import { refusalOf, words, writeWords, type Read, type Words } from '../shared/depth'
import type { SplitPreview, SplitReason } from '../split/api'
import { HAND_REASONS } from '../split/model'
import type { MergeBody, MoveBody, MoveTarget, MoveTargets } from './api'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7 D2 / D3; 18-lead-settles L6) — Move garments to… and Merge into…, pure: ONE dialog for
 * both pages (Warehouse's record ⋯ and the order's Shipments row ⋯): the target (only DRAFTs of the same customer, company and site;
 * each order's verdict in Warehouse's own join words), the garments per line that move (what is in a carton or has a serial stays),
 * why, and the office's words. A packed shipment never gives or takes. Merge moves every garment, then this one is cancelled
 * "Merged into …" (never deleted). The words are Warehouse's (`warehouse-shipments-depth`: split.*, shipOrders.why.*) and this lane's
 * (`order-shipments`: move.*).
 */

/** The refusal codes of a move or a merge (B-OS-011 / B-OS-012) and of taking an order off (B-OS-013): the domain's own lists. */
export const MOVE_REFUSAL_CODES = MOVE_REFUSALS
export const TAKE_OFF_REFUSAL_CODES = TAKE_OFF_REFUSALS
/** A hand reason: 3 to 500 characters (office words, never shown to the customer). */
export const REASON_LIMITS = Object.freeze({ min: 3, max: 500 })

export type MoveMode = 'move' | 'merge'

export interface MoveModel {
  readonly mode: MoveMode
  /** What may move (the split preview: each line's garments, those in cartons or with serials). */
  readonly preview: Read<SplitPreview>
  readonly targets: Read<MoveTargets>
  readonly targetId: string | null
  /** Garments that move, per line (move only). */
  readonly quantities: Readonly<Record<string, number>>
  readonly reason: SplitReason | null
  readonly words: string
  readonly busy: boolean
  readonly problem: Words | null
}

export interface MoveActions {
  onRetry?: () => void
  onTarget?: (targetId: string) => void
  onQuantity?: (lineId: string, quantity: number) => void
  onReason?: (reason: SplitReason) => void
  onWords?: (text: string) => void
  onGo?: () => void
  onClose?: () => void
}

export const initialMove = (mode: MoveMode): MoveModel => ({ mode, preview: { state: 'loading' }, targets: { state: 'loading' }, targetId: null, quantities: {}, reason: null, words: '', busy: false, problem: null })

/** The reasons a move offers (the split's own by hand: a new delivery address is planned from the order). */
export const MOVE_REASONS: readonly SplitReason[] = HAND_REASONS

/** A target's verdict for this shipment's orders: every order may join, or the first reason why not (Warehouse's join words). */
export function targetHeld(target: Pick<MoveTarget, 'verdicts'>): Words | null {
  const refused = target.verdicts.find((verdict) => !verdict.allowed)
  if (!refused) return null
  return refused.code ? words(`shipOrders.why.${refused.code}`) : words('shipOrders.cannotJoin')
}

/** The garments that move and stay (move). */
export function moveTotals(preview: Pick<SplitPreview, 'lines'>, quantities: MoveModel['quantities']): { moving: number; staying: number } {
  const total = preview.lines.reduce((sum, line) => sum + line.quantity, 0)
  const moving = preview.lines.reduce((sum, line) => sum + Math.min(Math.max(0, quantities[line.id] ?? 0), line.movable), 0)
  return { moving, staying: total - moving }
}

const reasonText = (text: string): string => text.trim()

/** Why the move or the merge is held — by the shipment's state first, then what is still to choose (null: it may go). */
export function moveHeld(model: Pick<MoveModel, 'mode' | 'targetId' | 'quantities' | 'reason' | 'words' | 'busy'>, preview: Pick<SplitPreview, 'status' | 'lines' | 'mayManage'>, targets: Pick<MoveTargets, 'targets'>): Words | null {
  if (!preview.mayManage) return words('split.held.noManage')
  if (preview.status !== 'DRAFT') return words('move.held.notDraft', undefined)
  if (model.busy) return words('move.held.busy')
  if (targets.targets.length === 0) return words('move.held.noTarget')
  const target = targets.targets.find((entry) => entry.id === model.targetId) ?? null
  if (!target) return words('move.held.pickTarget')
  const refused = targetHeld(target)
  if (refused) return refused
  if (reasonText(model.words).length > REASON_LIMITS.max) return words('move.held.wordsLong', { max: REASON_LIMITS.max })
  if (model.mode === 'merge') {
    // Everything moves: a garment in a carton or with a serial keeps the merge back ("take them out of the cartons first").
    if (preview.lines.some((line) => line.movable < line.quantity)) return words('move.refusal.MERGE_PACKED')
    return null
  }
  const { moving, staying } = moveTotals(preview, model.quantities)
  if (moving === 0) return words('split.held.pickGarments')
  if (staying === 0) return words('move.held.useMerge')
  if (!model.reason) return words('split.held.pickReason')
  return null
}

/** The move's request: the lines with garments moving, both versions, why and the office's words. */
export function moveBody(model: Pick<MoveModel, 'targetId' | 'quantities' | 'reason' | 'words'>, preview: Pick<SplitPreview, 'version' | 'lines'>, targets: Pick<MoveTargets, 'targets'>, toVersion?: number): MoveBody | null {
  if (!model.targetId || !model.reason) return null
  if (!targets.targets.some((target) => target.id === model.targetId)) return null
  const lines = preview.lines.map((line) => ({ lineId: line.id, quantity: Math.min(Math.max(0, model.quantities[line.id] ?? 0), line.movable) })).filter((line) => line.quantity > 0)
  if (lines.length === 0) return null
  const text = reasonText(model.words)
  return { version: preview.version, toShipmentId: model.targetId, toVersion, lines, reason: model.reason, words: text === '' ? null : text }
}

/** The merge's request: every garment into the target; this one is cancelled "Merged into …". */
export function mergeBody(model: Pick<MoveModel, 'targetId' | 'words'>, preview: Pick<SplitPreview, 'version'>, toVersion?: number): MergeBody | null {
  if (!model.targetId) return null
  const text = reasonText(model.words)
  return { version: preview.version, intoShipmentId: model.targetId, intoVersion: toVersion, words: text === '' ? null : text }
}

/** What stops taking an order off (the reason is required: 3 to 500 characters). */
export function takeOffReasonProblem(reason: string): Words | null {
  const text = reason.trim()
  if (text.length < REASON_LIMITS.min) return words('move.held.reasonShort', { min: REASON_LIMITS.min })
  if (text.length > REASON_LIMITS.max) return words('move.held.wordsLong', { max: REASON_LIMITS.max })
  return null
}

/** A refused move, merge or take-off in words: its own refusal, a join reason of the target (`JOIN_<CODE>`), else the step's words. */
export function moveProblem(error: unknown, known: readonly string[] = MOVE_REFUSAL_CODES): Words & { reload: boolean } {
  const code = refusalOf(error)
  if (code && code.startsWith('JOIN_')) return { ...words(`shipOrders.why.${code.slice('JOIN_'.length)}`), reload: true }
  return writeWords(error, 'move.refusal', known)
}
