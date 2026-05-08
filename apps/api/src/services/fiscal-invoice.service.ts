/**
 * F.2 — Italian fiscal-year invoice number assignment.
 *
 * Italian law requires:
 *   - Sequential within fiscal year (Jan 1–Dec 31)
 *   - Gap-free — auditors flag missing numbers
 *   - Resets every January 1
 *   - Per-issuer (single tenant ⇒ 'XAVIA' default)
 *
 * Implementation: per-(year, issuer) counter row + transactional
 * SELECT FOR UPDATE on the counter, then upsert the FiscalInvoice
 * row. Postgres ensures gap-free under concurrent writers.
 *
 * Idempotent: re-running for the same orderId returns the existing
 * invoiceNumber instead of allocating a new one. Operators can
 * safely click "Generate invoice" twice without burning a number.
 *
 * Format: "NNNNN/YYYY" — 5-digit zero-padded sequence + slash +
 * 4-digit year. Configurable per-issuer in a follow-up.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

export interface FiscalInvoiceAssignment {
  invoiceNumber: string
  sequenceNumber: number
  fiscalYear: number
  issuer: string
  issuedAt: Date
  /** True when the assignment was made on this call; false when an
   *  existing FiscalInvoice was returned. */
  newlyAssigned: boolean
}

const DEFAULT_ISSUER = 'XAVIA'

function fiscalYearOf(d: Date): number {
  // Italian fiscal year = calendar year. Some companies use a
  // shifted fiscal year (esercizio non solare) but we don't.
  return d.getFullYear()
}

function formatInvoiceNumber(seq: number, year: number): string {
  return `${seq.toString().padStart(5, '0')}/${year}`
}

/**
 * Assign (or return the existing) fiscal invoice number for an
 * order. Atomic under concurrent callers via SELECT FOR UPDATE.
 *
 * Throws when the order isn't found. Returns the assignment with
 * newlyAssigned=true on first call, newlyAssigned=false on
 * subsequent calls (same number returned).
 */
export async function assignInvoiceNumber(
  orderId: string,
  opts: { issuer?: string; at?: Date } = {},
): Promise<FiscalInvoiceAssignment> {
  const issuer = opts.issuer ?? DEFAULT_ISSUER
  const issuedAt = opts.at ?? new Date()
  const fiscalYear = fiscalYearOf(issuedAt)

  return prisma.$transaction(async (tx) => {
    // Idempotency: if an invoice already exists for this order,
    // return it unchanged.
    const existing = await tx.fiscalInvoice.findUnique({
      where: { orderId },
    })
    if (existing) {
      return {
        invoiceNumber: existing.invoiceNumber,
        sequenceNumber: existing.sequenceNumber,
        fiscalYear: existing.fiscalYear,
        issuer: existing.issuer,
        issuedAt: existing.issuedAt,
        newlyAssigned: false,
      }
    }

    // Validate the order exists. Cheap pre-check — saves us a
    // failed FK insert below.
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    })
    if (!order) {
      throw new Error(`Order ${orderId} not found`)
    }

    // Counter upsert + atomic increment via raw SQL with RETURNING
    // — Prisma's upsert+update would race under concurrent
    // assignment for the same (year, issuer). The raw query takes
    // a row-lock on the counter and returns the new value in one
    // round-trip.
    const rows = await tx.$queryRaw<
      Array<{ current: number }>
    >`
      INSERT INTO "FiscalInvoiceCounter" ("fiscalYear", "issuer", "current", "updatedAt")
      VALUES (${fiscalYear}, ${issuer}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT ("fiscalYear", "issuer") DO UPDATE
        SET "current" = "FiscalInvoiceCounter"."current" + 1,
            "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "current"
    `
    const sequenceNumber = rows[0]?.current ?? 1

    const invoiceNumber = formatInvoiceNumber(sequenceNumber, fiscalYear)
    const created = await tx.fiscalInvoice.create({
      data: {
        orderId,
        issuer,
        fiscalYear,
        sequenceNumber,
        invoiceNumber,
        issuedAt,
      },
    })

    logger.info('fiscal-invoice: assigned', {
      orderId,
      invoiceNumber,
      issuer,
      fiscalYear,
      sequenceNumber,
    })

    return {
      invoiceNumber: created.invoiceNumber,
      sequenceNumber: created.sequenceNumber,
      fiscalYear: created.fiscalYear,
      issuer: created.issuer,
      issuedAt: created.issuedAt,
      newlyAssigned: true,
    }
  })
}

/**
 * Lookup an existing assignment without creating one. Returns null
 * when no invoice has been issued yet for the order.
 */
export async function getInvoiceForOrder(
  orderId: string,
): Promise<FiscalInvoiceAssignment | null> {
  const inv = await prisma.fiscalInvoice.findUnique({
    where: { orderId },
  })
  if (!inv) return null
  return {
    invoiceNumber: inv.invoiceNumber,
    sequenceNumber: inv.sequenceNumber,
    fiscalYear: inv.fiscalYear,
    issuer: inv.issuer,
    issuedAt: inv.issuedAt,
    newlyAssigned: false,
  }
}
