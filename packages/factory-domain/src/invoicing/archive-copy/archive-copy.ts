import type { SdiNotificationType } from '../../ports/sdi'
import { isTestRef } from '../test-mode/test-mode'

/**
 * Our own copy of every send to SDI (B-W2b-401; FIN-097 "Swap intermediary without losing data"; design finance.settings
 * "Swap intermediary: our own copy of every XML and receipt"; factory-db tax.prisma SdiArchiveCopy): for each send the
 * intermediary took, the XML sent and every notification SDI gave about it are kept as our own fiscal-archive files (ten
 * years), so the intermediary can change without losing a file. Pure: the copy's key, the receipt file's name and body, how
 * complete a send's copy is, and whether the company may swap its intermediary now.
 *
 * The receipt file is our own XML record of the notification as the intermediary handed it to us (its type, SDI's ids, the
 * time, the errors): the real intermediary's signed receipt is kept as it comes once that intermediary is chosen (Q21).
 */

/** One copy per send: `sdi:<the send's id>`. */
export const copyKeyOf = (submissionId: string): string => `sdi:${submissionId}`

/** The intermediary as named on the copy (one line, 1-100): the FAKE, or the connection's label (a simulated send has no copy). */
export function providerNameOf(connection: { readonly label: string; readonly mode: string }): string {
  if (connection.mode === 'FAKE') return 'FAKE'
  const label = connection.label.replace(/\s+/g, ' ').trim().slice(0, 100)
  return label === '' ? connection.mode : label
}

const xmlText = (value: string): string => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')

export interface ReceiptFacts {
  readonly type: SdiNotificationType
  readonly sdiMessageId: string | null
  readonly receivedAt: string
  /** The notification as the intermediary handed it (SdiNotification.payload). */
  readonly payload: unknown
}

/** The receipt's file name: the send's file name, its type and its place among the send's notifications (`…_RC_001.xml`). */
export function receiptFileName(sendFileName: string, type: SdiNotificationType, ordinal: number): string {
  const stem = sendFileName.replace(/\.xml$/i, '')
  return `${stem}_${type}_${String(ordinal).padStart(3, '0')}.xml`
}

/** The receipt's body: our XML record of the notification (deterministic: the same notification makes the same bytes). */
export function receiptDocument(receipt: ReceiptFacts, provider: string): string {
  const payload = (receipt.payload ?? {}) as { sdiIdentifier?: unknown; fileName?: unknown; providerRef?: unknown; errors?: unknown; outcome?: unknown; note?: unknown }
  const line = (name: string, value: unknown) => (typeof value === 'string' && value !== '' ? `  <${name}>${xmlText(value)}</${name}>\n` : '')
  const errors = Array.isArray(payload.errors) ? (payload.errors as { code?: unknown; description?: unknown; hint?: unknown }[]) : []
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<NotificaSdiRegistrata tipo="${receipt.type}" fonte="${xmlText(provider)}">\n` +
    line('MessageId', receipt.sdiMessageId) +
    line('IdentificativoSdI', payload.sdiIdentifier) +
    line('NomeFile', payload.fileName) +
    line('RiferimentoIntermediario', payload.providerRef) +
    line('DataOra', receipt.receivedAt) +
    (errors.length > 0
      ? `  <ListaErrori>\n${errors.map((error) => `    <Errore>${line('Codice', error.code).trim()}${line('Descrizione', error.description).trim()}${line('Suggerimento', error.hint).trim()}</Errore>\n`).join('')}  </ListaErrori>\n`
      : '') +
    line('Esito', payload.outcome) +
    line('Note', payload.note) +
    '</NotificaSdiRegistrata>\n'
  )
}

export const COPY_STATES = ['NOT_SENT', 'SIMULATED', 'MISSING', 'RECEIPTS_MISSING', 'COMPLETE'] as const
export type CopyState = (typeof COPY_STATES)[number]

const COPY_WORDS: Readonly<Record<CopyState, string>> = Object.freeze({
  NOT_SENT: 'Never reached the intermediary: nothing to copy (the XML is the invoice’s own file).',
  SIMULATED: 'Simulated in test mode: it never reached an intermediary, nothing to copy.',
  MISSING: 'Our own copy is not made yet: make the copies before the intermediary changes.',
  RECEIPTS_MISSING: 'Our copy holds the XML but not every notification yet: make the copies again.',
  COMPLETE: 'Our own copy holds the XML sent and every notification so far.',
})

/** How complete our copy of one send is: whether the intermediary took it, the copy, and its notifications kept. */
export function copyStateOf(send: { readonly status: string; readonly providerRef: string | null }, copy: { readonly notificationsKept: number } | null, notifications: number): { readonly state: CopyState; readonly words: string } {
  const reached = send.providerRef !== null || (send.status !== 'SENDING' && send.status !== 'FAILED')
  const state: CopyState = isTestRef(send.providerRef) ? 'SIMULATED' : !reached ? 'NOT_SENT' : copy === null ? 'MISSING' : copy.notificationsKept < notifications ? 'RECEIPTS_MISSING' : 'COMPLETE'
  return { state, words: COPY_WORDS[state] }
}

/** Sends still waiting for SDI's answer through the intermediary: a swap now would leave their answers behind. */
const OPEN_AT_PROVIDER = new Set(['SENDING', 'SENT'])

export interface SwapFacts {
  readonly status: string
  readonly copy: CopyState
}

/**
 * Whether the company may swap its intermediary now without losing data (FIN-097), in words: every send the intermediary took
 * has our complete copy, and none waits for SDI's answer there (a simulated send never waits on an intermediary).
 */
export function swapReadiness(sends: readonly SwapFacts[]): { readonly ready: boolean; readonly open: number; readonly missing: number; readonly copied: number; readonly words: string } {
  const open = sends.filter((send) => OPEN_AT_PROVIDER.has(send.status) && send.copy !== 'SIMULATED').length
  const missing = sends.filter((send) => send.copy === 'MISSING' || send.copy === 'RECEIPTS_MISSING').length
  const copied = sends.filter((send) => send.copy === 'COMPLETE').length
  const ready = open === 0 && missing === 0
  const words = ready
    ? `Ready to swap: our own copy holds the XML and the notifications of all ${copied} send(s); nothing waits at the intermediary.`
    : [
        missing > 0 ? `${missing} send(s) lack our complete copy: make the copies first.` : null,
        open > 0 ? `${open} send(s) still wait for SDI's answer through this intermediary: swap once they are answered.` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' ')
  return { ready, open, missing, copied, words }
}
