import { SHARE_FIELDS, type ShareHeldReason, type SharePermission } from '@nexus/factory-domain/shares/rules'
import { isApiError, issuePath } from '../../lib/api/errors'
import type { LinkState } from '../../shell/links/link-state'
import type { ShareField, ShareMessage, SharePage } from './api'

/**
 * SCR-270's rules (B-W2b-200; design links.invite), pure: what the page says from the API's codes and values, what the
 * person may do now, and the API's refusals in our words. Nothing here fetches.
 */

export const LINK_NS = 'link-invite'

/** The composer's limit (factory-domain threads MAX_BODY_LENGTH). */
export const BODY_LIMIT = 20_000

/** The code fields' values the catalogue says in words (`code.<field>.<VALUE>`), one list per field. */
export const CODE_VALUES = Object.freeze({
  status: [
    'DRAFT', 'ACTIVE', 'ARCHIVED', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED',
    'CLOSED', 'CHANGES_PROPOSED', 'PARTLY_RECEIVED', 'RECEIVED', 'ISSUED', 'AT_WORKSHOP', 'PACKED', 'DELIVERED', 'RETURNED', 'NEW', 'TRIAGED', 'INVESTIGATING', 'ANSWERED', 'REQUESTED', 'AUTHORISED',
    'INSPECTED', 'REJECTED',
  ],
  productType: ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'],
  category: ['SAFETY', 'FUNCTION', 'COSMETIC', 'FIT'],
  kind: ['RETURN', 'CLAIM'],
  remedy: ['CREDIT', 'REPLACEMENT'],
} as const)

/** Every field key a record type shares (the catalogue's `field.<key>`). */
export const FIELD_KEYS: readonly string[] = [...new Set(Object.values(SHARE_FIELDS).flatMap((fields) => fields.map(([key]) => key)))]
export const RECORD_TYPES: readonly string[] = Object.keys(SHARE_FIELDS)

/** Words with their catalogue key and parameters (the view says them with `t`). */
export interface Words {
  readonly key: string
  readonly params?: Record<string, string | number>
}

/** How one shared field is said: its label key, and its value as words, a day, an instant, a number or text as typed. */
export type FieldValue = { kind: 'words'; words: Words } | { kind: 'day'; iso: string } | { kind: 'instant'; iso: string } | { kind: 'text'; text: string } | { kind: 'none' }

export function fieldValueOf(field: ShareField): FieldValue {
  if (field.value === null || field.value === '') return { kind: 'none' }
  switch (field.kind) {
    case 'code': {
      const list = (CODE_VALUES as Record<string, readonly string[]>)[field.key]
      const value = String(field.value)
      // A code the catalogue does not know yet is never shown as a key: "—" until its words are added.
      return list?.includes(value) ? { kind: 'words', words: { key: `code.${field.key}.${value}` } } : { kind: 'none' }
    }
    case 'date':
      return { kind: 'day', iso: String(field.value) }
    case 'instant':
      return { kind: 'instant', iso: String(field.value) }
    case 'count':
      return { kind: 'text', text: String(field.value) }
    default:
      return { kind: 'text', text: String(field.value) }
  }
}

/** The fields to show: the ones with a value (an empty date says nothing on a partner page). */
export const shownFields = (fields: readonly ShareField[]): ShareField[] => fields.filter((field) => fieldValueOf(field).kind !== 'none')

/** "read · write · upload" — the words of what the person may do, in order. */
export const mayKeys = (permissions: readonly SharePermission[]): string[] => permissions.map((permission) => `may.${permission}`)

/** Whole days left before the share ends (0 on its last day), from `now`. */
export function daysLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 86_400_000))
}

/** The words of a held post or upload (the API's code). */
export const heldKey = (code: ShareHeldReason | null): string | null => (code ? `held.${code}` : null)

/** The page's messages oldest first (the API pages newest first; older pages appended after), without repeats. */
export function threadOldestFirst(first: readonly ShareMessage[], older: readonly ShareMessage[]): ShareMessage[] {
  const seen = new Set<string>()
  const all: ShareMessage[] = []
  for (const message of [...first, ...older]) {
    if (seen.has(message.id)) continue
    seen.add(message.id)
    all.push(message)
  }
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
}

/** "673 KB" — a file's size as the reader reads it. */
export function sizeText(bytes: number, locale: 'it' | 'en'): string {
  const format = (value: number, digits: number) => value.toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: digits })
  if (bytes >= 1_048_576) return `${format(bytes / 1_048_576, 1)} MB`
  if (bytes >= 1024) return `${format(Math.round(bytes / 1024), 0)} KB`
  return `${bytes} B`
}

/** The file's kinds a browser picker offers (the API's content types as extensions). */
export function acceptOf(contentTypes: readonly string[]): string {
  const EXT: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg,.jpeg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'text/csv': '.csv',
    'text/plain': '.txt',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  }
  return [...new Set(contentTypes.flatMap((type) => (EXT[type] ? EXT[type].split(',') : [])))].join(',')
}

/** What is wrong with a file the person picked, before anything is sent (the API checks again). */
export function pickedProblem(file: { size: number; type: string }, page: Pick<SharePage, 'upload'>): Words | null {
  if (file.size > page.upload.maxBytes) return { key: 'files.problem.size', params: { mb: Math.round(page.upload.maxBytes / 1_048_576) } }
  if (file.type && !page.upload.contentTypes.includes(file.type)) return { key: 'files.problem.type' }
  if (file.size === 0) return { key: 'files.problem.empty' }
  return null
}

/** A failed read as the link state the frame shows: a share that ended or was revoked opens nothing (the one 404). */
export function readRefusal(error: unknown): LinkState {
  if (isApiError(error) && error.kind === 'not_found') return 'unavailable'
  if (isApiError(error) && error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}

const pathsOf = (error: unknown): string[] => (isApiError(error) ? error.issues.map(issuePath) : [])

/**
 * A refused write (a post, an upload, "E-mail me") in our words: the share narrowed a moment ago (`held/<CODE>` → the
 * page reads again), the link gone (the frame's dead link), the uploads closed while the scanner is off, anything else.
 */
export function writeRefusal(error: unknown): { words: Words; link?: LinkState; reload?: boolean } {
  if (!isApiError(error)) return { words: { key: 'problem.internal' } }
  const held = pathsOf(error).find((path) => path.startsWith('held/'))
  if (held) return { words: { key: `held.${held.slice('held/'.length)}` }, reload: true }
  switch (error.kind) {
    case 'not_found':
      return { words: { key: 'problem.gone' }, link: 'unavailable' }
    case 'conflict':
      return { words: { key: 'problem.changed' }, reload: true }
    case 'invalid':
      return { words: { key: pathsOf(error).some((path) => path.includes('contentType')) ? 'files.problem.type' : pathsOf(error).some((path) => path.includes('sizeBytes')) ? 'files.problem.sizeAny' : 'problem.invalid' } }
    case 'unavailable':
      return { words: { key: 'files.problem.closed' } }
    case 'rate_limited':
      return { words: { key: 'problem.rateLimited' } }
    default:
      return { words: { key: 'problem.internal' } }
  }
}

// ---- the view model ------------------------------------------------------------------------------------------------------

export interface InviteViewModel {
  link: LinkState
  page: SharePage | null
  /** A failed first read (our words), or null. */
  problem: string | null
  /** Older messages read with "Earlier messages", newest first as the API gives them. */
  older: ShareMessage[]
  cursor: string | null
  moreBusy: boolean
  draft: string
  /** The record's shared files ticked to go with the message (design sec:thread "Post, attach"). */
  attached: string[]
  posting: boolean
  postProblem: Words | null
  notifyBusy: boolean
  notifyProblem: Words | null
  upload: { busy: boolean; name: string | null; problem: Words | null; done: Words | null }
  /** The file being opened (read from the store), and a problem opening one. */
  opening: string | null
  fileProblem: Words | null
  /** "Now" for the days left (the design review fixes it). */
  now: number
  timeZone?: string
}

export interface InviteActions {
  onRetry?: () => void
  onDraft?: (value: string) => void
  onAttach?: (ids: string[]) => void
  onPost?: () => void
  onMore?: () => void
  onNotify?: (on: boolean) => void
  onFiles?: (files: File[]) => void
  onOpenFile?: (fileId: string) => void
  onDismiss?: (what: 'post' | 'notify' | 'upload' | 'file') => void
}

export const START: InviteViewModel = {
  link: 'valid',
  page: null,
  problem: null,
  older: [],
  cursor: null,
  moreBusy: false,
  draft: '',
  attached: [],
  posting: false,
  postProblem: null,
  notifyBusy: false,
  notifyProblem: null,
  upload: { busy: false, name: null, problem: null, done: null },
  opening: null,
  fileProblem: null,
  now: 0,
}
