import type { Phrase } from '../../_shared/model'
import type { InboxItem, InboxList, InboxStatus } from './api'

/**
 * B-W2b-GB02 — the SDI inbox, pure: which rows the list shows (waiting by default), why an action is held, a dismissal's
 * reason checked as the API checks it (1 to 500 characters), and whether the section is drawn at all (nothing ever waited:
 * no section).
 */

export const INBOX_ROWS = ['open', 'dismissed', 'recorded', 'all'] as const
export type InboxRows = (typeof INBOX_ROWS)[number]

export const statusOfInboxRows = (rows: InboxRows): InboxStatus | null => (rows === 'open' ? 'OPEN' : rows === 'dismissed' ? 'DISMISSED' : rows === 'recorded' ? 'RECORDED' : null)

export interface InboxCan {
  readonly view: boolean
  readonly manage: boolean
  readonly files: boolean
}

export const inboxAbilitiesOf = (permissions: readonly string[]): InboxCan => {
  const held = new Set(permissions)
  return { view: held.has('payables.view'), manage: held.has('payables.manage'), files: held.has('files.read') }
}

export const REASON_MAX = 500

/** Why "Dismiss…" is held for a row, or null. */
export function dismissHeld(item: Pick<InboxItem, 'status'>, can: InboxCan, busy: boolean): Phrase | null {
  if (!can.manage) return { key: 'held.noManage' }
  if (busy) return { key: 'held.busy' }
  if (item.status !== 'OPEN') return { key: item.status === 'RECORDED' ? 'held.recorded' : 'held.dismissed' }
  return null
}

/** Why "Open the file" is held for a row, or null. */
export function fileHeld(item: Pick<InboxItem, 'xmlFileId'>, can: InboxCan): Phrase | null {
  if (!item.xmlFileId) return { key: 'held.noFile' }
  if (!can.files) return { key: 'held.noFiles' }
  return null
}

/** The dismissal's reason as the API takes it, or why not. */
export function reasonProblem(reason: string): Phrase | null {
  const trimmed = reason.trim()
  if (trimmed.length === 0) return { key: 'dismiss.reasonEmpty' }
  if (trimmed.length > REASON_MAX) return { key: 'dismiss.reasonLong', params: { max: REASON_MAX } }
  return null
}

/** Whether the section is drawn: something waits, was dismissed, or the person chose other rows. */
export const inboxShown = (list: InboxList | null, rows: InboxRows, problem: string | null): boolean => problem !== null || (list !== null && (rows !== 'open' || list.items.length > 0 || list.counts.dismissed > 0))
