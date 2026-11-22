import { SPLIT_LIMITS, SPLIT_REFUSALS } from '@nexus/factory-domain/shipping/split/split'
import { words, type Read, type Words } from '../shared/depth'
import type { SplitBody, SplitGroupsBody, SplitPreview, SplitReason } from './api'

/**
 * Split a shipment, pure (SCR-593; B-W2b-386 LOG-005): by hand (how many garments of each line move onto a new DRAFT, why,
 * and its carrier or service when that is the reason) or by the promise date (the rule's proposal); what holds Split and
 * with which words.
 */

export { SPLIT_REFUSALS }

/** The reasons offered by hand. F-OS-302 (X1-B4): + another delivery address, where the opener knows the customer (its addresses are read). */
export const HAND_REASONS: readonly SplitReason[] = ['PART_READY', 'CUSTOMER_REQUEST', 'CARRIER', 'SERVICE', 'SHIP_TO', 'PROMISE_DATE', 'OTHER']

/** F-OS-302: one of the customer's approved delivery addresses, in words. */
export interface ShipToChoice {
  readonly id: string
  readonly label: string
}

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
  // ---- F-OS-302 (order SHIPMENTS tab; B-OS-010; X1-B3, X1-B4): Split into several, in ONE command ----
  /** How many shipments it becomes (2: one new shipment, as before; at most 1 + SPLIT_LIMITS.shipments). */
  readonly into?: number
  /** Garments per line for the new shipments 2, 3, … (`quantities` is new shipment 1). */
  readonly extra?: readonly Readonly<Record<string, number>>[]
  /** Another delivery address may be chosen (the opener knows the customer: its approved addresses are read when asked). */
  readonly shipToOffered?: boolean
  /** The customer's approved delivery addresses (null: not read yet) and the one chosen for the new shipments. */
  readonly addresses?: Read<readonly ShipToChoice[]> | null
  readonly shipToAddressId?: string
  /** The customer wants it all in one delivery (the order's ship complete): a warning, never a block. */
  readonly shipComplete?: boolean
  // ---- end F-OS-302
}

export interface SplitActions {
  onRetry?: () => void
  onMode?: (mode: SplitModel['mode']) => void
  onQuantity?: (lineId: string, quantity: number) => void
  onReason?: (reason: SplitReason) => void
  onDelivery?: (next: Partial<Pick<SplitModel, 'transportBy' | 'carrierCode' | 'serviceCode'>>) => void
  onSplit?: () => void
  onClose?: () => void
  /** F-OS-302: how many shipments it becomes; the garments of a line for new shipment `group` (0 = new shipment 1); the address. */
  onInto?: (into: number) => void
  onGroupQuantity?: (group: number, lineId: string, quantity: number) => void
  onShipTo?: (addressId: string) => void
  onRetryAddresses?: () => void
}

// ── F-OS-302 (order SHIPMENTS tab; B-OS-010): the garments of each new shipment ─────────────────────────────────────────────────────
/** At most this many shipments in all (the one split and SPLIT_LIMITS.shipments new ones). */
export const INTO_MAX = SPLIT_LIMITS.shipments + 1

/** The garments asked of each new shipment, in order (new shipment 1 first): as many as `into` − 1. */
export function groupsOf(model: Pick<SplitModel, 'quantities' | 'into' | 'extra'>): Readonly<Record<string, number>>[] {
  const count = Math.max(1, Math.min(INTO_MAX, model.into ?? 2) - 1)
  return Array.from({ length: count }, (_, index) => (index === 0 ? model.quantities : (model.extra?.[index - 1] ?? {})))
}

/** Each new shipment's garments per line, capped so a line never gives more than can move (earlier shipments first). */
export function cappedGroups(preview: SplitPreview, groups: readonly Readonly<Record<string, number>>[]): Record<string, number>[] {
  const given: Record<string, number> = {}
  return groups.map((group) =>
    Object.fromEntries(
      preview.lines.map((line) => {
        const room = Math.max(0, line.movable - (given[line.id] ?? 0))
        const take = Math.max(0, Math.min(group[line.id] ?? 0, room))
        given[line.id] = (given[line.id] ?? 0) + take
        return [line.id, take]
      }),
    ),
  )
}

/** The most a line may still give to new shipment `group` (what can move less what the other new shipments take). */
export function roomOf(line: SplitPreview['lines'][number], groups: readonly Readonly<Record<string, number>>[], group: number): number {
  const others = groups.reduce((sum, entry, index) => (index === group ? sum : sum + (entry[line.id] ?? 0)), 0)
  return Math.max(0, line.movable - others)
}
// ── end F-OS-302 ──

/** The garments moving and staying (by hand). F-OS-302: `extra` — the new shipments 2, 3, … (each counted, never past what can move). */
export function handTotals(preview: SplitPreview, quantities: SplitModel['quantities'], extra: readonly Readonly<Record<string, number>>[] = []): { moving: number; staying: number } {
  const total = preview.lines.reduce((sum, line) => sum + line.quantity, 0)
  const moving = cappedGroups(preview, [quantities, ...extra]).reduce((sum, group) => sum + Object.values(group).reduce((inner, value) => inner + value, 0), 0)
  return { moving, staying: total - moving }
}

/** Why the split is held, by hand or by the rule. */
export function splitHeld(model: Pick<SplitModel, 'mode' | 'quantities' | 'reason' | 'transportBy' | 'carrierCode' | 'serviceCode' | 'busy'> & Partial<Pick<SplitModel, 'into' | 'extra' | 'shipToAddressId'>>, preview: SplitPreview): Words | null {
  if (!preview.mayManage) return words('split.held.noManage')
  if (preview.status !== 'DRAFT') return words('split.held.notDraft')
  if (model.busy) return words('split.held.busy')
  if (model.mode === 'rule') {
    const rule = preview.rules.find((entry) => entry.rule === 'PROMISE_DATE')
    if (!rule || rule.shipments.length === 0) return words('split.refusal.ONE_DAY')
    return null
  }
  if (!preview.splittable) return words('split.refusal.NOTHING_TO_MOVE')
  const groups = groupsOf(model)
  const { moving, staying } = handTotals(preview, groups[0]!, groups.slice(1))
  if (moving === 0) return words('split.held.pickGarments')
  if (staying === 0) return words('split.refusal.NOTHING_STAYS')
  // F-OS-302 (B-OS-010): into several — each new shipment takes at least one garment.
  if (groups.length > 1) {
    const empty = cappedGroups(preview, groups).findIndex((group) => Object.values(group).every((value) => value === 0))
    if (empty >= 0) return words('door.split.eachTakes', { n: empty + 1 })
  }
  if (!model.reason) return words('split.held.pickReason')
  if (model.reason === 'CARRIER' && model.transportBy === 'CARRIER' && model.carrierCode.trim() === '') return words('split.held.carrierNeeded')
  if (model.reason === 'SERVICE' && model.serviceCode.trim() === '') return words('split.held.serviceNeeded')
  if (model.reason === 'SHIP_TO' && !model.shipToAddressId) return words('door.split.pickAddress') // F-OS-302 (X1-B4)
  return null
}

/**
 * The by-hand request: the lines with garments moving, and the new delivery when it is the reason. F-OS-302 (B-OS-010): into several —
 * `groups`, one per new shipment, each with the same reason and delivery, in ONE command (one new shipment: today's body exactly).
 */
export function handBody(model: Pick<SplitModel, 'quantities' | 'reason' | 'transportBy' | 'carrierCode' | 'serviceCode'> & Partial<Pick<SplitModel, 'into' | 'extra' | 'shipToAddressId'>>, preview: SplitPreview): SplitBody | SplitGroupsBody | null {
  const reason = model.reason
  if (!reason) return null
  const delivery = reason === 'CARRIER' ? { transportBy: model.transportBy, ...(model.transportBy === 'CARRIER' ? { carrierCode: model.carrierCode.trim() } : {}) } : reason === 'SERVICE' ? { serviceCode: model.serviceCode.trim() } : reason === 'SHIP_TO' && model.shipToAddressId ? { shipToAddressId: model.shipToAddressId } : {}
  const groups = cappedGroups(preview, groupsOf(model)).map((group) => preview.lines.map((line) => ({ lineId: line.id, quantity: group[line.id] ?? 0 })).filter((line) => line.quantity > 0))
  if (groups.length === 1) return { version: preview.version, reason, lines: groups[0]!, ...delivery }
  return { version: preview.version, groups: groups.map((lines) => ({ reason, lines, ...delivery })) }
}
