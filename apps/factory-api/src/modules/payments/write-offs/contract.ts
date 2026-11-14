import { z } from 'zod'
import { amountMinor, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { MAX_WRITE_OFF_NOTE, WRITE_OFF_KINDS, WRITE_OFF_REASONS } from '@nexus/factory-domain/payments/write-offs/write-offs'

/** The write-off routes' contracts (B-W2b-393; FIN-119). Amounts marked money.price. */

const kind = z.enum(WRITE_OFF_KINDS)
const paymentParams = input({ paymentId: z.string() })
const source = z.enum(['COMPANY', 'TENANT']).nullable()

export const listWriteOffsContract = defineContract({
  params: paymentParams,
  response: {
    200: output({
      paymentId: id(),
      tolerance: output({ amount: money.price(z.number().int().nullable()), source }),
      writeOffs: z.array(
        output({
          id: id(),
          kind,
          kindWords: z.string(),
          allocationId: id().nullable(),
          invoiceId: id().nullable(),
          amount: money.price(z.number().int()),
          reason: z.enum(WRITE_OFF_REASONS),
          reasonWords: z.string(),
          note: z.string().nullable(),
          toleranceAmount: money.price(z.number().int()),
          reversalOfId: id().nullable(),
          reversed: z.boolean(),
          writtenOffById: id(),
          createdAt: instant(),
        }),
      ),
      possible: z.array(output({ kind, allocationId: id().nullable(), invoiceId: id().nullable(), number: z.string().nullable(), amount: money.price(z.number().int()), withinTolerance: z.boolean() })),
    }),
  },
})

export const writeOffContract = defineContract({
  params: paymentParams,
  body: input({ kind, allocationId: id().optional(), reason: z.enum(WRITE_OFF_REASONS), note: z.string().max(MAX_WRITE_OFF_NOTE).nullish() }),
  response: { 201: output({ writeOffId: id(), paymentId: id(), kind, amount: money.price(z.number().int()) }) },
})

export const reverseWriteOffContract = defineContract({
  params: input({ paymentId: z.string(), writeOffId: z.string() }),
  body: input({ note: z.string().trim().min(1).max(MAX_WRITE_OFF_NOTE) }),
  response: { 200: output({ writeOffId: id(), reversalOfId: id(), paymentId: id() }) },
})

const toleranceView = output({
  companyId: id(),
  inForce: output({ amount: money.price(z.number().int().nullable()), source }),
  company: output({ settingsId: id(), version: z.number().int(), amount: money.price(z.number().int().nullable()) }).nullable(),
  tenant: output({ settingsId: id(), version: z.number().int(), amount: money.price(z.number().int().nullable()) }).nullable(),
  mayChange: z.boolean(),
})

export const getToleranceContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: toleranceView },
})

export const putToleranceContract = defineContract({
  body: input({ companyId: id().nullable(), amount: money.price(amountMinor().nullable()), version: z.number().int().min(1).optional() }),
  response: { 200: output({ settingsId: id(), version: z.number().int(), tolerance: toleranceView.nullable() }) },
})
