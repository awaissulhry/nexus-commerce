import { InvoiceChargeKind, InvoiceDocType, InvoiceLineKind, InvoicePriceBasis, PaymentMethod, PaymentReminderStatus, RefundStatus, ReminderAction } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedMoney, type MoneySeed } from './money'

/**
 * The receivables seed (W2a schema wave 7/7), per tenant of seed/_core.ts, written in the tenant's office scope as the
 * app does:
 *
 *   charge lines   a DRAFT TD01 to P1 for the leather swatch book sent at its charge: a SAMPLES charge (25.00 EUR) and
 *                  its FREIGHT (12.00 EUR), VAT 22 %. (A draft of its own: the money seed's TD24 of SH-0001 stays as W1
 *                  made it.)
 *   overpayment    P1 paid 100.00 EUR a second time by mistake (a duplicate transfer, nothing allocated): a credit balance.
 *   refund         50.00 EUR of it to pay back, DUE (the customer keeps the rest on account).
 *   ladder         the tenant-wide receivables settings: three steps (3 days before the due date by e-mail, 7 days late by
 *                  e-mail, 30 days late by letter), reminders switched OFF (the Owner's switch), the late-payment rule
 *                  UNDECIDED (the accountant's, D.Lgs. 231/2002).
 *   reminder       level 1 for FT-2026-00001 (due 2026-11-27, 410.00 EUR open), PREPARED by the ladder, waiting for a person.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: a refund must fit again in its payment (50.00 + 50.00 of the 100.00 transfer), a reminder starts PREPARED. So the
 * refund, the reminder and the settings get ids that start with eight zeros (still derived from the namespace); rows this
 * seed adds to other modules' tables (the payment, the charge draft and its lines) start with eight f's, so they never become those
 * tables' first rows.
 *
 * Every name, number and amount is invented; the reminder's text is a placeholder for the accountant's wording.
 * Idempotent: each record is written once, in one transaction, and skipped when it exists.
 */

const T = {
  charged: new Date('2026-11-25T09:30:00.000Z'),
  overpaid: new Date('2026-11-12T09:00:00.000Z'),
  refundDue: new Date('2026-11-13T10:00:00.000Z'),
  settings: new Date('2026-11-01T08:00:00.000Z'),
  prepared: new Date('2026-11-24T06:00:00.000Z'),
} as const
const DAY = {
  overpaid: new Date('2026-11-12T00:00:00.000Z'),
  refundBy: new Date('2026-11-26T00:00:00.000Z'),
  sampleDue: new Date('2026-11-27T00:00:00.000Z'),
} as const

/** The charge draft: the swatch book (25.00) and its freight (12.00), net, and the VAT at 22 %, minor units. */
const CHARGES = { samples: 2500, freight: 1200, net: 3700, vat: 814 } as const
/** The made-up buyer data of P1, as seed/money.ts invoices it. */
const BILL_TO = {
  kind: 'IT_BUSINESS',
  vatNumber: '00000001016',
  fiscalCode: '00000001016',
  name: 'Seed Customer One S.r.l.',
  address: { street: 'Via Esempio', streetNumber: '10', postcode: '00000', city: 'Seedville', province: 'MI', country: 'IT' },
  sdiCode: 'SEEDC01',
} as const

export interface ReceivablesSeed {
  readonly money: MoneySeed
  /** The DRAFT TD01 of charges and its SAMPLES and FREIGHT lines. */
  readonly chargeInvoiceId: string
  readonly chargeLineIds: readonly [string, string]
  /** The duplicate transfer of P1 (100.00, unplaced) and the refund DUE of 50.00 of it. */
  readonly overpaymentId: string
  readonly refundId: string
  /** The tenant-wide receivables settings (id = the tenant's) and the PREPARED level-1 reminder of FT-2026-00001. */
  readonly settingsId: string
  readonly reminderId: string
}

export async function seed(context: SeedContext): Promise<ReceivablesSeed> {
  const { db, namespace } = context
  // The CLI runs the seeds in name order; the invoices, the payments and the parties come from the money seed (it runs
  // the shipping, sales and earlier seeds; all idempotent).
  const money = await seedMoney(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lastId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const P1 = id('party:P1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const select = { id: true } as const

  const ids: Omit<ReceivablesSeed, 'money'> = {
    chargeInvoiceId: lastId('receivables:invoice:TD01:P1:swatches'),
    chargeLineIds: [lastId('receivables:invoice:TD01:P1:swatches:1'), lastId('receivables:invoice:TD01:P1:swatches:2')],
    overpaymentId: lastId('receivables:payment:P1:duplicate'),
    refundId: firstId('receivables:refund:P1:duplicate'),
    settingsId: tenantId,
    reminderId: firstId('receivables:reminder:FT-2026-00001:1'),
  }

  // --- a DRAFT TD01 of charges: the swatch book and its freight ----------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.invoice.findUnique({ where: { id: ids.chargeInvoiceId }, select })) return
      await tx.invoice.create({
        data: {
          id: ids.chargeInvoiceId,
          companyId: companyA,
          buyerPartyId: P1,
          docType: InvoiceDocType.TD01,
          priceBasis: InvoicePriceBasis.NET,
          billTo: BILL_TO,
          netTotal: CHARGES.net,
          vatTotal: CHARGES.vat,
          grossTotal: CHARGES.net + CHARGES.vat,
          vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: CHARGES.net, vat: CHARGES.vat, rounding: 0 }],
          paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: CHARGES.net + CHARGES.vat, dueDate: '2026-12-31' }] },
          causale: 'Campionario pelli inviato su richiesta',
          createdAt: T.charged,
          updatedAt: T.charged,
          createdById: actorId,
        },
        select,
      })
      const charge = (seq: 1 | 2, chargeKind: InvoiceChargeKind, description: string, net: number) => ({
        id: ids.chargeLineIds[seq - 1] as string,
        invoiceId: ids.chargeInvoiceId,
        buyerPartyId: P1,
        seq,
        kind: InvoiceLineKind.CHARGE,
        chargeKind,
        description,
        quantity: '1.0000',
        unitPrice: `${net / 100}.000000`,
        netAmount: net,
        vatRatePct: '22.00',
        createdAt: T.charged,
        updatedAt: T.charged,
        createdById: actorId,
      })
      await tx.invoiceLine.createMany({
        data: [
          charge(1, InvoiceChargeKind.SAMPLES, 'Campionario colori pelle (made up)', CHARGES.samples),
          charge(2, InvoiceChargeKind.FREIGHT, 'Spedizione del campionario', CHARGES.freight),
        ],
      })
    }),
  )

  // --- a duplicate transfer of P1 and the refund of half of it --------------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      if (await tx.payment.findUnique({ where: { id: ids.overpaymentId }, select })) return
      await tx.payment.create({
        data: {
          id: ids.overpaymentId,
          companyId: companyA,
          partyId: P1,
          method: PaymentMethod.BANK_TRANSFER,
          amount: 10_000,
          currency: 'EUR',
          receivedOn: DAY.overpaid,
          externalRef: 'SEED-CRO-DUPLICATE-0001',
          internalNote: 'The customer paid FT-2026-00001 on account a second time by mistake (made up).',
          createdAt: T.overpaid,
          updatedAt: T.overpaid,
          createdById: actorId,
        },
        select,
      })
      await tx.refund.create({
        data: {
          id: ids.refundId,
          companyId: companyA,
          partyId: P1,
          paymentId: ids.overpaymentId,
          method: PaymentMethod.BANK_TRANSFER,
          amount: 5_000,
          currency: 'EUR',
          dueDate: DAY.refundBy,
          status: RefundStatus.DUE,
          internalNote: 'Half back on request; the other half stays on account (made up).',
          createdAt: T.refundDue,
          updatedAt: T.refundDue,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  // --- the reminder ladder and the first reminder of FT-2026-00001 -----------------------------------------------------
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.receivablesSettings.createMany({
        data: [
          {
            id: ids.settingsId,
            companyId: null,
            remindersEnabled: false,
            ladder: [
              { level: 1, offsetDays: -3, action: 'EMAIL', template: 'BEFORE_DUE' },
              { level: 2, offsetDays: 7, action: 'EMAIL', template: 'LATE_7' },
              { level: 3, offsetDays: 30, action: 'LETTER', template: 'LATE_30' },
            ],
            createdAt: T.settings,
            updatedAt: T.settings,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      if (await tx.paymentReminder.findUnique({ where: { id: ids.reminderId }, select })) return
      await tx.paymentReminder.create({
        data: {
          id: ids.reminderId,
          companyId: companyA,
          partyId: P1,
          level: 1,
          action: ReminderAction.EMAIL,
          invoiceIds: [money.sampleInvoiceId],
          amountDue: 41_000,
          currency: 'EUR',
          oldestDueDate: DAY.sampleDue,
          language: 'it',
          subject: 'Promemoria: fattura FT-2026-00001 in scadenza il 27/11/2026',
          body: 'Testo di esempio del promemoria (la formulazione definitiva è del commercialista).',
          status: PaymentReminderStatus.PREPARED,
          createdAt: T.prepared,
          updatedAt: T.prepared,
          createdById: actorId,
        },
        select,
      })
    }),
  )

  return { money, ...ids }
}
