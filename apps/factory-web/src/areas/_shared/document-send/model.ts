import type { PdfInput } from '@nexus/ui/components/PdfViewer/index'
import { isApiError, issuePath } from '../../../lib/api/errors'

/**
 * The "sending out" part (SCR-037; 00 §2.6 "Sending out"; design shell.preview): ONE dialog for any document an office
 * person sends to a customer or supplier — the recipient and the copies, the subject and message, the document exactly
 * as it will leave (the PDF viewer, also in a new tab), the checks that must pass first, the words about what freezes,
 * one Send held with the first blocking check's reason, and the result. The host (a quote today; a purchase order later)
 * translates its own words (the document's name, its checks, what freezes) and passes them in; this part's own words are
 * the `send` catalogue. It fetches nothing.
 */

export type SendCheckState = 'blocks' | 'warning' | 'passes'

export interface SendCheckItem {
  id: string
  state: SendCheckState
  /** In the reader's language (the host's words). */
  label: string
  /** Where it is fixed: a tab or a field of the record (a real link). */
  fix?: { label: string; href: string } | null
}

export type SendDelivery = 'sent' | 'failed' | 'retry' | 'settled' | null

export interface DocumentSendModel {
  /** "Send quote Q-2026-0142 v2". */
  title: string
  /** The document as named on the PDF ("Quote Q-2026-0142 v2"). */
  documentLabel: string
  recipient: { name: string; email: string | null } | null
  language: 'it' | 'en'
  /** How it goes: with a one-off link to answer online (until when), or the PDF only. */
  how: { kind: 'acceptLink'; until: string | null } | { kind: 'pdfOnly' }
  /** What freezes, said before the button ("After sending, version 2 can't change…"). */
  freezeNote: string
  /** What the recipient can do (host words, one line each). */
  recipientCan: readonly string[]
  fields: { cc: string; subject: string; message: string }
  checks: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; items: readonly SendCheckItem[] }
  preview: { src: PdfInput | null; openHref: string | null; problem: string | null; fileName: string }
  sending: boolean
  /** The send was refused (host words), shown above the button. */
  problem: string | null
  result: { delivery: SendDelivery; to: string; at: string; linkUntil: string | null } | null
  /** The person may send (else the dialog is read-only and says why). */
  canSend: boolean
  /** Where the time is shown (the site's zone). */
  timeZone?: string
  /**
   * B-TH-202 (the brand wall, B-TH-004): the send was refused because an address belongs to another customer or supplier: the
   * office's words for each address (whose it is), and the person's recorded "Send outside this customer" tick.
   */
  outside?: SendOutside | null
}

/** B-TH-202: what the recipient rule held back, and whether the person ticked "Send outside this customer". */
export interface SendOutside {
  readonly lines: readonly string[]
  readonly checked: boolean
}

export interface DocumentSendActions {
  onField?: (field: 'cc' | 'subject' | 'message', value: string) => void
  onSend?: () => void
  onClose?: () => void
  onRetryChecks?: () => void
  /** After a failed delivery: a new link, mailed again. */
  onNewLink?: () => void
  /** B-TH-202: the person ticks (or unticks) "Send outside this customer". */
  onSendOutside?: (checked: boolean) => void
}

// ---- B-TH-202 (the brand wall, B-TH-004): the recipient rule's refusal of a document send ---------------------------------

/**
 * The recipient rule's refusal of a send (409 `refusal/OTHER_PARTY`): the office's words for each address held back ("x belongs
 * to Brand Beta."; the office sees every customer), and whether it was a blind copy outside our people (`refusal/HIDDEN_OUTSIDE`:
 * no tick lets that through). Null for any other answer.
 */
export function outsideRefusalOf(error: unknown): { readonly lines: string[]; readonly hidden: boolean } | null {
  if (!isApiError(error) || error.kind !== 'conflict') return null
  const paths = error.issues.map((issue) => issuePath(issue).replace(/\./g, '/'))
  const hidden = paths.includes('refusal/HIDDEN_OUTSIDE')
  if (!hidden && !paths.includes('refusal/OTHER_PARTY')) return null
  return { lines: error.issues.filter((issue) => !issuePath(issue).startsWith('refusal')).map((issue) => issue.message ?? '').filter((line) => line !== ''), hidden }
}

/** Why Send is held, in the host's words: the first blocking check, an invalid copy address, loading, busy; else null. */
export function sendHeld(
  model: Pick<DocumentSendModel, 'checks' | 'sending' | 'canSend' | 'recipient' | 'result' | 'outside'>,
  ccInvalid: readonly string[],
  words: { loading: string; busy: string; noRight: string; noEmail: string; cc: (list: string) => string; sent: string; outside?: string },
): string | null {
  if (model.result) return words.sent
  if (!model.canSend) return words.noRight
  if (model.sending) return words.busy
  if (model.checks.status !== 'ready') return words.loading
  const blocking = model.checks.items.find((item) => item.state === 'blocks')
  if (blocking) return blocking.label
  if (!model.recipient?.email) return words.noEmail
  if (ccInvalid.length > 0) return words.cc(ccInvalid.join(', '))
  // B-TH-202: another customer's address, refused by the send: held until "Send outside this customer" is ticked.
  if (model.outside && !model.outside.checked) return words.outside ?? null
  return null
}

/** Blocking first, then warnings, then what passes (the checklist's order). */
export function orderedChecks(items: readonly SendCheckItem[]): SendCheckItem[] {
  const rank: Record<SendCheckState, number> = { blocks: 0, warning: 1, passes: 2 }
  return [...items].sort((a, b) => rank[a.state] - rank[b.state])
}

/** "anna@… ; luca@…" → the addresses (trimmed, unique, at most 10); invalid ones are returned apart. */
export function parseCc(text: string): { valid: string[]; invalid: string[] } {
  const parts = [...new Set(text.split(/[;,\s]+/).map((part) => part.trim()).filter(Boolean))]
  const ok = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
  return { valid: parts.filter(ok).slice(0, 10), invalid: parts.filter((part) => !ok(part)) }
}
