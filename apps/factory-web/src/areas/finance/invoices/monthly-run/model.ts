import { isApiError, issuePath } from '../../../../lib/api/errors'
import { checkOf, type FinanceAbilities, type Phrase } from '../../_shared/model'
import { depthProblem, scoped, type DepthProblem } from '../test-mode/depth'
import type { Candidate, IssuedRun, Run, RunCustomer } from './api'

/**
 * The monthly invoice run's rules, pure (B-W2b-417; design finance.invoices pop:monthly-run "Customers with deferred
 * invoicing; preview per customer (DDTs, totals); CheckList per invoice", action "Issue and send n invoices"; Owner answer
 * P1: a typed phrase for the monthly run): the months offered, who may be picked, each customer's state in the preview, what
 * holds each step, the typed phrase, and the answers in words (`finance-invoices-depth`).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** The phases of the one dialog: pick customers → the preview → the confirm with the typed phrase → what was done. */
export type RunPhase = 'pick' | 'preview' | 'confirm' | 'done'

/** The months a run may take: two before this one, the one before (the default: deferred invoices are issued by the 15th), this one. */
export function runMonths(today: string): { months: string[]; preset: string } {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const shift = (back: number) => {
    const index = year * 12 + (month - 1) - back
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
  }
  return { months: [shift(2), shift(1), shift(0)], preset: shift(1) }
}

/** Why a customer cannot be picked: another live preview of the month picks it already. */
export const candidateHeld = (candidate: Pick<Candidate, 'inRunId'>, runId: string | null = null): Phrase | null => (candidate.inRunId && candidate.inRunId !== runId ? phrase('run.pick.inOtherRun') : null)

/** The customers picked by default: every one that may be picked (the office takes some out). */
export const presetPicked = (candidates: readonly Candidate[], runId: string | null = null): string[] => candidates.filter((candidate) => candidateHeld(candidate, runId) === null).map((candidate) => candidate.partyId)

/** Why "Create preview" (or "Use these customers") is held. */
export function pickHeld(input: { picked: number; can: FinanceAbilities; busy: boolean; max: number }): Phrase | null {
  if (!input.can.manageInvoices) return phrase('held.noManage')
  if (input.busy) return phrase('held.busy')
  if (input.picked === 0) return phrase('run.held.pickOne')
  if (input.picked > input.max) return phrase('run.held.tooMany', { max: input.max })
  return null
}

export type CustomerState = 'ISSUED' | 'READY' | 'HELD' | 'NONE'

/** A customer's line in the preview: issued already, ready to issue, held by its checks, or no invoice made. */
export function customerStateOf(customer: Pick<RunCustomer, 'invoice'>): CustomerState {
  const invoice = customer.invoice
  if (!invoice) return 'NONE'
  if (invoice.status !== 'DRAFT') return 'ISSUED'
  return invoice.ready ? 'READY' : 'HELD'
}

export const CUSTOMER_TONE: Record<CustomerState, 'success' | 'info' | 'warning' | 'neutral'> = { ISSUED: 'success', READY: 'info', HELD: 'warning', NONE: 'neutral' }

/** Why "Issue and send n invoices" is held: the right, an issued run, nothing ready, busy. */
export function issueHeld(run: Pick<Run, 'status' | 'counts' | 'can'>, can: FinanceAbilities, busy: boolean): Phrase | null {
  if (!can.issueInvoices) return phrase('held.noIssue')
  if (run.status === 'ISSUED') return phrase('run.held.issued')
  if (busy) return phrase('held.busy')
  if (run.counts.ready === 0) return phrase('run.held.noneReady')
  if (!run.can.issue) return phrase('run.held.cannot')
  return null
}

/** Why the preview's "Change customers" and "Delete preview" are held. */
export function changeHeld(run: Pick<Run, 'status' | 'can'>, can: FinanceAbilities, verb: 'pick' | 'delete'): Phrase | null {
  if (!can.manageInvoices) return phrase('held.noManage')
  if (run.status === 'ISSUED') return phrase('run.held.issued')
  if (!run.can[verb]) return phrase(verb === 'pick' ? 'run.held.cannotPick' : 'run.held.cannotDelete')
  return null
}

/** A draft's checks as the finance words, each once (two problems of one kind — the company's VAT number and its regime — read as one line). */
export const checkWordsOf = (problems: ReadonlyArray<{ code: string; path: string }>): string[] => [...new Set(problems.map((problem) => checkOf(problem).key))]

/** The phrase typed to issue the run (Owner answer P1): the month, as the run names it. */
export const confirmPhraseOf = (run: Pick<Run, 'month'>): string => run.month

/** The issue's answer in words: how many issued and sent, sent later, held back. */
export function issuedWords(answer: Pick<IssuedRun, 'issued' | 'held'>): Phrase[] {
  const sent = answer.issued.filter((entry) => entry.sent).length
  const notSent = answer.issued.length - sent
  const words: Phrase[] = [phrase('run.done.issued', { count: answer.issued.length })]
  if (sent > 0) words.push(phrase('run.done.sent', { count: sent }))
  if (notSent > 0) words.push(phrase('run.done.notSent', { count: notSent }))
  if (answer.held.length > 0) words.push(phrase('run.done.held', { count: answer.held.length }))
  return words
}

/** The refusals of the run in words: another preview of the month, an empty run, moved meanwhile, the rest by kind. */
export function runProblem(error: unknown): DepthProblem {
  if (isApiError(error) && error.kind === 'conflict') {
    const paths = error.issues.map(issuePath)
    if (paths.some((path) => path.startsWith('body/partyIds'))) return { key: scoped('run.problem.otherRun'), reload: true }
    if (!paths.some((path) => path.split(/[./]/).includes('version'))) return { key: scoped('run.problem.state'), reload: true }
  }
  return depthProblem(error)
}
