import type { PhotoMark } from '@nexus/ui/components/PhotoCapture/index'
import type { ApprovalKind } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { ApprovalFile, ApprovalPage, LinkDecision, MarkupBody, RevisedOrder } from './api'

/**
 * SCR-198 — Approve (design links.approve; COL-064, SAL-222, SAL-294, QHS-085): what the page shows, from the container
 * (Approve.tsx). The link's own states first (it did not open, the wrong person), then the request's: open (what we ask,
 * the kind's panel, your decision), held (answered, withdrawn, past due, the record moved on: the API's words), decided
 * (the end with what happens next). Money only in a revised order's panel (the link's price grain: the party's own order).
 * Pure, so the tests hold it.
 */

/** The limits the API checks (factory-domain approvals-out/rules APPROVAL_LIMITS; that module is server-only). */
export const ANSWER_LIMITS = Object.freeze({ answer: 4000, typedName: 200, typedNameMin: 2, note: 2000, marks: 200 })

/** The kind's own panel on the page (design sections revised-order, proof, concession, sample). */
export type KindPanel = 'revised-order' | 'proof' | 'concession' | 'sample' | 'signature'

export function panelOf(kind: ApprovalKind): KindPanel {
  switch (kind) {
    case 'REVISED_ORDER':
      return 'revised-order'
    case 'PROOF':
      return 'proof'
    case 'CONCESSION':
      return 'concession'
    case 'SIGNATURE':
      return 'signature'
    default:
      return 'sample'
  }
}

/** The decisions the page offers, in order (design: Approve · Approve with comments where the kind allows · Reject). */
export function decisionsOf(page: Pick<ApprovalPage, 'may'>): LinkDecision[] {
  return page.may.withChanges ? ['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'] : ['APPROVED', 'REFUSED']
}

/** The comment's role for a decision: needed with changes and with a refusal (the API refuses either without words). */
export const commentNeeded = (decision: LinkDecision | null): boolean => decision === 'APPROVED_WITH_CHANGES' || decision === 'REFUSED'

/**
 * Why the signed answer cannot go yet (a message key of `link-approve`), in the order the person fixes them: the
 * decision, then the comment. The typed name is the SignBlock's own check.
 */
export function answerProblem(decision: LinkDecision | null, comment: string): { key: string; field: 'decision' | 'comment' } | null {
  if (decision === null) return { key: 'decision.problem.choose', field: 'decision' }
  const words = comment.trim()
  if (decision === 'REFUSED' && words === '') return { key: 'decision.problem.why', field: 'comment' }
  if (decision === 'APPROVED_WITH_CHANGES' && words === '') return { key: 'decision.problem.what', field: 'comment' }
  if (words.length > ANSWER_LIMITS.answer) return { key: 'decision.problem.long', field: 'comment' }
  return null
}

/** The sign button's words for the decision chosen. */
export const signLabelKey = (decision: LinkDecision | null): string => (decision === null ? 'sign.choose' : `sign.go.${decision}`)

export const isPicture = (contentType: string): boolean => /^image\/(png|jpe?g|webp|gif)$/i.test(contentType.split(';')[0]!.trim())
export const isPdf = (contentType: string): boolean => contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf'

/** A file the person may mark (a picture, or a page of a PDF). */
export const markable = (file: Pick<ApprovalFile, 'contentType'>): 'picture' | 'pdf' | null => (isPicture(file.contentType) ? 'picture' : isPdf(file.contentType) ? 'pdf' : null)

/** A file as the page holds it: a picture's address or a PDF's bytes (null while read), `problem` when unreadable. */
export interface FileShown {
  src: string | Uint8Array | null
  problem: boolean
}

/** The marks the person drew on ONE of the request's files (sent with the answer; an overlay, nothing uploaded). */
export interface MarkupDraft {
  fileId: string
  /** The page of a PDF; null on a picture. */
  page: number | null
  marks: readonly PhotoMark[]
  note: string
}

/** "Mark the photo" open on one file: the picture (or the PDF page drawn as one) and the note being written. */
export interface MarkingState {
  fileId: string
  name: string
  target: 'picture' | 'pdf'
  page: number
  /** A PDF's page count once read. */
  pages: number | null
  image: { status: 'loading' } | { status: 'ready'; src: string; width: number; height: number } | { status: 'failed' }
  note: string
  /** The marks already drawn on this file and page (Edit). */
  marks: readonly PhotoMark[]
}

export interface ApproveViewModel {
  /** The link itself: `valid` once the request was read (then `page` says the request's state). */
  link: LinkState
  page: ApprovalPage | null
  /** Each file's bytes as the page shows them (absent: still loading). */
  files: Readonly<Record<string, FileShown>>
  /** The file open full size (null: none). */
  open: string | null
  decision: LinkDecision | null
  comment: string
  markup: MarkupDraft | null
  marking: MarkingState | null
  answer: 'idle' | 'busy' | 'done'
  /** The server refused the answer, or the page holds it: a message key of `link-approve`. */
  problem: string | null
  /** Where the page's own check points (the decision radios, the comment). */
  field: 'decision' | 'comment' | null
  /** The site's zone. */
  timeZone?: string
  /** "Now" for the countdown on a server render (design cases). */
  now?: number
}

export interface ApproveActions {
  onRetry?: () => void
  onDecision?: (decision: LinkDecision) => void
  onComment?: (comment: string) => void
  onSign?: (typedName: string) => void
  onOpen?: (fileId: string | null) => void
  onRetryFile?: (fileId: string) => void
  onMark?: (fileId: string) => void
  onMarkPage?: (page: number) => void
  onMarkNote?: (note: string) => void
  onMarkSave?: (marks: readonly PhotoMark[]) => void
  onMarkClose?: () => void
  onMarkRemove?: () => void
}

/** The answer's markup for the API (null without marks). */
export function markupBodyOf(draft: MarkupDraft | null): MarkupBody | null {
  if (!draft || draft.marks.length === 0) return null
  const note = draft.note.trim()
  return { fileId: draft.fileId, page: draft.page, shapes: draft.marks.map((mark) => ({ ...mark })), note: note === '' ? null : note.slice(0, ANSWER_LIMITS.note) }
}

/** Why "Add to my comment" is held in Mark the photo (a message key), null when it may go. */
export const markSaveHeld = (marks: readonly PhotoMark[]): string | null => (marks.length === 0 ? 'mark.held.none' : marks.length > ANSWER_LIMITS.marks ? 'mark.held.many' : null)

/** A refused answer in this page's words, and the link state it means when it is the link's (used, withdrawn, gone). */
export function answerRefusal(error: unknown): { key: string; link?: LinkState; reload?: boolean } {
  if (!isApiError(error)) return { key: 'problem.internal' }
  switch (error.kind) {
    case 'not_found':
      return { key: 'problem.gone', link: 'unavailable' }
    case 'forbidden':
      return { key: 'problem.wrongPerson', link: 'wrong_person' }
    case 'conflict':
      return { key: 'problem.changed', reload: true }
    case 'invalid':
      return { key: error.issues.some((issue) => /typedName/.test(issuePath(issue))) ? 'problem.name' : 'problem.invalid' }
    case 'rate_limited':
      return { key: 'problem.rateLimited' }
    case 'unavailable':
      return { key: 'problem.unavailable' }
    default:
      return { key: 'problem.internal' }
  }
}

/** A failed read as the link state the frame shows. */
export function readRefusal(error: unknown): LinkState {
  if (isApiError(error) && error.kind === 'not_found') return 'unavailable'
  if (isApiError(error) && error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}

/** The end's tone: an approval succeeds, a refusal is said plainly. */
export const decidedTone = (status: ApprovalPage['request']['status']): 'success' | 'warning' | 'neutral' => (status === 'REFUSED' ? 'warning' : status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES' ? 'success' : 'neutral')

/** The page is a request that was answered (its end), whether by this page just now or earlier. */
export const isDecided = (page: ApprovalPage | null): boolean => page !== null && page.request.decided !== null

// ── the revised order (SAL-222) ─────────────────────────────────────────────────────────────────────────────────────

/** The sizes that moved on a line, "S 4 → 6", in the order the order lists them (unchanged sizes left out). */
export function sizeMoves(line: RevisedOrder['lines'][number]): Array<{ size: string; before: number; after: number }> {
  return line.sizes.filter((size) => size.before !== size.after)
}

/** A line's prices old → new (null without the grain or when the API gives none). */
export function linePrices(order: RevisedOrder, lineId: string): NonNullable<RevisedOrder['prices']>[number] | null {
  return order.prices?.find((row) => row.lineId === lineId) ?? null
}

/** The order's net value moved (the design's note: an earlier acceptance ends when the net value changes). */
export const netMoved = (order: RevisedOrder): boolean => order.netAmountBefore !== undefined && order.netAmountAfter !== undefined && order.netAmountBefore !== order.netAmountAfter

/** The files a kind shows as its photos (pictures first in the API's order, then the PDFs). */
export function filesInOrder(files: readonly ApprovalFile[]): ApprovalFile[] {
  return [...files.filter((file) => isPicture(file.contentType)), ...files.filter((file) => !isPicture(file.contentType))]
}
