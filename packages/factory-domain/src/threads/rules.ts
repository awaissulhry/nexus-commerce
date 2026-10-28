import { randomFillSync } from 'node:crypto'
import type { Issue } from '../core/errors'
import { defineMachine } from '../state/machine'

/**
 * The rules of record threads (plan A1 §2.3 Thread / Message, §3.7; features COL-001, COL-003, COL-020), pure: the
 * statuses and kinds, the reply token, who a message is for, and what a note may hold. apps/factory-api's
 * platform/threads applies them before any write; the database's guard triggers (…_threads_guards) hold the same
 * invariants for every login.
 */

export const THREAD_STATUSES = ['OPEN', 'CLOSED'] as const
export type ThreadStatus = (typeof THREAD_STATUSES)[number]
export const MESSAGE_DIRECTIONS = ['INTERNAL_NOTE', 'OUTBOUND', 'INBOUND'] as const
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number]
export const MESSAGE_AUDIENCES = ['OFFICE', 'PARTNER'] as const
export type MessageAudience = (typeof MESSAGE_AUDIENCES)[number]
export const MESSAGE_CHANNELS = ['APP', 'EMAIL', 'PORTAL'] as const
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number]
export const AUTHOR_KINDS = ['USER', 'WORKER', 'PARTY', 'SYSTEM'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]

/** OPEN ⇄ CLOSED (threads.manage). A closed thread takes no new note. */
export const threadMachine = defineMachine({
  name: 'thread',
  states: THREAD_STATUSES,
  transitions: { OPEN: ['CLOSED'], CLOSED: ['OPEN'] },
})

/** A record's model name, as on audit rows and files (`Quote`, `PurchaseOrder`). */
export const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

/**
 * The reply address's secret part (COL-020: hard to guess): 26 characters of lower-case base32 (RFC 4648 alphabet,
 * no padding) = 130 random bits. Lower case, because mail systems may fold the case of an address's local part.
 */
export const REPLY_TOKEN_LENGTH = 26
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const REPLY_TOKEN = new RegExp(`^[a-z2-7]{${REPLY_TOKEN_LENGTH}}$`)

/** A new reply token. `random` fills a buffer with random bytes (default `node:crypto`; tests pass their own). */
export function newReplyToken(random: (bytes: Uint8Array) => void = (bytes) => void randomFillSync(bytes)): string {
  const bytes = new Uint8Array(Math.ceil((REPLY_TOKEN_LENGTH * 5) / 8))
  random(bytes)
  let token = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5 && token.length < REPLY_TOKEN_LENGTH) {
      token += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  return token
}

export function isReplyToken(value: unknown): value is string {
  return typeof value === 'string' && REPLY_TOKEN.test(value)
}

/** Who a message is for: an internal note the office only; a message sent to or received from the party, shared. */
export function audienceOf(direction: MessageDirection): MessageAudience {
  return direction === 'INTERNAL_NOTE' ? 'OFFICE' : 'PARTNER'
}

/** The longest text of one message, and the most people one note mentions and files one message attaches. */
export const MAX_BODY_LENGTH = 20_000
export const MAX_MENTIONS = 20
export const MAX_ATTACHMENTS = 20
/** The excerpt of a message on the timeline. */
export const EXCERPT_LENGTH = 280

/** A message's text as stored: line breaks as `\n`, no control characters but tab and line break, trimmed. */
export function cleanBody(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

export interface NoteDraft {
  /** Already cleaned (`cleanBody`). */
  readonly bodyText: string
  readonly mentions: readonly string[]
  readonly attachments: readonly string[]
}

/** The problems of a note before it is written (empty when it may be posted). */
export function noteProblems(draft: NoteDraft, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (draft.bodyText.length === 0 && draft.attachments.length === 0) problems.push({ path: `${at}/body`, message: 'Write something, or attach a file.' })
  if (draft.bodyText.length > MAX_BODY_LENGTH) problems.push({ path: `${at}/body`, message: `A message holds at most ${MAX_BODY_LENGTH} characters.` })
  if (draft.mentions.length > MAX_MENTIONS) problems.push({ path: `${at}/mentions`, message: `A note mentions at most ${MAX_MENTIONS} people.` })
  if (draft.attachments.length > MAX_ATTACHMENTS) problems.push({ path: `${at}/attachments`, message: `A message attaches at most ${MAX_ATTACHMENTS} files.` })
  return problems
}

/** Each id once, in the order first given. */
export function uniqueIds(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids ?? [])]
}

/** The start of a message's text for the timeline: one line, at most EXCERPT_LENGTH characters. */
export function excerptOf(text: string, length = EXCERPT_LENGTH): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= length ? line : `${line.slice(0, length - 1).trimEnd()}…`
}
