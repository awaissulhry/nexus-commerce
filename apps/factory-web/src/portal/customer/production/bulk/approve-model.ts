import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { isPdf, isPicture } from '../../documents/preview/model'
import type { Tone } from '../model'
import type { ApprovalsToReview, ApproveManyAnswer, ApproveRowCode, ReviewApproval } from './api'
import { APPROVE_ROW_CODES } from './api'

/**
 * F-PR-23b — Approve N on My production (production plan §3 "Bulk 'Approve' cannot be undone; the dialog says so before Send";
 * lead pick L26; 17-web-r2 §1.5; walls PW-12, PW-15), pure: one list of the approvals waiting on the picked orders (B-PR-46b), each
 * with its photo or PDF, ticked one by one; a row this person may not answer is held with why (a price: your buyer; a named
 * approver: Waiting for <name>; a revised order, a concession or a signature: "Open it to answer"); ONE typed name signs every
 * ticked one; there is no Undo, and the dialog says so before Send; after Send one result per approval.
 *
 * The wall: every row is one of the customer's own requests about its own picked orders (the API's partner read); an order is
 * named by the customer's own name from its My production row (their PO, "Your order 12"), never the office's number.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
const say = (words: { readonly it: string; readonly en: string }, locale: Locale): string => words[locale]

export interface ApproveFile {
  readonly id: string
  readonly name: string
  readonly picture: boolean
  readonly pdf: boolean
}

export interface ApproveRow {
  readonly id: string
  /** What it is about ("Sample · PP · BX-200"), in the person's language. */
  readonly label: string
  /** The picked orders it waits on, by their own names. */
  readonly orders: string
  readonly question: string
  readonly dueAt: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly files: readonly ApproveFile[]
  /** Why it cannot be ticked here (the API's words, in the person's language), or null: it may. */
  readonly held: string | null
}

/**
 * The review list's rows: the API's order (the soonest due first), each order named by the customer's own name (`nameOf`, the My
 * production row's; an order of the answer the list does not hold reads "your order").
 */
export function approveRowsOf(list: Pick<ApprovalsToReview, 'items'>, nameOf: (orderId: string) => string | null, locale: Locale, t: Translate): ApproveRow[] {
  return list.items.map((item: ReviewApproval) => ({
    id: item.requestId,
    label: say(item.words, locale),
    orders: item.orders.map((order) => nameOf(order.orderId) ?? order.customerRef ?? t('row.noName')).join(', '),
    question: item.question,
    dueAt: item.dueAt,
    facts: item.facts,
    files: item.files.map((file) => ({ id: file.id, name: file.originalName, picture: isPicture(file.contentType), pdf: isPdf(file.contentType) })),
    held: item.may.approve ? null : (item.may.held ?? t('bulk.approve.heldOther')),
  }))
}

/** Only rows that may be ticked stay ticked (a list read again keeps what still may). */
export const keepTicked = (ticked: readonly string[], rows: readonly ApproveRow[]): string[] => ticked.filter((id) => rows.some((row) => row.id === id && row.held === null))

export interface ApproveFacts {
  readonly preview: boolean
  readonly offline: boolean
  /** portal.approve: the role answers approvals (else every row is read only). */
  readonly mayAnswer: boolean
  readonly sending: boolean
}

/** Why Approve waits (a key of `portal-production`): the role, a preview, no connection, sending, nothing ticked; null: it sends. */
export function approveHeldOf(ticked: readonly string[], facts: ApproveFacts, t: Translate): string | null {
  if (facts.preview) return t('held.preview')
  if (!facts.mayAnswer) return t('bulk.approve.heldRole')
  if (facts.offline) return t('held.offline')
  if (facts.sending) return t('bulk.held.busy')
  if (ticked.length === 0) return t('bulk.approve.heldNone')
  return null
}

/** What Approve sends: every ticked row at the version read (a request that changed since is not approved: "read it again"). */
export function approveBodyOf(list: Pick<ApprovalsToReview, 'items'>, ticked: readonly string[], typedName: string): { items: { requestId: string; version: number }[]; typedName: string } {
  const items = list.items.filter((item) => ticked.includes(item.requestId)).map((item) => ({ requestId: item.requestId, version: item.version }))
  return { items, typedName: typedName.trim() }
}

export interface ApproveResult {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly words: string
  readonly tone: Tone
}

const codeOf = (value: string): ApproveRowCode | null => ((APPROVE_ROW_CODES as readonly string[]).includes(value) ? (value as ApproveRowCode) : null)

/** One result per ticked approval: approved, or why not (the API's words); one not in the answer is "not found". */
export function approveResultsOf(rows: readonly ApproveRow[], ticked: readonly string[], answer: ApproveManyAnswer, locale: Locale, t: Translate): ApproveResult[] {
  return rows
    .filter((row) => ticked.includes(row.id))
    .map((row): ApproveResult => {
      const result = answer.results.find((entry) => entry.requestId === row.id)
      if (!result) return { id: row.id, label: row.label, ok: false, words: t('bulk.approve.notFound'), tone: 'danger' }
      if (result.done) return { id: row.id, label: row.label, ok: true, words: say(result.words, locale), tone: 'success' }
      return { id: row.id, label: row.label, ok: false, words: say(result.words, locale), tone: 'warning' }
    })
}

/**
 * Approve N refused as a whole (409: nothing approved; each request's code at `body/items/<i>/<code>`), or not sent: the rows in our
 * words, or the problem (Approve tries again with the same key: nothing is answered twice).
 */
export function approveRefusalOf(rows: readonly ApproveRow[], ticked: readonly string[], error: unknown, t: Translate): { results: ApproveResult[] | null; problem: string | null } {
  if (!isApiError(error) || error.kind === 'unavailable') return { results: null, problem: t('bulk.approve.unavailable') }
  if (error.kind === 'forbidden') return { results: null, problem: t('bulk.approve.heldRole') }
  if (error.kind === 'invalid') return { results: null, problem: t('bulk.approve.invalid') }
  if (error.kind === 'conflict' || error.kind === 'not_found') {
    const sent = rows.filter((row) => ticked.includes(row.id))
    const byIndex = new Map<number, ApproveRowCode>()
    for (const issue of error.issues) {
      const parts = issuePath(issue).split('/')
      const at = Number(parts[2])
      const code = codeOf(parts[3] ?? '')
      if (Number.isInteger(at) && code) byIndex.set(at, code)
    }
    const results = sent.map((row, index): ApproveResult => {
      const code = byIndex.get(index)
      return { id: row.id, label: row.label, ok: false, words: code ? t(`bulk.approve.code.${code}`) : error.kind === 'not_found' ? t('bulk.approve.notFound') : t('bulk.approve.code.NOT_DONE'), tone: 'warning' }
    })
    return { results, problem: null }
  }
  return { results: null, problem: t('bulk.approve.unavailable') }
}

/** The Done line: "2 approved · 1 not approved". */
export function approveDoneLineOf(results: readonly ApproveResult[], t: Translate): { line: string; tone: 'success' | 'warning' | 'danger' } {
  const ok = results.filter((result) => result.ok).length
  const not = results.length - ok
  const parts = [...(ok > 0 ? [t('bulk.approve.doneOk', { count: ok })] : []), ...(not > 0 ? [t('bulk.approve.doneNot', { count: not })] : [])]
  return { line: parts.join(' · ') || t('bulk.approve.doneNone'), tone: ok === 0 ? 'danger' : not > 0 ? 'warning' : 'success' }
}

/** The review list could not be read: none of the picked orders is its own (404), or no answer. */
export function approveReadProblemOf(error: unknown, t: Translate): string {
  if (isApiError(error) && error.kind === 'not_found') return t('bulk.approve.readNotFound')
  if (isApiError(error) && error.kind === 'forbidden') return t('bulk.approve.heldRole')
  return t('bulk.approve.readFailed')
}
