import { InvoiceDocType, InvoiceLineKind, InvoicePriceBasis } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedMoney } from './money'

/**
 * A draft invoice that issues on ANY day (B-W2b-F59), per tenant of seed/_core.ts, written in the tenant's office scope as the
 * invoicing module writes a draft. It runs the money seed first (idempotent: company A's invoice series, party P1).
 *
 *   TD01   company A to party P1: an IMMEDIATE invoice (no DDT) of one service, the team logo's embroidery set-up, 100.00 + VAT
 *          22 %, paid by bank transfer (MP05) with no due day fixed. A draft has no date: its issue dates it, so no legal
 *          window can close on it (an immediate invoice is dated the day of the operation; DPR 633/1972 art. 21). The money
 *          seed's TD24 of DDT 144 (October 2026) stays as the story wrote it: a deferred invoice for October DDTs is issued by
 *          15 November, so from 16 November its issue is refused in words (TD24_LATE), as it would be for a real late invoice;
 *          this draft is the one a fresh seed lets the office issue, send to the (FAKE) SDI and see Delivered.
 *
 * Every row's id starts with eight f's (never a table's first row for the generated isolation tests). Made up and harmless;
 * idempotent: skipped when the draft exists.
 */

/** When the draft was typed: history (before the seeds' day, F53's calendar rule: it never moves). */
const TYPED = new Date('2026-11-14T10:00:00.000Z')

export interface InvoiceDraftSeed {
  readonly invoiceId: string
  readonly lineId: string
}

export async function seed(context: SeedContext): Promise<InvoiceDraftSeed> {
  const { db, namespace } = context
  await seedMoney(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const P1 = id('party:P1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const select = { id: true } as const
  const result: InvoiceDraftSeed = { invoiceId: lateId('invoice-draft:TD01:P1:embroidery'), lineId: lateId('invoice-draft:TD01:P1:embroidery:1') }
  const stamp = { createdAt: TYPED, updatedAt: TYPED, createdById: actorId }
  const billTo = {
    kind: 'IT_BUSINESS',
    vatNumber: '00000001016',
    fiscalCode: '00000001016',
    name: 'Seed Customer One S.r.l.',
    address: { street: 'Via Esempio', streetNumber: '10', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
    sdiCode: 'SEEDC01',
  }

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: result.invoiceId }, select })) return
      await tx.invoice.create({
        data: {
          id: result.invoiceId,
          companyId: id('company:A'),
          buyerPartyId: P1,
          docType: InvoiceDocType.TD01,
          priceBasis: InvoicePriceBasis.NET,
          billTo,
          netTotal: 10000,
          vatTotal: 2200,
          grossTotal: 12200,
          vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 10000, vat: 2200, rounding: 0 }],
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 12200 }] },
          ...stamp,
        },
        select,
      })
      await tx.invoiceLine.create({
        data: {
          id: result.lineId,
          invoiceId: result.invoiceId,
          buyerPartyId: P1,
          seq: 1,
          kind: InvoiceLineKind.SERVICE,
          description: 'Team logo embroidery set-up (made up)',
          quantity: '1.0000',
          uom: 'PZ',
          unitPrice: '100.000000',
          netAmount: 10000,
          vatRatePct: '22.00',
          ...stamp,
        },
        select,
      })
    }),
  )
  return result
}
