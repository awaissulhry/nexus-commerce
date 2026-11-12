import { DEPTH_LIMITS } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { ReturnsCan, Words } from '../model'
import type { Estimate, EstimateAction, EstimateLine, EstimateLineKind, Estimates, LineBody } from './api'

/**
 * The rules of a repair's Estimate tab without a screen (B-W2b-352; design sales.returns › Repair order › Estimate, SAL-387):
 * which revision is shown, why each step is held (OUR words from the estimate's facts — the API's `held` is English and
 * never shown; each mirrors factory-domain sales/repairs-depth's `estimateActions`, `draftHeld`, `workHeldByEstimate`), what
 * a cell or a new line sends (decimal strings, as the API wants them), and the customer's decision in words. Pure. Keys are
 * `depth:` keys (catalogue `sales-returns-depth`), the W2a catalogue's otherwise.
 */

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/
const PRICE = /^\d{1,12}(\.\d{1,6})?$/

/** A typed decimal ("1,5" or "1.5") as the API's string, or null when it is not one (empty → null too). */
export function decimalOf(text: string, kind: 'quantity' | 'price'): string | null {
  const value = text.trim().replace(',', '.')
  if (value === '') return null
  const pattern = kind === 'quantity' ? QUANTITY : PRICE
  if (!pattern.test(value)) return null
  return value
}

/** Whole minutes of work, 1 to the API's limit, or null. */
export function minutesOf(text: string): number | null {
  const value = text.trim()
  if (!/^\d{1,6}$/.test(value)) return null
  const minutes = Number(value)
  return minutes >= 1 && minutes <= DEPTH_LIMITS.minutes ? minutes : null
}

/** The revision shown: the one asked (by id) when it exists, else the newest. */
export function shownEstimate(answer: Pick<Estimates, 'estimates'> | null, id: string | null): Estimate | null {
  if (!answer || answer.estimates.length === 0) return null
  return answer.estimates.find((estimate) => estimate.id === id) ?? answer.estimates[0]!
}

/** The newest revision that is not withdrawn: the one that binds the work (SENT holds it, DECLINED refuses it). */
const bindingEstimate = (answer: Pick<Estimates, 'estimates'> | null): Estimate | null => answer?.estimates.find((estimate) => estimate.status !== 'WITHDRAWN') ?? null

const allowed = (estimate: Pick<Estimate, 'actions'>, action: EstimateAction): boolean => estimate.actions.find((entry) => entry.action === action)?.allowed ?? false

/** Why a step of a revision is held (null: it may be done): the role first, offline, then the estimate's facts. */
export function estimateHeld(action: EstimateAction, estimate: Estimate, answer: Pick<Estimates, 'seesPrices' | 'repair' | 'estimates'>, can: Pick<ReturnsCan, 'repairsManage'>, offline: boolean, today: string): Words | null {
  if (!can.repairsManage) return { key: 'held.right.repairsManage' }
  if (!answer.seesPrices) return { key: 'depth:estimate.held.prices' }
  if (offline) return { key: 'held.offline' }
  if (allowed(estimate, action)) return null
  const newest = answer.estimates[0]?.id === estimate.id
  const stage = answer.repair.stage
  const final = stage === 'SHIPPED' || stage === 'CANCELLED'
  switch (action) {
    case 'edit':
      if (estimate.status !== 'DRAFT') return { key: `depth:estimate.held.edit.${estimate.status}` }
      return final ? { key: `held.repairFinal.${stage}` } : { key: 'depth:estimate.held.stage' }
    case 'send':
      if (estimate.status !== 'DRAFT') return { key: 'depth:estimate.held.sentAlready' }
      if (estimate.lines.length === 0) return { key: 'depth:estimate.held.noLines' }
      if (stage === 'AWAITING_GOODS') return { key: 'depth:estimate.held.garmentFirst' }
      if (estimate.validUntil && estimate.validUntil < today) return { key: 'depth:estimate.held.expired' }
      return final ? { key: `held.repairFinal.${stage}` } : { key: 'depth:estimate.held.stage' }
    case 'answer':
      if (estimate.status !== 'SENT') return { key: 'depth:estimate.held.notSent' }
      if (estimate.validUntil && estimate.validUntil < today) return { key: 'depth:estimate.held.expired' }
      return final ? { key: `held.repairFinal.${stage}` } : { key: 'depth:estimate.held.stage' }
    case 'withdraw':
      return estimate.status === 'DRAFT' || estimate.status === 'SENT' ? (final ? { key: `held.repairFinal.${stage}` } : { key: 'held.notNow' }) : { key: `depth:estimate.held.edit.${estimate.status}` }
    case 'revise':
      return newest ? { key: 'held.notNow' } : { key: 'depth:estimate.held.notNewest' }
  }
}

/** Why "New estimate" is held (null: it may be made); `replaces` says a sent one is withdrawn by it. */
export function newEstimateHeld(answer: Pick<Estimates, 'newEstimate' | 'estimates' | 'seesPrices' | 'repair'>, can: Pick<ReturnsCan, 'repairsManage'>, offline: boolean): Words | null {
  if (!can.repairsManage) return { key: 'held.right.repairsManage' }
  if (!answer.seesPrices) return { key: 'depth:estimate.held.prices' }
  if (offline) return { key: 'held.offline' }
  if (answer.newEstimate.allowed) return null
  const stage = answer.repair.stage
  if (stage === 'SHIPPED' || stage === 'CANCELLED') return { key: `held.repairFinal.${stage}` }
  const draft = answer.estimates.find((estimate) => estimate.status === 'DRAFT')
  if (draft) return { key: 'depth:estimate.held.draftOpen', params: { revision: draft.revision } }
  return { key: 'depth:estimate.held.stage' }
}

/**
 * The work the estimate holds, in words (null: none): a sent estimate waits for the customer's answer, a declined one
 * refuses approval and the repair (the API's `workHeld` says whether; this says why in our words).
 */
export function workHeldWords(answer: Pick<Estimates, 'workHeld' | 'estimates'> | null, move: 'approve' | 'startRepair'): Words | null {
  if (!answer || !answer.workHeld[move]) return null
  const binding = bindingEstimate(answer)
  if (binding?.status === 'SENT') return { key: 'depth:estimate.work.waiting', params: { revision: binding.revision } }
  if (binding?.status === 'DECLINED') return { key: 'depth:estimate.work.declined', params: { revision: binding.revision } }
  return { key: 'depth:estimate.work.held' }
}

/** The customer's decision in words (null: none yet): accepted or declined, how (portal, link, recorded by the office). */
export function decisionWords(estimate: Pick<Estimate, 'status' | 'answeredVia' | 'answeredByName'>): Words | null {
  if (estimate.status !== 'ACCEPTED' && estimate.status !== 'DECLINED') return null
  const via = estimate.answeredVia ?? 'OFFICE'
  return { key: `depth:estimate.decision.${estimate.status}.${via}`, params: { name: estimate.answeredByName ?? '—' } }
}

// ---- a line: the cells and a new one ---------------------------------------------------------------------------------------

export type LineField = 'description' | 'quantity' | 'unitPrice' | 'minutes' | 'unitCost'

/** What a cell's typed text sends (null: not valid — the cell says why with `cellProblem`). */
export function cellBody(field: LineField, text: string, line: Pick<EstimateLine, 'kind'>): LineBody | null {
  switch (field) {
    case 'description': {
      const value = text.trim()
      return value && value.length <= DEPTH_LIMITS.description && !/[\r\n]/.test(value) ? { description: value } : null
    }
    case 'quantity': {
      const value = decimalOf(text, 'quantity')
      return value && Number(value) > 0 ? { quantity: value } : null
    }
    case 'unitPrice': {
      const value = decimalOf(text, 'price')
      return value !== null ? { unitPrice: value } : null
    }
    case 'minutes': {
      if (line.kind !== 'LABOUR') return null
      const value = minutesOf(text)
      return value !== null ? { minutes: value } : null
    }
    case 'unitCost': {
      if (text.trim() === '') return { unitCost: null }
      const value = decimalOf(text, 'price')
      return value !== null ? { unitCost: value } : null
    }
  }
}

/** Why a cell's text is refused, in words. */
export function cellProblem(field: LineField): Words {
  return { key: `depth:estimate.problem.${field}` }
}

export interface LineDraft {
  readonly kind: EstimateLineKind
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly minutes: string
  readonly unitCost: string
}

export const blankLine = (kind: EstimateLineKind): LineDraft => ({ kind, description: '', quantity: '1', unitPrice: '', minutes: '', unitCost: '' })

/** What stops a new line, field by field (keys), in the order the form reads. */
export function lineDraftProblems(draft: LineDraft): { field: LineField; words: Words }[] {
  const out: { field: LineField; words: Words }[] = []
  if (!cellBody('description', draft.description, draft)) out.push({ field: 'description', words: cellProblem('description') })
  if (!cellBody('quantity', draft.quantity, draft)) out.push({ field: 'quantity', words: cellProblem('quantity') })
  if (draft.kind === 'LABOUR' && !cellBody('minutes', draft.minutes, draft)) out.push({ field: 'minutes', words: cellProblem('minutes') })
  if (!cellBody('unitPrice', draft.unitPrice, draft)) out.push({ field: 'unitPrice', words: cellProblem('unitPrice') })
  if (draft.unitCost.trim() !== '' && !cellBody('unitCost', draft.unitCost, draft)) out.push({ field: 'unitCost', words: cellProblem('unitCost') })
  return out
}

/** A new line's body (the cost only with the cost grain). */
export function lineBody(draft: LineDraft, seesCosts: boolean): LineBody {
  return {
    kind: draft.kind,
    description: draft.description.trim(),
    quantity: decimalOf(draft.quantity, 'quantity') ?? draft.quantity.trim(),
    unitPrice: decimalOf(draft.unitPrice, 'price') ?? draft.unitPrice.trim(),
    ...(draft.kind === 'LABOUR' ? { minutes: minutesOf(draft.minutes) } : {}),
    ...(seesCosts && draft.unitCost.trim() !== '' ? { unitCost: decimalOf(draft.unitCost, 'price') } : {}),
  }
}

// ---- the customer's answer as the office heard it ----------------------------------------------------------------------

export interface AnswerDraft {
  readonly answer: 'ACCEPTED' | 'DECLINED' | ''
  readonly how: string
  readonly name: string
  readonly declineReason: string
}

export const BLANK_ANSWER: AnswerDraft = Object.freeze({ answer: '', how: '', name: '', declineReason: '' })

export function answerProblems(draft: AnswerDraft): Words[] {
  const out: Words[] = []
  if (!draft.answer) out.push({ key: 'depth:estimate.answer.problem.answer' })
  if (!draft.how.trim()) out.push({ key: 'depth:estimate.answer.problem.how' })
  if (draft.answer === 'DECLINED' && !draft.declineReason.trim()) out.push({ key: 'depth:estimate.answer.problem.reason' })
  return out
}

// ---- the terms -----------------------------------------------------------------------------------------------------------

export interface TermsDraft {
  readonly validUntil: string
  readonly customerNote: string
  readonly internalNote: string
}

export const termsOf = (estimate: Pick<Estimate, 'validUntil' | 'customerNote' | 'internalNote'>): TermsDraft => ({ validUntil: estimate.validUntil ?? '', customerNote: estimate.customerNote ?? '', internalNote: estimate.internalNote ?? '' })

export function termsProblems(draft: TermsDraft, today: string): Words[] {
  const out: Words[] = []
  if (draft.validUntil && draft.validUntil < today) out.push({ key: 'depth:estimate.terms.problem.past' })
  if (draft.customerNote.length > DEPTH_LIMITS.customerNote) out.push({ key: 'depth:estimate.terms.problem.long' })
  if (draft.internalNote.length > DEPTH_LIMITS.internalNote) out.push({ key: 'depth:estimate.terms.problem.long' })
  return out
}

/** What a terms save sends: the customer's terms only while a draft; the internal note any time. */
export function termsBody(draft: TermsDraft, estimate: Pick<Estimate, 'status'>): { validUntil?: string | null; customerNote?: string | null; internalNote: string | null } {
  const text = (value: string) => value.trim() || null
  return estimate.status === 'DRAFT' ? { validUntil: draft.validUntil || null, customerNote: text(draft.customerNote), internalNote: text(draft.internalNote) } : { internalNote: text(draft.internalNote) }
}

/** An estimate route's refusal in our words: a field by its place, a stale version, a state, else W2a's kinds. */
export function estimateRefusal(error: unknown): Words | null {
  if (!isApiError(error)) return null
  const paths = error.issues.map((entry) => issuePath(entry).replace(/\./g, '/'))
  for (const field of ['description', 'quantity', 'unitPrice', 'minutes', 'unitCost'] as const) if (paths.some((path) => path.endsWith(field))) return cellProblem(field)
  if (paths.some((path) => path.endsWith('validUntil'))) return { key: 'depth:estimate.terms.problem.past' }
  if (paths.some((path) => path.endsWith('how'))) return { key: 'depth:estimate.answer.problem.how' }
  if (paths.some((path) => path.endsWith('declineReason'))) return { key: 'depth:estimate.answer.problem.reason' }
  if (error.kind === 'forbidden') return { key: 'depth:estimate.held.prices' }
  return null
}
