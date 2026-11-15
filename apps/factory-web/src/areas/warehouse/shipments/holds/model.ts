import { HOLD_LIMITS, HOLD_REFUSALS, SHIPMENT_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import { words, type DepthAbilities, type Read, type Words } from '../queue/shared/depth'
import type { Hold, HoldReason, Holds, Placed } from './api'

/**
 * A shipment's holds, pure (SCR-592; design warehouse.shipments sh-ready "W2b: no hold (credit, deposit or balance, quality,
 * customer request)", the selection row "Hold"; Owner rule W2b-6 "a held shipment says who may release it"): the view
 * model of the record's panel and of the list's Hold dialog, what holds each button and with which words.
 */

export { HOLD_REFUSALS, SHIPMENT_HOLD_REASONS }
export const HOLD_WORDS_MAX = HOLD_LIMITS.words
/** A money hold (and every hold the system placed) is released by finance (shipping.holds.release) as well. */
export const MONEY_REASONS: readonly HoldReason[] = ['CREDIT', 'DEPOSIT', 'BALANCE_UNPAID']

export type HoldsDialog = null | { readonly kind: 'place'; readonly reason: HoldReason | null; readonly text: string } | { readonly kind: 'release'; readonly holdId: string; readonly text: string }

export interface HoldsPanelModel {
  readonly holds: Read<Holds>
  readonly can: Pick<DepthAbilities, 'holdsManage' | 'holdsRelease'>
  readonly dialog: HoldsDialog
  readonly busy: boolean
  readonly problem: Words | null
  /** The last write, in words (placed, released). */
  readonly done: Words | null
}

export interface HoldsPanelActions {
  onRetry?: () => void
  onDialog?: (dialog: HoldsDialog) => void
  onPlace?: () => void
  onRelease?: () => void
}

export const initialHolds: HoldsPanelModel = { holds: { state: 'loading' }, can: { holdsManage: false, holdsRelease: false }, dialog: null, busy: false, problem: null, done: null }

/** The holds in force (the ready check's "no hold" fails while one is). */
export const inForce = (holds: Holds): Hold[] => holds.holds.filter((hold) => hold.inForce)

/** Who releases a hold, in words: finance for money and the system's, else the warehouse. */
export function releasedByWords(hold: Pick<Hold, 'reason' | 'bySystem'>): Words {
  return MONEY_REASONS.includes(hold.reason) || hold.bySystem ? words('holds.releasedBy.finance') : words('holds.releasedBy.warehouse')
}

/** Why "Place a hold" is held (null: it may be placed). */
export function placeHeld(holds: Holds, can: HoldsPanelModel['can'], busy: boolean): Words | null {
  if (!can.holdsManage || !holds.mayPlace) return words('holds.held.noManage')
  if (holds.status !== 'DRAFT' && holds.status !== 'PACKED') return words('holds.held.notOpen')
  if (busy) return words('holds.held.busy')
  return null
}

/** Why "Release" of one hold is held. */
export function releaseHeld(hold: Hold, can: HoldsPanelModel['can'], busy: boolean): Words | null {
  if (!hold.inForce) return words('holds.held.notInForce')
  if (!can.holdsManage) return words('holds.held.noManage')
  if (!hold.mayRelease) return MONEY_REASONS.includes(hold.reason) || hold.bySystem ? words('holds.held.financeOnly') : words('holds.held.noManage')
  if (busy) return words('holds.held.busy')
  return null
}

/** The reasons offered: the API's choices, one already in force left out (it would be refused ALREADY_HELD). */
export function reasonChoices(holds: Holds): Holds['reasonChoices'] {
  const held = new Set(inForce(holds).map((hold) => hold.reason))
  return holds.reasonChoices.filter((choice) => !held.has(choice.reason))
}

/** What stops the place dialog's confirm (null: it may go). */
export function placeProblem(dialog: Extract<HoldsDialog, { kind: 'place' }>, choices: Holds['reasonChoices'] | null): Words | null {
  if (!dialog.reason) return words('holds.form.pickReason')
  const choice = choices?.find((entry) => entry.reason === dialog.reason)
  const typed = dialog.text.trim()
  if ((choice?.wordsRequired ?? dialog.reason === 'OTHER') && typed === '') return words('holds.form.wordsNeeded')
  if (typed.length > HOLD_WORDS_MAX) return words('holds.form.tooLong', { max: HOLD_WORDS_MAX })
  return null
}

/** What stops the release dialog's confirm. */
export function releaseProblem(dialog: Extract<HoldsDialog, { kind: 'release' }>): Words | null {
  const typed = dialog.text.trim()
  if (typed === '') return words('holds.form.whyNeeded')
  if (typed.length > HOLD_WORDS_MAX) return words('holds.form.tooLong', { max: HOLD_WORDS_MAX })
  return null
}

// ---- the list's Hold (the selection row) ---------------------------------------------------------------------------------------

export interface BulkHoldModel {
  /** The shipments picked (number and status as the list shows them). */
  readonly picked: readonly { readonly id: string; readonly number: string; readonly status: string }[]
  readonly reason: HoldReason | null
  readonly text: string
  readonly busy: boolean
  readonly problem: Words | null
  /** The answer: placed and skipped, each said. */
  readonly outcome: Placed | null
}

export interface BulkHoldActions {
  onReason?: (reason: HoldReason) => void
  onText?: (text: string) => void
  onGo?: () => void
  onClose?: () => void
}

/** Only an open shipment (DRAFT, PACKED) can be held; the others are named and skipped before anything is sent. */
export const holdable = (status: string): boolean => status === 'DRAFT' || status === 'PACKED'

/** The reasons a person may place from the list (the system places none of its own here). */
export const BULK_REASONS: readonly HoldReason[] = SHIPMENT_HOLD_REASONS

/** What stops the list's Hold. */
export function bulkProblem(model: Pick<BulkHoldModel, 'picked' | 'reason' | 'text'>): Words | null {
  if (model.picked.filter((row) => holdable(row.status)).length === 0) return words('holds.bulk.noneOpen')
  if (!model.reason) return words('holds.form.pickReason')
  if (model.reason === 'OTHER' && model.text.trim() === '') return words('holds.form.wordsNeeded')
  if (model.text.trim().length > HOLD_WORDS_MAX) return words('holds.form.tooLong', { max: HOLD_WORDS_MAX })
  return null
}
