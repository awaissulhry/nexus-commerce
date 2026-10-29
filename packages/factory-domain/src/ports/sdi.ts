import { z } from 'zod'

/**
 * The SDI port (plan A1 §4 "SdiPort"; PLAN §2.4 B-W1-50; features FIN-084, FIN-086, FIN-087, FIN-088, FIN-092): the
 * company's SDI intermediary (A-Cube or Openapi: the Owner picks it with his accountant, question Q21) sends the
 * FatturaPA XML to SDI, tells what SDI answered (by webhook, or when asked: the status poll catches a lost webhook) and
 * keeps the sent invoices in legal archiving (conservazione, DM 17.6.2014). The adapters live in
 * apps/factory-api/src/adapters/sdi/ (the FAKE for local and test; the real provider is one file there once Q21 is
 * answered); every call runs inside ONE gateway call, so it is rate limited, circuit broken and recorded as one
 * IntegrationCall row. The invoicing module (modules/invoicing/sdi) turns the answers into SdiSubmission and
 * SdiNotification rows and keeps the invoice's status equal to its sends' outcome.
 *
 * Pure types, constants and the schema an adapter's notifications must pass: no I/O.
 */

/** The gateway operations. All three are idempotent: send by the send's id (the provider's idempotency key). */
export const SDI_OPERATIONS = Object.freeze({
  send: Object.freeze({ name: 'sdi.send_invoice', idempotent: true }),
  status: Object.freeze({ name: 'sdi.get_status', idempotent: true }),
  archive: Object.freeze({ name: 'sdi.archive', idempotent: true }),
})

/**
 * SDI's notifications (Specifiche tecniche SDI; the SdiNotificationType enum of @nexus/factory-db):
 *   RC  ricevuta di consegna: delivered to the buyer
 *   MC  mancata consegna: not deliverable; the invoice is issued and waits in the buyer's tax drawer
 *   NS  notifica di scarto: rejected; the file counts as never issued
 *   NE  notifica di esito (public bodies): the body accepted (EC01) or refused (EC02) the delivered invoice
 *   DT  decorrenza termini (public bodies): no answer within 15 days of the delivery
 *   AT  attestazione di avvenuta trasmissione con impossibilità di recapito (public bodies): like MC
 */
export const SDI_NOTIFICATION_TYPES = ['RC', 'MC', 'NS', 'NE', 'DT', 'AT'] as const
export type SdiNotificationType = (typeof SDI_NOTIFICATION_TYPES)[number]

export interface SdiSendRequest {
  /** Our name of the file for this send: `<country><transmitter id>_<progressive>.xml`, unique per tenant. */
  readonly fileName: string
  /** The FatturaPA XML, UTF-8. */
  readonly xml: string
  /** The send's id (SdiSubmission.id): the provider's idempotency key, so a retry never sends the file twice. */
  readonly idempotencyKey: string
}

export interface SdiSendReceipt {
  /** The provider's id of the send. */
  readonly providerRef: string
  /** When the provider took the file (ISO 8601 instant). */
  readonly acceptedAt: string
  /** The name the provider gave the file when it renamed it (its own transmitter id), else null. */
  readonly providerFileName: string | null
}

export interface SdiStatusRequest {
  /** The provider's id of the send; null when its answer never came (a timeout): then the file name and the key. */
  readonly providerRef: string | null
  readonly fileName: string
  readonly idempotencyKey: string
}

export interface SdiStatusAnswer {
  /** False: the provider has no such file (it never reached the provider). */
  readonly known: boolean
  readonly providerRef: string | null
  /** When the provider took the file, when known. */
  readonly acceptedAt: string | null
  /** Every notification SDI gave about the file so far (the caller records each once). */
  readonly messages: readonly SdiMessage[]
}

export interface SdiArchiveRequest {
  readonly providerRef: string
  readonly fileName: string
}

export interface SdiArchiveReceipt {
  /** The provider's id of the archived package (pacchetto di archiviazione). */
  readonly archiveRef: string
  readonly archivedAt: string
}

/** One error of an NS (ListaErrori/Errore): SDI's code, its description and its hint, as given. */
export interface SdiErrorEntry {
  readonly code: string
  readonly description: string
  readonly hint: string | null
}

/** One SDI notification, as an adapter hands it in (the provider's format turned into these fields). */
export interface SdiMessage {
  readonly type: SdiNotificationType
  /** SDI's MessageId; null when the provider gives none (the module then derives a stable one). */
  readonly messageId: string | null
  /** IdentificativoSdI: SDI's id of the file. */
  readonly sdiIdentifier: string | null
  /** The provider's id of the send the notification is about. */
  readonly providerRef: string | null
  /** The file's name as SDI received it. */
  readonly fileName: string | null
  /** When SDI issued it (DataOraRicezione, DataOraConsegna …): ISO 8601 instant. */
  readonly issuedAt: string
  /** NS: the errors (ListaErrori). */
  readonly errors: readonly SdiErrorEntry[]
  /** NE: EC01 accepted, EC02 refused. */
  readonly outcome: 'EC01' | 'EC02' | null
  /** SDI's free note, when any. */
  readonly note: string | null
}

const text = (max: number) => z.string().trim().min(1).max(max)
const isoInstant = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), { message: 'Expected an ISO 8601 instant.' })

/** What an adapter's message must look like before the module records it. */
export const sdiMessageSchema = z.strictObject({
  type: z.enum(SDI_NOTIFICATION_TYPES),
  messageId: text(200).nullable(),
  sdiIdentifier: text(50).nullable(),
  providerRef: text(200).nullable(),
  fileName: text(200).nullable(),
  issuedAt: isoInstant,
  errors: z.array(z.strictObject({ code: text(20), description: z.string().max(2000), hint: z.string().max(2000).nullable() })).max(200),
  outcome: z.enum(['EC01', 'EC02']).nullable(),
  note: z.string().max(2000).nullable(),
})

/**
 * The dedupe key of a notification (SdiNotification.sdiMessageId, unique per send): SDI's MessageId, else one derived
 * from what identifies the message, so a webhook replayed, a provider's retry under a new delivery id and a poll that
 * finds the same message all record it once.
 */
export function messageKeyOf(message: Pick<SdiMessage, 'type' | 'messageId' | 'sdiIdentifier' | 'issuedAt'>): string {
  if (message.messageId) return message.messageId
  return `derived:${message.type}:${message.sdiIdentifier ?? '-'}:${new Date(message.issuedAt).toISOString()}`
}
