import { z } from 'zod'

/**
 * The passive side of the SDI port (B-W2a-62; FIN-136, FIN-091): the invoices SDI delivered to a company through its SDI
 * intermediary (the same account the company sends with, A1 §4 "SdiPort"; A-Cube or Openapi once Owner question Q21 is
 * answered, the FAKE until then). The adapters live in apps/factory-api/src/adapters/sdi/ beside the active side; every
 * call runs inside ONE gateway call (rate limit, circuit, timeout, retries, one IntegrationCall row). Both operations
 * only read, so a retry is harmless; an invoice is recorded once per IdentificativoSdI (SupplierInvoice.sdiIdentifier
 * is unique), so a pickup that lists one again adds nothing.
 *
 *   list   the invoices the intermediary holds for the account's company, delivered at or after `since` (a page)
 *   get    one of them: the FatturaPA XML (already out of its signed .p7m envelope) as SDI delivered it
 *
 * Pure types, constants and the schemas an adapter's answers must pass: no I/O.
 */

export const SDI_RECEIVED_OPERATIONS = Object.freeze({
  list: Object.freeze({ name: 'sdi.list_received', idempotent: true }),
  get: Object.freeze({ name: 'sdi.get_received', idempotent: true }),
})

export interface SdiReceivedListRequest {
  /** Delivered at or after this instant (ISO 8601). */
  readonly since: string
  /** The page after this one (the previous answer's `next`). */
  readonly cursor: string | null
}

export interface SdiReceivedItem {
  /** The provider's id of the delivery. */
  readonly providerRef: string
  /** IdentificativoSdI. */
  readonly sdiIdentifier: string
  /** The file's name as SDI delivered it (IT01234567890_00001.xml, or .xml.p7m). */
  readonly fileName: string
  /** When SDI delivered it to the company (ISO 8601). */
  readonly receivedAt: string
}

export interface SdiReceivedList {
  readonly items: readonly SdiReceivedItem[]
  readonly next: string | null
}

export interface SdiReceivedFile {
  readonly providerRef: string
  readonly sdiIdentifier: string
  readonly fileName: string
  readonly receivedAt: string
  /** The FatturaPA XML, UTF-8. */
  readonly xml: string
}

const text = (max: number) => z.string().trim().min(1).max(max)
const isoInstant = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), { message: 'Expected an ISO 8601 instant.' })

export const sdiReceivedItemSchema = z.strictObject({ providerRef: text(200), sdiIdentifier: text(50), fileName: text(200), receivedAt: isoInstant })
export const sdiReceivedListSchema = z.strictObject({ items: z.array(sdiReceivedItemSchema).max(500), next: text(500).nullable() })
export const sdiReceivedFileSchema = z.strictObject({ providerRef: text(200), sdiIdentifier: text(50), fileName: text(200), receivedAt: isoInstant, xml: z.string().min(1).max(8_000_000) })
