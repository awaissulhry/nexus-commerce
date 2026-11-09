import { isApiError, issuePath } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { DeclineReason, LinkAnswer, LinkJob, LinkJobPage } from './api'

/**
 * SCR-196 — Accept a job by link (design links.job; B-W2b-181 on B-W2b-176's API), pure: the answer being chosen, why its
 * button waits, what it sends, the end in words and a refusal as words or a link state. Words are keys of `portal-jobs`
 * (`link.*`); the view translates. No price anywhere (Owner answer C2).
 */

export const LINK_NS = 'portal-jobs'

export type AnswerMode = 'accept' | 'move' | 'decline'

export interface LinkDraft {
  mode: AnswerMode
  proposedDate: string
  reason: string
  declineReason: DeclineReason | ''
  note: string
  typedName: string
}

export const LINK_DRAFT: LinkDraft = { mode: 'accept', proposedDate: '', reason: '', declineReason: '', note: '', typedName: '' }

/** A model's words: a key of the catalogue with its figures (a `date` figure is a day). */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

const blank = (text: string) => text.trim() === ''
const isDay = (text: string) => /^\d{4}-\d{2}-\d{2}$/.test(text)
export const MAX_NAME = 200
export const MAX_TEXT = 2000

/** The job takes no answer now (answered, declined, ended, not sent): why, in words; null: it may be answered. */
export function jobClosed(job: Pick<LinkJob, 'acts' | 'answer' | 'state'>): Words | null {
  if (!job.acts.accept || !job.acts.decline) return null
  if (job.answer.declinedAt) return { key: 'link.closed.declined' }
  if (job.answer.acceptedAt) return { key: 'link.closed.accepted' }
  if (job.state === 'CLOSED' || job.state === 'CANCELLED' || job.state === 'BACK') return { key: 'link.closed.ended' }
  return { key: 'link.closed.notSent' }
}

/** Why the answer's button waits (the job first, then the chosen answer's fields). */
export function answerHeld(draft: LinkDraft, job: Pick<LinkJob, 'acts' | 'answer' | 'state' | 'orderDate' | 'expectedBackDate'>, today: string): Words | null {
  const closed = jobClosed(job)
  if (closed) return closed
  if (draft.mode === 'accept' && job.acts.accept) return { key: 'link.closed.accept' }
  if (draft.mode === 'move' && job.acts.moveDate) return { key: 'link.closed.accept' }
  if (draft.mode === 'decline' && job.acts.decline) return { key: 'link.closed.decline' }
  if (draft.typedName.trim().length > MAX_NAME) return { key: 'link.held.name' }
  if (draft.mode === 'move') {
    if (!isDay(draft.proposedDate)) return { key: 'accept.held.date' }
    if (draft.proposedDate < today || draft.proposedDate < job.orderDate) return { key: 'accept.held.past' }
    if (draft.proposedDate === job.expectedBackDate) return { key: 'accept.held.same' }
    if (blank(draft.reason)) return { key: 'accept.held.reason' }
  }
  if (draft.mode === 'decline') {
    if (!draft.declineReason) return { key: 'decline.held.reason' }
    if (draft.declineReason === 'OTHER' && blank(draft.note)) return { key: 'decline.held.note' }
  }
  return null
}

export function answerOf(draft: LinkDraft): LinkAnswer {
  const typedName = blank(draft.typedName) ? null : draft.typedName.trim()
  if (draft.mode === 'move') return { kind: 'move', typedName, proposedDate: draft.proposedDate, reason: draft.reason.trim() }
  if (draft.mode === 'decline') return { kind: 'decline', typedName, reason: draft.declineReason as DeclineReason, note: blank(draft.note) ? null : draft.note.trim() }
  return { kind: 'accept', typedName }
}

/** The end of this page's answer, in our words (the API's `done` sentence is not read). */
export function endOf(answer: LinkAnswer, page: Pick<LinkJobPage, 'job'>): { tone: 'success' | 'neutral'; title: Words; body: Words } {
  if (answer.kind === 'decline') return { tone: 'neutral', title: { key: 'link.end.declinedTitle' }, body: { key: 'link.end.declined' } }
  if (answer.kind === 'move') return { tone: 'success', title: { key: 'link.end.acceptedTitle' }, body: { key: 'end.acceptedMoved', params: { date: answer.proposedDate } } }
  const kitDay = page.job.kit.sentOn.at(-1) ?? null
  return { tone: 'success', title: { key: 'link.end.acceptedTitle' }, body: kitDay ? { key: 'end.acceptedKit', params: { date: kitDay } } : { key: 'end.accepted' } }
}

/** A refused answer: words, and the link state when the link itself is gone. */
export function answerRefusal(error: unknown): { words: Words; link?: LinkState; reload?: boolean } {
  if (!isApiError(error)) return { words: { key: 'problem.write' } }
  switch (error.kind) {
    case 'not_found':
      return { words: { key: 'problem.gone' }, link: 'unavailable' }
    case 'forbidden':
      return { words: { key: 'problem.forbidden' }, link: 'wrong_person' }
    case 'conflict':
      return { words: { key: 'problem.changed' }, reload: true }
    case 'invalid': {
      const paths = error.issues.map((issue) => issuePath(issue))
      if (paths.some((path) => path.includes('proposedDate'))) return { words: { key: 'refused.proposedDate' } }
      if (paths.some((path) => path.includes('typedName'))) return { words: { key: 'link.held.name' } }
      if (paths.some((path) => path.includes('note'))) return { words: { key: 'refused.note' } }
      if (paths.some((path) => path.includes('reason'))) return { words: { key: 'refused.reason' } }
      return { words: { key: 'problem.invalid' } }
    }
    case 'rate_limited':
      return { words: { key: 'problem.slowDown' } }
    case 'unavailable':
      return { words: { key: 'problem.offline' } }
    default:
      return { words: { key: 'problem.write' } }
  }
}

/** A failed read as the link state the frame shows. */
export function readRefusal(error: unknown): LinkState {
  if (isApiError(error) && error.kind === 'not_found') return 'unavailable'
  if (isApiError(error) && error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}
