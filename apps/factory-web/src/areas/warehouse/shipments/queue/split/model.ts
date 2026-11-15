import { SPLIT_REFUSALS } from '@nexus/factory-domain/shipping/split/split'
import { words, type Read, type Words } from '../shared/depth'
import type { SplitBody, SplitPreview, SplitReason } from './api'

/**
 * Split a shipment, pure (SCR-593; B-W2b-386 LOG-005): by hand (how many garments of each line move onto a new DRAFT, why,
 * and its carrier or service when that is the reason) or by the promise date (the rule's proposal); what holds Split and
 * with which words.
 */

export { SPLIT_REFUSALS }

/** The reasons offered by hand: a new ship-to is planned from the order (no address picker here). */
export const HAND_REASONS: readonly SplitReason[] = ['PART_READY', 'CUSTOMER_REQUEST', 'CARRIER', 'SERVICE', 'PROMISE_DATE', 'OTHER']

export interface SplitModel {
  readonly preview: Read<SplitPreview>
  readonly mode: 'hand' | 'rule'
  /** Garments to move per line (by hand). */
  readonly quantities: Readonly<Record<string, number>>
  readonly reason: SplitReason | null
  readonly transportBy: 'CARRIER' | 'SENDER' | 'RECIPIENT'
  readonly carrierCode: string
  readonly serviceCode: string
  readonly busy: boolean
  readonly problem: Words | null
  /** The new shipments, once split. */
  readonly made: readonly { readonly id: string; readonly number: string }[] | null
  /** `/w/<company>`: the new shipments' links. */
  readonly prefix: string
}

export interface SplitActions {
  onRetry?: () => void
  onMode?: (mode: SplitModel['mode']) => void
  onQuantity?: (lineId: string, quantity: number) => void
  onReason?: (reason: SplitReason) => void
  onDelivery?: (next: Partial<Pick<SplitModel, 'transportBy' | 'carrierCode' | 'serviceCode'>>) => void
  onSplit?: () => void
  onClose?: () => void
}

/** The garments moving and staying (by hand). */
export function handTotals(preview: SplitPreview, quantities: SplitModel['quantities']): { moving: number; staying: number } {
  const total = preview.lines.reduce((sum, line) => sum + line.quantity, 0)
  const moving = preview.lines.reduce((sum, line) => sum + Math.min(quantities[line.id] ?? 0, line.movable), 0)
  return { moving, staying: total - moving }
}

/** Why the split is held, by hand or by the rule. */
export function splitHeld(model: Pick<SplitModel, 'mode' | 'quantities' | 'reason' | 'transportBy' | 'carrierCode' | 'serviceCode' | 'busy'>, preview: SplitPreview): Words | null {
  if (!preview.mayManage) return words('split.held.noManage')
  if (preview.status !== 'DRAFT') return words('split.held.notDraft')
  if (model.busy) return words('split.held.busy')
  if (model.mode === 'rule') {
    const rule = preview.rules.find((entry) => entry.rule === 'PROMISE_DATE')
    if (!rule || rule.shipments.length === 0) return words('split.refusal.ONE_DAY')
    return null
  }
  if (!preview.splittable) return words('split.refusal.NOTHING_TO_MOVE')
  const { moving, staying } = handTotals(preview, model.quantities)
  if (moving === 0) return words('split.held.pickGarments')
  if (staying === 0) return words('split.refusal.NOTHING_STAYS')
  if (!model.reason) return words('split.held.pickReason')
  if (model.reason === 'CARRIER' && model.transportBy === 'CARRIER' && model.carrierCode.trim() === '') return words('split.held.carrierNeeded')
  if (model.reason === 'SERVICE' && model.serviceCode.trim() === '') return words('split.held.serviceNeeded')
  return null
}

/** The by-hand request: the lines with garments moving, and the new delivery when it is the reason. */
export function handBody(model: Pick<SplitModel, 'quantities' | 'reason' | 'transportBy' | 'carrierCode' | 'serviceCode'>, preview: SplitPreview): SplitBody | null {
  if (!model.reason) return null
  const lines = preview.lines.map((line) => ({ lineId: line.id, quantity: Math.min(model.quantities[line.id] ?? 0, line.movable) })).filter((line) => line.quantity > 0)
  const body: SplitBody = { version: preview.version, reason: model.reason, lines }
  if (model.reason === 'CARRIER') return { ...body, transportBy: model.transportBy, ...(model.transportBy === 'CARRIER' ? { carrierCode: model.carrierCode.trim() } : {}) }
  if (model.reason === 'SERVICE') return { ...body, serviceCode: model.serviceCode.trim() }
  return body
}
