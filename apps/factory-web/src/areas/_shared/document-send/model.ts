import type { PdfInput } from '@nexus/ui/components/PdfViewer/index'

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
}

export interface DocumentSendActions {
  onField?: (field: 'cc' | 'subject' | 'message', value: string) => void
  onSend?: () => void
  onClose?: () => void
  onRetryChecks?: () => void
  /** After a failed delivery: a new link, mailed again. */
  onNewLink?: () => void
}

/** Why Send is held, in the host's words: the first blocking check, an invalid copy address, loading, busy; else null. */
export function sendHeld(model: Pick<DocumentSendModel, 'checks' | 'sending' | 'canSend' | 'recipient' | 'result'>, ccInvalid: readonly string[], words: { loading: string; busy: string; noRight: string; noEmail: string; cc: (list: string) => string; sent: string }): string | null {
  if (model.result) return words.sent
  if (!model.canSend) return words.noRight
  if (model.sending) return words.busy
  if (model.checks.status !== 'ready') return words.loading
  const blocking = model.checks.items.find((item) => item.state === 'blocks')
  if (blocking) return blocking.label
  if (!model.recipient?.email) return words.noEmail
  if (ccInvalid.length > 0) return words.cc(ccInvalid.join(', '))
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
