import { isApiError, issuePath, type ApiError } from '../../../lib/api/errors'
import type { DraftFile } from '../../../lib/record-thread/attachments/model'
import type { ComposerDraft, SwitchNote } from '../../../lib/record-thread/composer/model'
import { settleOutbox, type OutboxItem } from '../../../lib/record-thread/model'
import type { Recipient } from '../../../lib/record-thread/send-check/model'
import type { ApiMessage } from '../../../record-panels/api'

/**
 * The office thread's state and its pure steps (B-TH-212): what the server said (the messages, page by page) and what the person
 * is doing (the draft, its files and recipients, the outbox) are kept APART, so a live re-read replaces the first and never touches
 * the second (T4-F06: "a live read never drops the draft"). Errors become this app's words here.
 */

export interface ServerThread {
  status: 'loading' | 'ready' | 'error' | 'forbidden'
  thread: { status: 'OPEN' | 'CLOSED'; version: number; partyId: string | null } | null
  /** Oldest first. */
  messages: ApiMessage[]
  cursor: string | null
  more: boolean
  older: 'idle' | 'loading' | 'failed'
}

export interface Work {
  draft: ComposerDraft
  notes: readonly SwitchNote[]
  files: DraftFile[]
  to: Recipient[]
  cc: Recipient[]
  subject: string
  outbox: OutboxItem[]
}

export const EMPTY_SERVER: ServerThread = { status: 'loading', thread: null, messages: [], cursor: null, more: false, older: 'idle' }

const byTime = (a: ApiMessage, b: ApiMessage) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1)

/**
 * The newest page read again (on arrival, after a send, on a live hint): the newest messages are replaced, the older pages the
 * person already loaded stay; the work is not part of it.
 */
export function applyNewest(server: ServerThread, page: { thread: ServerThread['thread']; messages: readonly ApiMessage[]; nextCursor: string | null }): ServerThread {
  const fresh = new Map(page.messages.map((message) => [message.id, message]))
  const oldestFresh = page.messages.length > 0 ? [...page.messages].sort(byTime)[0].at : null
  const kept = server.status === 'ready' && oldestFresh !== null ? server.messages.filter((message) => !fresh.has(message.id) && message.at < oldestFresh) : []
  const loadedOlder = kept.length > 0
  return {
    status: 'ready',
    thread: page.thread,
    messages: [...kept, ...page.messages].sort(byTime),
    cursor: loadedOlder ? server.cursor : page.nextCursor,
    more: loadedOlder ? server.more : page.nextCursor !== null,
    older: 'idle',
  }
}

/** An older page ("Show 50 earlier"): added at the top. */
export function applyOlder(server: ServerThread, page: { messages: readonly ApiMessage[]; nextCursor: string | null }): ServerThread {
  const ids = new Set(server.messages.map((message) => message.id))
  return { ...server, messages: [...page.messages.filter((message) => !ids.has(message.id)), ...server.messages].sort(byTime), cursor: page.nextCursor, more: page.nextCursor !== null, older: 'idle' }
}

/** After a re-read: the outbox items the server now lists leave; the draft, files and recipients stay as they are. */
export function afterRead(work: Work, server: ServerThread): Work {
  const ids = new Set(server.messages.map((message) => message.id))
  const outbox = settleOutbox(work.outbox, ids)
  return outbox.length === work.outbox.length ? work : { ...work, outbox }
}

/** A failed first read: no right (the thread is not drawn) or a fault (Try again; the box keeps the text). */
export const readStatusOf = (error: unknown): 'forbidden' | 'error' => (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up') ? 'forbidden' : 'error')

const paths = (error: ApiError) => error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))

/** Why a message did not go, as a card says it (a key of record-thread-card `reason.*`). */
export function sendReason(error: unknown): string {
  if (!isApiError(error)) return 'reason.network'
  if (error.kind === 'conflict' && paths(error).some((path) => path === 'refusal/OTHER_PARTY' || path === 'refusal/HIDDEN_OUTSIDE')) return 'reason.outside'
  switch (error.kind) {
    case 'unavailable':
      return 'reason.unavailable'
    case 'forbidden':
    case 'step_up':
    case 'signed_out':
      return 'reason.forbidden'
    case 'conflict':
      return 'reason.conflict'
    case 'invalid':
      return 'reason.refused'
    default:
      return 'reason.failed'
  }
}

/**
 * A refused reply that needs the person to change it goes back into the box with the notice (record-thread-send `notice.*`): another
 * customer's address without the tick, a blind copy outside, a refused address. Anything else stays in the feed as "Not sent ·
 * Retry" (a lost answer, a fault: the same key is sent again).
 */
export function replyRefusal(error: unknown): string | null {
  if (!isApiError(error)) return null
  const where = paths(error)
  if (error.kind === 'conflict' && where.includes('refusal/OTHER_PARTY')) return 'notice.outside'
  if (error.kind === 'conflict' && where.includes('refusal/HIDDEN_OUTSIDE')) return 'notice.hidden'
  if (error.kind === 'invalid' && where.some((path) => /^body\/(to|cc|bcc)(\/|$)/.test(path))) return 'notice.badRecipient'
  return null
}

/** The check's problem in the send catalogue's words, and whether a retry may help. */
export function checkProblemOf(error: unknown): { problem: string; retry: boolean } {
  if (!isApiError(error)) return { problem: 'problem.failed', retry: true }
  switch (error.kind) {
    case 'forbidden':
    case 'step_up':
    case 'signed_out':
      return { problem: 'problem.forbidden', retry: false }
    case 'not_found':
      return { problem: 'problem.notFound', retry: false }
    case 'unavailable':
    case 'rate_limited':
      return { problem: 'problem.unavailable', retry: true }
    default:
      return { problem: 'problem.failed', retry: true }
  }
}

/** Why an upload failed (a key of record-thread-attach `failed.*`). */
export function uploadReason(error: unknown, storeFailed: boolean): string {
  if (storeFailed) return 'failed.store'
  if (!isApiError(error)) return 'failed.failed'
  if (error.kind === 'invalid') return paths(error).includes('body/partyId') ? 'failed.otherParty' : 'failed.refused'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'failed.forbidden'
  return 'failed.failed'
}

/** Where the draft waits on this device (offline, a reload): one key per company and record. Text and mode only, never files. */
export const draftStoreKey = (companyId: string | null, record: { type: string; id: string }) => `fw-rt-draft:${companyId ?? '-'}:${record.type}:${record.id}`

/** The draft kept on this device, read back safely (anything else is ignored). */
export function parseStoredDraft(text: string | null): ComposerDraft | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<ComposerDraft>
    if (typeof value.body !== 'string' || value.body.trim() === '' || (value.mode !== 'note' && value.mode !== 'reply')) return null
    return { mode: value.mode, body: value.body.slice(0, 20_000), forFloor: value.forFloor === true }
  } catch {
    return null
  }
}

/** The box holds something the person would lose by leaving. */
export const hasUnsent = (work: Pick<Work, 'draft' | 'files'>): boolean => work.draft.body.trim() !== '' || work.files.some((file) => file.phase !== 'refused')
