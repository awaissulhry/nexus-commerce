import type { AdjustInput, ItemRef, Named } from '../../../_shared/stock/api'
import { decimalValue, type Phrase } from '../../../_shared/stock/model'

/**
 * Adjust stock (design st-adjust / mv-adjust: ONE dialog for Stock and Movements), pure: what it adjusts (one stock key
 * at one place, prefilled from the row), the draft (up or down, the quantity in the item's base unit, the reason the
 * API keeps, a reference, a unit cost with the cost grain only), the checks that hold "Post adjustment" with the
 * missing field named, the preview ("On hand 84,2 → 82,7 ft² at N-MAG-A-01") and the request.
 */

export interface AdjustTarget {
  siteId: string
  siteCode: string
  item: ItemRef
  colour: Named | null
  lot: { id: string; code: string } | null
  hide: { id: string; code: string } | null
  /** The place of the row: a decrease takes from here. */
  location: Named
  /** On hand there now, base unit. */
  onHand: string
}

export interface AdjustDraft {
  direction: 'IN' | 'OUT'
  /** Where an increase lands (default the row's place); a decrease is always the row's place. */
  locationId: string
  /** As typed ("1,5" or "1.5"). */
  quantity: string
  note: string
  reference: string
  /** Per base unit, as typed; cost grain only. */
  unitCost: string
}

export interface AdjustDialogModel {
  target: AdjustTarget
  draft: AdjustDraft
  /** The site's active places an increase may land in (null while read). */
  locations: Named[] | null
  withCost: boolean
  posting: boolean
  problem: Phrase | null
  /** Offline: the post waits with the reason. */
  offline?: boolean
}

export interface AdjustActions {
  onChange?: (draft: AdjustDraft) => void
  onPost?: () => void
  onClose?: () => void
}

export const blankDraft = (target: AdjustTarget): AdjustDraft => ({ direction: 'OUT', locationId: target.location.id, quantity: '', note: '', reference: '', unitCost: '' })

/** A typed decimal ("1,5", "1.5", "1 234,5") → "1.5", or null when it is not one (at most `scale` decimals). */
export function typedDecimal(text: string, scale = 4): string | null {
  const plain = text.trim().replace(/\s/g, '')
  if (!plain) return null
  const normal = plain.includes(',') && plain.includes('.') ? plain.replace(/\./g, '').replace(',', '.') : plain.replace(',', '.')
  if (!new RegExp(`^\\d{1,12}(\\.\\d{1,${scale}})?$`).test(normal)) return null
  return normal
}

export type AdjustCheck = 'quantity' | 'tooMuch' | 'note' | 'unitCost' | 'location'

/** What still holds the post, in order (the first one names the held button's reason). */
export function adjustChecks(model: Pick<AdjustDialogModel, 'target' | 'draft' | 'withCost'>): AdjustCheck[] {
  const { draft, target } = model
  const checks: AdjustCheck[] = []
  const quantity = typedDecimal(draft.quantity)
  if (quantity === null || Number(quantity) <= 0) checks.push('quantity')
  else if (draft.direction === 'OUT' && Number(quantity) > (decimalValue(target.onHand) ?? 0)) checks.push('tooMuch')
  if (!draft.locationId) checks.push('location')
  const note = draft.note.trim()
  if (note.length === 0 || note.length > 500) checks.push('note')
  if (model.withCost && draft.unitCost.trim() && typedDecimal(draft.unitCost, 6) === null) checks.push('unitCost')
  return checks
}

/** On hand before and after at the place it changes; `after` null for an increase at another place (unknown there). */
export function adjustPreview(model: Pick<AdjustDialogModel, 'target' | 'draft'>): { before: number | null; after: number | null; delta: number | null; place: 'row' | 'other' } {
  const quantity = typedDecimal(model.draft.quantity)
  const delta = quantity === null ? null : (model.draft.direction === 'IN' ? 1 : -1) * Number(quantity)
  const atRow = model.draft.direction === 'OUT' || model.draft.locationId === model.target.location.id
  const before = atRow ? (decimalValue(model.target.onHand) ?? 0) : null
  return { before, after: before !== null && delta !== null ? before + delta : null, delta, place: atRow ? 'row' : 'other' }
}

/** The request (one Idempotency-Key per dialog, sent by the container). */
export function adjustBody(model: Pick<AdjustDialogModel, 'target' | 'draft' | 'withCost'>): AdjustInput {
  const { target, draft } = model
  const reference = draft.reference.trim()
  const unitCost = model.withCost && draft.unitCost.trim() ? typedDecimal(draft.unitCost, 6) : null
  return {
    siteId: target.siteId,
    itemId: target.item.id,
    ...(target.colour ? { itemColourId: target.colour.id } : {}),
    ...(target.lot ? { lotId: target.lot.id } : {}),
    ...(target.hide ? { hideId: target.hide.id } : {}),
    locationId: draft.direction === 'OUT' ? target.location.id : draft.locationId,
    direction: draft.direction,
    quantity: typedDecimal(draft.quantity) ?? '0',
    note: draft.note.trim(),
    ...(reference ? { reference } : {}),
    ...(unitCost ? { unitCost: Number(unitCost).toFixed(6) } : {}),
  }
}

/** A refused post in our words: the stock is not there any more (409 below zero) or the API's other answers. */
export function adjustProblemKey(kind: string, code: string, hasIssues: boolean): string {
  if (kind === 'conflict' && code !== 'invalid_state' && hasIssues) return 'adj.problem.notEnough'
  if (kind === 'conflict') return 'adj.problem.changed'
  if (kind === 'invalid') return 'adj.problem.invalid'
  if (kind === 'forbidden' || kind === 'step_up') return 'adj.problem.forbidden'
  if (kind === 'unavailable') return 'adj.problem.offline'
  if (kind === 'not_found') return 'adj.problem.gone'
  return 'adj.problem.write'
}
