/**
 * The print relay port (plan A1 §3.9; GAP-007 "one print relay on site"): how a print job leaves the factory's servers
 * for a printer on a plant's network. The worker's print.dispatch handler (platform/print/jobs.ts) hands every queued
 * job to the relay of its printer; the relay answers with its own id for the job, or refuses.
 *
 * Which relay a site gets is the Owner's choice (A1 §9 question 5). Each answer is an adapter behind this port:
 *   - our own relay at the plant (apps/factory-print-agent, A1 §1.1): a PC that PULLS jobs over HTTPS with a device
 *     token and writes ZPL to the printers on TCP 9100 — "submit" then only makes the job available to it;
 *   - a cloud print service the API calls: that adapter runs every call inside a gateway call for its integration
 *     account (plan A1 §4), like the file store;
 *   - plain printers only: no relay; the browser prints the PDF (a download), and no job is queued.
 * Until then the only adapter is FAKE (./fake.ts): it records jobs and sends nothing.
 *
 * Rules for every adapter: `submit` is idempotent by job id (the handler may retry after the relay already took the
 * job: the same id answers the same relay id and prints nothing twice); a refusal is a RelayError, retryable or not; a
 * message never carries a secret or a network address.
 */

/** The relays a printer can be reached through; the Prisma enum PrintRelay lists the same values. */
export const PRINT_RELAY_KINDS = ['FAKE'] as const
export type PrintRelayKind = (typeof PRINT_RELAY_KINDS)[number]

export interface RelayPrinter {
  readonly id: string
  readonly code: string
  readonly kind: 'LABEL_ZPL' | 'A4_PDF'
  /** The printer as the relay knows it (Printer.relayTarget). */
  readonly target: string
}

/** A short-lived download of the job's PDF (60 seconds), made only when the relay asks for it. */
export interface RelayDownload {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

export type RelayPayload =
  | { readonly kind: 'ZPL'; readonly zpl: string }
  | { readonly kind: 'PDF'; readonly fileId: string; readonly sha256: string; readonly sizeBytes: number; download(): Promise<RelayDownload> }

export interface RelayJob {
  readonly jobId: string
  readonly tenantId: string
  readonly siteId: string
  readonly printer: RelayPrinter
  /** ZPL carries its copies in ^PQ; a PDF relay prints the file this many times. */
  readonly copies: number
  readonly payload: RelayPayload
}

export interface RelaySubmission {
  /** The relay's own id for the job. */
  readonly relayJobId: string
}

/** The relay refused or could not be reached. `retryable`: the handler tries again later (up to the job's limit). */
export class RelayError extends Error {
  override name = 'RelayError'
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message)
  }
}

export interface PrintRelayAdapter {
  readonly kind: PrintRelayKind
  /** Hands one job over; idempotent by job id. */
  submit(job: RelayJob): Promise<RelaySubmission>
}
