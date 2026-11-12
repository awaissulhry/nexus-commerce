import { FINISH_REASONS } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { ReturnLine, ReturnStatus, Rma } from '../api'
import { minorOf, type ReturnsCan, type Words } from '../model'
import type { CreditPreview, DepthLine, FinishReason, OutcomeLine, PolicyCheck, ReturnDepth, ReturnOutcomes } from './api'
import type { RmaDepthModel } from './view-model'

/**
 * The rules of the W2b parts of a return without a screen (B-W2b-352): what each part says and why a step is held, in OUR
 * words read from the facts (the API's `held` and `words` are English and are never shown: each rule below mirrors the
 * API's own — factory-domain sales/returns-depth and sales/returns-outcomes — by its facts), and what each write sends.
 * Pure: no React, no API client. Keys are `depth:` keys (catalogue `sales-returns-depth`), the W2a catalogue's otherwise.
 */

const FINAL: readonly ReturnStatus[] = ['CLOSED', 'REJECTED', 'CANCELLED']
const isFinal = (status: ReturnStatus): boolean => FINAL.includes(status)

// ---- the facts: policy, deadline, withdrawal, scan code -----------------------------------------------------------------

/** The policy the return follows, in words: the policy named (and whether a newer one is live), else the sales settings. */
export function policyWords(depth: Pick<ReturnDepth, 'policy'>): Words {
  const named = depth.policy.named
  if (!named) return { key: 'depth:policy.salesSettings' }
  return { key: depth.policy.current ? 'depth:policy.named' : 'depth:policy.namedOld', params: { name: named.name, days: named.windowDays } }
}

/** The goods against their deadline, in words (the first receipt's day decides; YYYY-MM-DD params are drawn as days). */
export function arrivalWords(depth: Pick<ReturnDepth, 'deadline'>): Words {
  const { goodsDueBy, receivedOn, arrival } = depth.deadline
  switch (arrival.state) {
    case 'NO_DEADLINE':
      return receivedOn ? { key: 'depth:arrival.noDeadlineArrived', params: { date: receivedOn } } : { key: 'depth:arrival.NO_DEADLINE' }
    case 'WAITING':
      return { key: 'depth:arrival.WAITING', params: { date: goodsDueBy ?? '—' } }
    case 'OVERDUE':
      return { key: 'depth:arrival.OVERDUE', params: { date: goodsDueBy ?? '—', count: arrival.daysLate } }
    case 'ON_TIME':
      return { key: 'depth:arrival.ON_TIME', params: { date: receivedOn ?? '—' } }
    case 'LATE':
      return { key: 'depth:arrival.LATE', params: { date: goodsDueBy ?? '—', count: arrival.daysLate } }
  }
}

export const arrivalTone = (depth: Pick<ReturnDepth, 'deadline'>): 'warning' | 'neutral' => (depth.deadline.arrival.state === 'LATE' || depth.deadline.arrival.state === 'OVERDUE' ? 'warning' : 'neutral')

/** A line's window in words, or null when it was returned inside it (or no delivery day is known). */
export function windowWords(window: DepthLine['window']): Words | null {
  if (!window || window.inWindow || !window.lastDay) return null
  return { key: 'depth:window.over', params: { date: window.lastDay, count: window.daysOver } }
}

/** The garment of a line: the serial of ours (or the customer's), else the lot. */
export function garmentWords(line: Pick<DepthLine, 'garmentSerial' | 'garmentBatch' | 'serial' | 'batchNumber'>): string | null {
  return line.garmentSerial ?? line.serial ?? line.garmentBatch ?? line.batchNumber ?? null
}

// ---- Arrived after the deadline (the tile, its view, the list's rows) ----------------------------------------------------

/**
 * The view's rows: the open returns that arrived late, in the order of their receipt (newest first). `missing` counts those
 * the open list did not carry (it is cut at its limit): the count then says "or more".
 */
export function lateRowsOf<R extends { readonly id: string }>(rows: readonly R[], late: { readonly rows: readonly { readonly id: string }[]; readonly truncated: boolean }): { rows: R[]; missing: number; truncated: boolean } {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const found = late.rows.flatMap((entry) => {
    const row = byId.get(entry.id)
    return row ? [row] : []
  })
  const missing = late.rows.length - found.length
  return { rows: found, missing, truncated: late.truncated || missing > 0 }
}

// ---- the lines: split the rest -------------------------------------------------------------------------------------------

/** Why a line may not be split now (null: it may), mirroring the API's splitHeld from the line's facts. */
export function splitHeldKey(status: ReturnStatus, line: Pick<OutcomeLine, 'seq' | 'quantity' | 'receivedQuantity' | 'creditWithoutReturn' | 'split'>): Words | null {
  if (line.split.allowed) return null
  const seq = { seq: line.seq }
  if (isFinal(status)) return { key: 'depth:held.split.final' }
  if (status !== 'RECEIVED' && status !== 'INSPECTED') return { key: 'depth:held.split.beforeGoods', params: seq }
  if (line.creditWithoutReturn) return { key: 'depth:held.split.credited', params: seq }
  if (line.receivedQuantity < 1) return { key: 'depth:held.split.nothing', params: seq }
  if (line.receivedQuantity >= line.quantity) return { key: 'depth:held.split.all', params: seq }
  return { key: 'depth:held.notNow' }
}

// ---- the decision: size exchange, the fee -------------------------------------------------------------------------------

/** The fee of a line in words (the amount itself is drawn beside it, with the price grain). */
export function feeWords(fee: DepthLine['fee'], facts: { readonly feesApply: boolean; readonly decided: boolean }): Words {
  if (!facts.feesApply) return { key: 'depth:fee.noPolicy' }
  if (!fee) return facts.decided ? { key: 'depth:fee.noRule' } : { key: 'depth:fee.atDecision' }
  if (fee.dropped) return { key: `depth:fee.dropped.${fee.dropped}`, params: { rule: fee.ruleName } }
  return { key: 'depth:fee.withheld', params: { rule: fee.ruleName } }
}

// ---- credit without the goods -----------------------------------------------------------------------------------------------

type CreditState = 'credited' | 'waiting' | 'allowed' | 'held'

export function creditStateOf(line: Pick<DepthLine, 'creditWithoutReturn'>): CreditState {
  const credit = line.creditWithoutReturn
  return credit.credited ? 'credited' : credit.waiting ? 'waiting' : credit.allowed ? 'allowed' : 'held'
}

/**
 * Why a line may not be credited without the goods (null: it may): the role first (decide, the price grain), offline, then
 * the facts in the order the API checks them (creditWithoutReturnProblems).
 */
export function creditHeldKey(rmaStatus: ReturnStatus, line: DepthLine & { readonly decided: boolean }, can: Pick<ReturnsCan, 'decide' | 'price'>, offline: boolean): Words | null {
  if (!can.decide) return { key: 'held.right.decide' }
  if (!can.price) return { key: 'held.right.price' }
  if (offline) return { key: 'held.offline' }
  const state = creditStateOf(line)
  if (state === 'allowed') return null
  if (state === 'credited') return { key: 'depth:held.credit.done', params: { seq: line.seq } }
  if (state === 'waiting') return { key: 'depth:held.credit.waiting', params: { seq: line.seq } }
  if (rmaStatus === 'REQUESTED') return { key: 'held.authoriseFirst' }
  if (isFinal(rmaStatus)) return { key: `held.final.${rmaStatus}` }
  if (line.decided) return { key: 'depth:held.credit.decided', params: { seq: line.seq } }
  if (line.receivedQuantity > 0) return { key: 'depth:held.credit.arrived', params: { seq: line.seq } }
  if (line.value === null) return { key: 'depth:held.credit.noPrice' }
  return { key: 'depth:held.notNow' }
}

export interface CreditDraft {
  readonly lineId: string
  /** Typed in major units; empty = what its pieces are worth. */
  readonly amount: string
  readonly note: string
}

/** What stops the credit before the ask (keys), from the draft and the preview. */
export function creditDraftProblems(draft: CreditDraft, preview: CreditPreview | null): Words[] {
  const out: Words[] = []
  if (draft.amount.trim() !== '') {
    const amount = minorOf(draft.amount)
    if (amount === null || amount <= 0) out.push({ key: 'depth:credit.problem.amount' })
    else if (typeof preview?.value === 'number' && amount > preview.value) out.push({ key: 'depth:credit.problem.over' })
  }
  if (preview && !preview.ok && out.length === 0) out.push(...creditPreviewWords(preview.problems.map((entry) => entry.path)))
  if (preview?.approval.needed && preview.approval.nobodyElse) out.push({ key: 'depth:credit.problem.nobodyElse' })
  return out
}

/** The preview's problems by place, in our words (the API's sentences are English). */
function creditPreviewWords(paths: readonly string[]): Words[] {
  const keys = new Set(paths.map((path) => (path.endsWith('creditAmount') ? 'depth:credit.problem.amount' : path === 'status' ? 'depth:credit.problem.state' : path.endsWith('lineId') ? 'depth:credit.problem.line' : 'depth:credit.problem.other')))
  return [...keys].map((key) => ({ key }))
}

export const creditBody = (draft: CreditDraft): { creditAmount?: number; note?: string | null } => {
  const amount = draft.amount.trim() === '' ? null : minorOf(draft.amount)
  return { ...(amount !== null ? { creditAmount: amount } : {}), note: draft.note.trim() || null }
}

/** Who the yes waits for: a person we know by name, else Home › Approvals. */
export function approverWords(approval: { readonly approverUserId: string | null }, people: readonly { readonly id: string; readonly name: string }[]): Words {
  const person = approval.approverUserId ? people.find((entry) => entry.id === approval.approverUserId) : null
  return person ? { key: 'depth:credit.waitsFor', params: { name: person.name } } : { key: 'depth:credit.waitsInbox' }
}

// ---- finish (close with a reason) --------------------------------------------------------------------------------------

/** Why the return cannot be closed at all now (null: it can), mirroring the API's finishStateHeld. */
function finishStateKey(rma: Pick<Rma, 'status' | 'lines'>): Words | null {
  if (isFinal(rma.status)) return { key: `held.final.${rma.status}` }
  if (rma.status === 'REQUESTED') return { key: 'held.authoriseFirst' }
  const undecided = rma.lines.filter((line) => line.receivedQuantity > 0 && line.disposition === null)
  return undecided.length > 0 ? { key: 'depth:finish.held.undecided', params: { lines: undecided.map((line) => line.seq).join(', '), count: undecided.length } } : null
}

export interface FinishOption {
  readonly reason: FinishReason
  readonly held: Words | null
}

/** Every finish reason in the dialog's order: the suggested one first, then the allowed, then the held (each with why). */
export function finishOptionsOf(outcomes: Pick<ReturnOutcomes, 'finish'>, rma: Pick<Rma, 'status' | 'lines'>): FinishOption[] {
  const state = finishStateKey(rma)
  const options = FINISH_REASONS.map((reason) => {
    const allowed = outcomes.finish.reasons.find((entry) => entry.reason === reason)?.allowed ?? false
    return { reason, held: allowed ? null : (state ?? { key: `depth:finish.held.${reason}` }) }
  })
  const rank = (option: FinishOption) => (option.reason === outcomes.finish.suggested ? 0 : option.held ? 2 : 1)
  return [...options].sort((a, b) => rank(a) - rank(b) || FINISH_REASONS.indexOf(a.reason) - FINISH_REASONS.indexOf(b.reason))
}

/** What stops the close before the click: a reason picked that fits, words for Other. */
export function finishProblems(reason: FinishReason | '', note: string, options: readonly FinishOption[]): Words | null {
  if (!reason) return { key: 'close.pickReason' }
  const held = options.find((option) => option.reason === reason)?.held
  if (held) return held
  if (reason === 'OTHER' && !note.trim()) return { key: 'close.otherNote' }
  if (note.trim().length > 500) return { key: 'depth:finish.tooLong' }
  return null
}

// ---- the remake asked (B-W2b-346; the decision is the made-to-measure office's) --------------------------------------------

export function remakePhotoWords(outcomes: Pick<ReturnOutcomes, 'remake' | 'lines'>): Words[] {
  return outcomes.remake.photos.map((entry) => ({ key: 'depth:remake.photos', params: { seq: outcomes.lines.find((line) => line.id === entry.lineId)?.seq ?? '—', count: entry.count, needed: entry.needed } }))
}

// ---- the policy of a return (a new one, or one made before a policy was bound) ------------------------------------------------

/** The check in words: the policy, its deadline, the window's warning, the withdrawal (or why there is none to bind). */
export function checkWords(check: PolicyCheck): Words[] {
  const out: Words[] = []
  if (check.policy) out.push({ key: 'depth:check.policy', params: { name: check.policy.name, days: check.policy.windowDays } })
  else out.push({ key: 'depth:check.noPolicy' })
  if (check.goodsDueBy) out.push({ key: 'depth:check.due', params: { date: check.goodsDueBy } })
  if (check.outsideWindow) out.push({ key: 'depth:check.outside', params: { count: check.lines.filter((line) => !line.window.inWindow).length } })
  if (check.withdrawal.asked && !check.withdrawal.applies) out.push({ key: 'depth:check.noWithdrawal' })
  return out
}

export interface PolicyDraft {
  readonly withdrawal: boolean
  readonly reason: string
}

/** What stops binding the policy (keys): no live policy, outside the window without a reason. */
export function policyProblems(check: PolicyCheck | null, draft: PolicyDraft): Words[] {
  if (!check) return [{ key: 'depth:policy.problem.checking' }]
  const out: Words[] = []
  if (!check.policy) out.push({ key: 'depth:policy.problem.none' })
  if (check.outsideWindow && !draft.reason.trim()) out.push({ key: 'depth:policy.problem.reason' })
  if (draft.withdrawal && !check.withdrawal.applies) out.push({ key: 'depth:check.noWithdrawal' })
  return out
}

/** The lines of a return as the policy check reads them (what was sold: the invoice line, else the order line and size). */
export const checkLinesOf = (lines: readonly Pick<ReturnLine, 'invoiceLineId' | 'salesOrderLineId' | 'size'>[]) =>
  lines.map((line) => (line.invoiceLineId ? { invoiceLineId: line.invoiceLineId } : { salesOrderLineId: line.salesOrderLineId, size: line.size }))

/** The policy routes' refusals in our words. */
export function policyRefusal(error: unknown): Words | null {
  if (!isApiError(error)) return null
  const paths = error.issues.map((entry) => issuePath(entry).replace(/\./g, '/'))
  if (paths.some((path) => path.startsWith('body/reason'))) return { key: 'depth:policy.problem.reason' }
  if (paths.some((path) => path.startsWith('body/withdrawal'))) return { key: 'depth:check.noWithdrawal' }
  if (error.kind === 'conflict' && error.code === 'invalid_state') return { key: 'depth:policy.problem.state' }
  return null
}

// ---- the record's ⋯: the papers and the policy ------------------------------------------------------------------------------

const OPEN_FOR_PAPERS: readonly ReturnStatus[] = ['AUTHORISED', 'RECEIVED', 'INSPECTED']

/** Why Print papers is held (null: it may be printed): the code is set once, by a person who manages returns. */
export function printHeld(model: RmaDepthModel, can: ReturnsCan, offline: boolean): Words | null {
  const depth = model.depth.value
  if (!depth) return { key: model.depth.problem ? 'depth:read.failed' : 'quality:common.loading' }
  if (model.printing) return { key: 'quality:common.working' }
  if (offline) return { key: 'held.offline' }
  if (depth.scanCode) return null
  if (!can.manage) return { key: 'depth:held.papers.code' }
  if (!OPEN_FOR_PAPERS.includes(depth.status)) return { key: 'depth:held.papers.state' }
  return null
}

/** Why "Bind the return policy" is held (null: it may be bound): an authorised return that follows the sales settings. */
export function policyHeld(model: RmaDepthModel, can: ReturnsCan, offline: boolean): Words | null {
  const depth = model.depth.value
  if (!depth) return { key: model.depth.problem ? 'depth:read.failed' : 'quality:common.loading' }
  if (!can.manage) return { key: 'held.right.manage' }
  if (offline) return { key: 'held.offline' }
  if (depth.policy.named) return { key: 'depth:held.policy.bound', params: { name: depth.policy.named.name } }
  if (depth.status === 'REQUESTED') return { key: 'held.authoriseFirst' }
  if (depth.status !== 'AUTHORISED') return { key: 'depth:held.policy.state' }
  if (!depth.policy.live) return { key: 'depth:policy.problem.none' }
  return null
}
