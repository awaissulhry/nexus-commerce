import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Money not placed on an invoice and a small difference written off (B-W2b-425 on B-W2b-393's API; design finance.payments
 * tile "Not placed on an invoice", rec:Payment allocation "small difference → write-off within tolerance"). Every answer
 * is checked with zod; every amount is a price, absent without money.price (never zero). The lists mirror factory-domain
 * payments/write-offs (the tests hold them equal); the API's English words are never drawn.
 */

export const WRITE_OFF_KINDS = ['UNDERPAYMENT', 'OVERPAYMENT'] as const
export type WriteOffKind = (typeof WRITE_OFF_KINDS)[number]
export const WRITE_OFF_REASONS = ['ROUNDING', 'BANK_CHARGES', 'OTHER'] as const
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]
export const WRITE_OFF_REFUSALS = ['NO_TOLERANCE', 'OVER_TOLERANCE', 'NOTHING_LEFT', 'SHORT_ON_SEVERAL', 'SHORT_ON_DEPOSIT', 'NOTE_NEEDED', 'NOT_RECEIVED', 'NOT_AN_INVOICE_ALLOCATION', 'REVERSED_ALREADY', 'A_REVERSAL'] as const
export const MAX_WRITE_OFF_NOTE = 500

const price = <T extends z.ZodTypeAny>(schema: T) => schema.optional()

const unappliedSchema = z.object({
  companyId: z.string(),
  tolerance: price(z.number().nullable()),
  totals: z.object({ count: z.number(), amounts: z.array(z.object({ currency: z.string(), amount: price(z.number()) })) }),
  payments: z.array(
    z.object({
      id: z.string(),
      party: z.object({ id: z.string(), code: z.string(), legalName: z.string() }),
      receivedOn: z.string(),
      externalRef: z.string(),
      currency: z.string(),
      amount: price(z.number()),
      unplacedAmount: price(z.number()),
      waitingDays: z.number(),
      openItems: z.number(),
      writeOffWithinTolerance: z.boolean(),
      bankLine: z.object({ id: z.string(), bookedOn: z.string() }).nullable(),
    }),
  ),
  nextCursor: z.number().nullable(),
})
export type Unapplied = z.infer<typeof unappliedSchema>
export type UnappliedPayment = Unapplied['payments'][number]

export const writeOffSchema = z.object({
  id: z.string(),
  kind: z.enum(WRITE_OFF_KINDS),
  allocationId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  amount: price(z.number()),
  reason: z.enum(WRITE_OFF_REASONS),
  note: z.string().nullable(),
  toleranceAmount: price(z.number()),
  reversalOfId: z.string().nullable(),
  reversed: z.boolean(),
  writtenOffById: z.string(),
  createdAt: z.string(),
})
export type WriteOff = z.infer<typeof writeOffSchema>

export const possibleSchema = z.object({ kind: z.enum(WRITE_OFF_KINDS), allocationId: z.string().nullable(), invoiceId: z.string().nullable(), number: z.string().nullable(), amount: price(z.number()), withinTolerance: z.boolean() })
export type PossibleWriteOff = z.infer<typeof possibleSchema>

const writeOffsSchema = z.object({
  paymentId: z.string(),
  tolerance: z.object({ amount: price(z.number().nullable()), source: z.enum(['COMPANY', 'TENANT']).nullable() }),
  writeOffs: z.array(writeOffSchema),
  possible: z.array(possibleSchema),
})
export type PaymentWriteOffs = z.infer<typeof writeOffsSchema>

const enc = encodeURIComponent

/** GET /payments/unapplied (payments.view): the payments with money not placed, oldest waiting first; the tile's totals. */
export function unapplied(api: ApiClient, query: { companyId: string; cursor?: number | null; limit?: number }, signal?: AbortSignal): Promise<Unapplied> {
  return api.get('/payments/unapplied', { query: { companyId: query.companyId, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 }, schema: unappliedSchema, signal })
}

/** GET /payments/:id/write-offs (payments.view): its write-offs and what may be written off now. */
export function paymentWriteOffs(api: ApiClient, paymentId: string, signal?: AbortSignal): Promise<PaymentWriteOffs> {
  return api.get(`/payments/${enc(paymentId)}/write-offs`, { schema: writeOffsSchema, signal })
}

/** POST /payments/:id/write-offs (payments.writeOff): the WHOLE difference written off, with its reason. */
export function writeOff(api: ApiClient, paymentId: string, body: { kind: WriteOffKind; allocationId?: string; reason: WriteOffReason; note?: string | null }, idempotencyKey: string): Promise<{ writeOffId: string }> {
  return api.post(`/payments/${enc(paymentId)}/write-offs`, { body, schema: z.object({ writeOffId: z.string() }), idempotencyKey })
}

/** POST /payments/:id/write-offs/:writeOffId/reverse (payments.writeOff): taken back, with a note why. */
export function reverseWriteOff(api: ApiClient, paymentId: string, writeOffId: string, note: string, idempotencyKey: string): Promise<{ writeOffId: string }> {
  return api.post(`/payments/${enc(paymentId)}/write-offs/${enc(writeOffId)}/reverse`, { body: { note }, schema: z.object({ writeOffId: z.string() }), idempotencyKey })
}
