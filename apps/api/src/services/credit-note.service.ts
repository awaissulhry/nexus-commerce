/**
 * F1.4 — Italian nota di credito (credit note) number assignment.
 *
 * Italian fiscal law (DPR 633/72 Art. 26) requires a credit note for
 * every refund of a sale invoice. Without it, refunded VAT remains
 * owed to the state — a category of audit failure that costs more
 * than the refund itself.
 *
 * Per-(fiscalYear, issuer) sequence is gap-free + monotonic.
 * Idempotent: re-calling assignCreditNoteNumber for the same refundId
 * returns the existing number instead of burning a new one.
 *
 * Format: "NC-NNNNN/YYYY" — "NC-" prefix differentiates credit notes
 * from regular invoice numbers in operator-facing list views; the
 * SDI dispatch path strips the prefix when populating <Numero/>.
 *
 * Pattern mirrors fiscal-invoice.service.ts (F.2).
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export interface CreditNoteAssignment {
  creditNoteNumber: string
  sequenceNumber: number
  fiscalYear: number
  issuer: string
  issuedAt: Date
  amountCents: number
  currencyCode: string
  causale: string | null
  originalInvoiceId: string | null
  /** True when the assignment was made on this call; false when an
   *  existing CreditNote was returned. */
  newlyAssigned: boolean
}

const DEFAULT_ISSUER = 'XAVIA'

function fiscalYearOf(d: Date): number {
  return d.getFullYear()
}

function formatCreditNoteNumber(seq: number, year: number): string {
  return `NC-${seq.toString().padStart(5, '0')}/${year}`
}

/**
 * Assign (or return the existing) credit note number for a refund.
 * Atomic under concurrent callers via raw INSERT ... ON CONFLICT.
 *
 * Throws when the refund isn't found. Returns newlyAssigned=true on
 * first call, false on subsequent calls (same number).
 *
 * `causale` is the Italian fiscal "reason" string — usually
 * "Resa merce — RMA-XXXXX". When omitted we synthesise from the
 * Return.rmaNumber.
 */
export async function assignCreditNoteNumber(
  refundId: string,
  opts: { issuer?: string; at?: Date; causale?: string } = {},
): Promise<CreditNoteAssignment> {
  const issuer = opts.issuer ?? DEFAULT_ISSUER
  const issuedAt = opts.at ?? new Date()
  const fiscalYear = fiscalYearOf(issuedAt)

  return prisma.$transaction(async (tx) => {
    const existing = await tx.creditNote.findUnique({
      where: { refundId },
    })
    if (existing) {
      return {
        creditNoteNumber: existing.creditNoteNumber,
        sequenceNumber: existing.sequenceNumber,
        fiscalYear: existing.fiscalYear,
        issuer: existing.issuer,
        issuedAt: existing.issuedAt,
        amountCents: existing.amountCents,
        currencyCode: existing.currencyCode,
        causale: existing.causale,
        originalInvoiceId: existing.originalInvoiceId,
        newlyAssigned: false,
      }
    }

    const refund = await tx.refund.findUnique({
      where: { id: refundId },
      include: {
        return: {
          select: {
            rmaNumber: true,
            orderId: true,
          },
        },
      },
    })
    if (!refund) {
      throw new Error(`Refund ${refundId} not found`)
    }

    // Lookup the original invoice (if one was issued for the order).
    // Returns NULL for pure B2C corrispettivi orders.
    const originalInvoice = refund.return?.orderId
      ? await tx.fiscalInvoice.findUnique({
          where: { orderId: refund.return.orderId },
          select: { id: true },
        })
      : null

    const causale =
      opts.causale ??
      (refund.return?.rmaNumber
        ? `Resa merce — ${refund.return.rmaNumber}`
        : 'Resa merce')

    // Atomic counter increment + sequence return.
    const rows = await tx.$queryRaw<Array<{ current: number }>>`
      INSERT INTO "CreditNoteCounter" ("fiscalYear", "issuer", "current", "updatedAt")
      VALUES (${fiscalYear}, ${issuer}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT ("fiscalYear", "issuer") DO UPDATE
        SET "current" = "CreditNoteCounter"."current" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "current"
    `
    const sequenceNumber = rows[0]?.current ?? 1
    const creditNoteNumber = formatCreditNoteNumber(sequenceNumber, fiscalYear)

    const created = await tx.creditNote.create({
      data: {
        refundId,
        originalInvoiceId: originalInvoice?.id ?? null,
        issuer,
        fiscalYear,
        sequenceNumber,
        creditNoteNumber,
        amountCents: refund.amountCents,
        currencyCode: refund.currencyCode,
        causale,
        issuedAt,
      },
    })

    logger.info('credit-note: assigned', {
      refundId,
      creditNoteNumber,
      issuer,
      fiscalYear,
      sequenceNumber,
      originalInvoiceId: originalInvoice?.id ?? null,
    })

    return {
      creditNoteNumber: created.creditNoteNumber,
      sequenceNumber: created.sequenceNumber,
      fiscalYear: created.fiscalYear,
      issuer: created.issuer,
      issuedAt: created.issuedAt,
      amountCents: created.amountCents,
      currencyCode: created.currencyCode,
      causale: created.causale,
      originalInvoiceId: created.originalInvoiceId,
      newlyAssigned: true,
    }
  })
}

/**
 * Lookup an existing credit note assignment without creating one.
 * Returns null when no credit note has been issued yet for the refund.
 */
export async function getCreditNoteForRefund(
  refundId: string,
): Promise<CreditNoteAssignment | null> {
  const cn = await prisma.creditNote.findUnique({
    where: { refundId },
  })
  if (!cn) return null
  return {
    creditNoteNumber: cn.creditNoteNumber,
    sequenceNumber: cn.sequenceNumber,
    fiscalYear: cn.fiscalYear,
    issuer: cn.issuer,
    issuedAt: cn.issuedAt,
    amountCents: cn.amountCents,
    currencyCode: cn.currencyCode,
    causale: cn.causale,
    originalInvoiceId: cn.originalInvoiceId,
    newlyAssigned: false,
  }
}
