import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { Grains } from '../../model'
import type { ApprovalTask, VersionRecord, VersionRow } from './api'

/**
 * The cost sheets' rules on the style's Cost tab (B-W2b-430), pure: who may do what (costing.view to read,
 * costing.sheets.manage to write a draft, costing.sheets.approve to take an approved version back, approvals.decide to
 * approve one through the engine, pricelists.manage with the price grain for a size surcharge), the state of a version in
 * words, which version is in view, why each action is held, and a refusal in words from its code (`refusal/<CODE>`), never
 * the API's English. Words: the `cost-sheets` catalogue.
 */

export const CS_NS = 'cost-sheets'

/** A message key with its values. */
export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A read of the page: nothing yet, reading, the answer, or why it failed (never drawn as empty). */
export type Read<T> = { readonly status: 'idle' } | { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export interface CostSheetAbilities {
  view: boolean
  manage: boolean
  approve: boolean
  decide: boolean
  surcharge: boolean
}

export function costSheetAbilitiesOf(permissions: readonly string[]): CostSheetAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('costing.view'),
    manage: held.has('costing.sheets.manage'),
    approve: held.has('costing.sheets.approve'),
    decide: held.has('approvals.decide'),
    surcharge: held.has('pricelists.manage') && held.has('money.price'),
  }
}

export type VersionState = 'draft' | 'waiting' | 'approved' | 'superseded' | 'seasonClosed' | 'withdrawn'

/** A version's state as the list says it: a draft, a draft waiting for its yes, approved, or frozen (and why). */
export function versionState(row: Pick<VersionRow, 'state' | 'frozenReason' | 'approval'>): VersionState {
  if (row.state === 'APPROVED') return 'approved'
  if (row.state === 'FROZEN') return row.frozenReason === 'SEASON_CLOSED' ? 'seasonClosed' : row.frozenReason === 'WITHDRAWN' ? 'withdrawn' : 'superseded'
  return row.approval?.status === 'PENDING' ? 'waiting' : 'draft'
}

export const STATE_TONE: Readonly<Record<VersionState, 'neutral' | 'info' | 'success' | 'warning'>> = Object.freeze({
  draft: 'neutral',
  waiting: 'warning',
  approved: 'success',
  superseded: 'neutral',
  seasonClosed: 'neutral',
  withdrawn: 'neutral',
})

/** The version shown below the list: the one picked, else the approved one, else the newest draft, else the newest. */
export function versionInView(rows: readonly VersionRow[], picked: string | null): VersionRow | null {
  if (picked) {
    const found = rows.find((row) => row.id === picked)
    if (found) return found
  }
  const newest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return newest.find((row) => row.state === 'APPROVED') ?? newest.find((row) => row.state === 'DRAFT') ?? newest[0] ?? null
}

/** The two versions offered to compare first: the approved one against the newest draft, else the two newest. */
export function compareDefaults(rows: readonly VersionRow[]): { a: string; b: string } | null {
  if (rows.length < 2) return null
  const newest = [...rows].sort((x, y) => y.createdAt.localeCompare(x.createdAt))
  const approved = newest.find((row) => row.state === 'APPROVED')
  const draft = newest.find((row) => row.state === 'DRAFT')
  if (approved && draft) return { a: approved.id, b: draft.id }
  return { a: newest[1]!.id, b: newest[0]!.id }
}

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** Why a new version waits, or null. */
export function newVersionHeld(can: CostSheetAbilities, revision: { id: string } | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!revision) return phrase('verHeld.noRevision')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why "Send for approval" waits, or null (the version's own `can.submit` from the API decides the state). */
export function sendHeld(can: CostSheetAbilities, row: VersionRow | null, record: VersionRecord | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row || !record) return phrase('verHeld.reading')
  if (row.state !== 'DRAFT') return phrase('verHeld.notDraft')
  if (row.approval?.status === 'PENDING') return phrase('verHeld.waiting')
  if (record.lines.length === 0) return phrase('verHeld.noLines')
  if (row.season?.status === 'CLOSED') return phrase('verHeld.seasonClosed')
  if (!record.can.submit) return phrase('verHeld.cannotSubmit')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why "Approve and lock" waits, or null: only a waiting request, by a decider who neither asked nor made it. */
export function approveHeld(can: CostSheetAbilities, row: VersionRow | null, task: Read<ApprovalTask> | null, busy: boolean): Phrase | null {
  if (!row || row.state !== 'DRAFT' || row.approval?.status !== 'PENDING') return phrase('verHeld.notWaiting')
  if (!can.decide) return phrase('verHeld.noDecide')
  if (!task || task.status === 'idle' || task.status === 'loading') return phrase('verHeld.reading')
  if (task.status === 'error') return phrase(task.problem)
  if (task.value.requester.me) return phrase('verHeld.ownRequest')
  if (!task.value.approve.allowed) return phrase('verHeld.notTheApprover')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why "Take back" waits, or null: an approved version, by a costing owner. */
export function takeBackHeld(can: CostSheetAbilities, row: VersionRow | null, busy: boolean): Phrase | null {
  if (!can.approve) return phrase('verHeld.noApprove')
  if (!row || row.state !== 'APPROVED') return phrase('verHeld.notApproved')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why "Delete draft" waits, or null: a draft nobody copied. */
export function removeHeld(can: CostSheetAbilities, row: VersionRow | null, record: VersionRecord | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row || row.state !== 'DRAFT') return phrase('verHeld.notDraft')
  if (record && !record.can.remove) return phrase('verHeld.copiedFrom')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** Why a target cannot be kept on the version, or null: a draft only, with the price grain (a margin also asks its own). */
export function keepTargetHeld(can: CostSheetAbilities, grains: Grains, row: VersionRow | null, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('verHeld.noManage')
  if (!row) return phrase('verHeld.reading')
  if (row.state !== 'DRAFT') return phrase('verHeld.locked')
  if (!grains.price) return phrase('verHeld.noPriceGrain')
  if (busy) return phrase('verHeld.busy')
  return null
}

/** The refusals of the cost sheets' routes this page words (`refusal.<CODE>`). */
export const KNOWN_REFUSALS = [
  'LOCKED',
  'FROZEN',
  'NOT_APPROVED',
  'NO_LINES',
  'LEFT_OUT',
  'SEASON_CLOSED',
  'OWN_SHEET',
  'NO_APPROVER',
  'OTHER_SERIES',
  'OTHER_REVISION',
  'COPIED_FROM',
  'BASE_SIZE',
  'NOTHING_CHANGES',
  'OTHER_STYLE',
  'SAME_SHEET',
  'OTHER_CURRENCY',
  'NO_COMPANY',
  'INCOMPLETE',
  'NOT_DRAFT',
  'DATABASE',
] as const

/** The code of a 409 `refusal/<CODE>`, or null. */
export function refusalCode(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    if (match) return match[1]!
  }
  return null
}

/** A failed read in words (a key of this catalogue). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'verProblem.read.unavailable'
  if (error.kind === 'forbidden') return 'verProblem.read.forbidden'
  if (error.kind === 'not_found') return 'verProblem.read.notFound'
  if (error.kind === 'invalid') return 'verProblem.read.invalid'
  return 'verProblem.read.unavailable'
}

/** A refused write in words: a refusal this page words, else the kind (moved meanwhile, no right, a fresh code wanted …). */
export function writeProblem(error: unknown, known: readonly string[] = KNOWN_REFUSALS): Phrase & { reload: boolean } {
  const code = refusalCode(error)
  if (code && known.includes(code)) return { key: `verRefusal.${code}`, reload: code === 'DATABASE' }
  if (!isApiError(error)) return { key: 'verProblem.write.unavailable', reload: false }
  if (error.kind === 'conflict') return { key: 'verProblem.write.moved', reload: true }
  if (error.kind === 'forbidden') return { key: 'verProblem.write.forbidden', reload: false }
  if (error.kind === 'step_up') return { key: 'verProblem.write.stepUp', reload: false }
  if (error.kind === 'not_found') return { key: 'verProblem.write.notFound', reload: true }
  if (error.kind === 'invalid') return { key: 'verProblem.write.invalid', reload: false }
  return { key: 'verProblem.write.unavailable', reload: false }
}

/** A typed amount ("12,50" or "12.50") as the API takes it, or null when it is not a figure above 0. */
export function typedAmount(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(value)) return null
  return Number(value) > 0 ? value : null
}

/** A typed margin percent below 100 (it may be negative), as the API takes it, or null. */
export function typedMargin(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^-?\d{1,3}(\.\d{1,4})?$/.test(value)) return null
  return Number(value) < 100 ? value : null
}

/** Garments per carton typed (1 … 10 000), or null. */
export function typedPieces(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,5}$/.test(value)) return null
  const number = Number(value)
  return number >= 1 && number <= 10000 ? number : null
}

/** A live change that touches the cost sheets of a style. */
export const costSheetsTouched = (change: { type: string }): boolean =>
  change.type === 'cost_sheet.version_changed' ||
  change.type === 'cost_sheet.approved' ||
  change.type === 'cost_sheet.components_written' ||
  change.type === 'size_weights.changed' ||
  change.type === 'mass_update.applied' ||
  change.type.startsWith('approval.')
