import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INSTALMENT_EVENTS, PAYMENT_METHOD_CODES, TERMS_LIMITS } from '@nexus/factory-domain/sales/terms/terms'

/**
 * The payment terms library's contracts (B-W2a-19; FIN-075; design finance.settings "Payment terms"). No money: shares
 * in percent and days only. The entry's `version` is the edit-conflict guard of every write (COL-078).
 */

const version = z.number().int().min(1)
const pct = z.string().trim().max(12)
const days = z.number().int().min(0).max(TERMS_LIMITS.days)

const instalmentInput = input({
  /** Percent of the whole, above 0 and at most 100, 4 decimals at most; the shares total 100. */
  sharePct: pct,
  /** The event it counts from. */
  from: z.enum(INSTALMENT_EVENTS),
  /** Days after it. */
  days,
  /** The due day moves to the last day of its month ("d.f.f.m."). */
  endOfMonth: z.boolean().optional(),
})

const fields = {
  code: z.string().trim().min(1).max(TERMS_LIMITS.code),
  /** The printed name in the company's language. */
  name: z.string().trim().min(1).max(TERMS_LIMITS.name),
  /** The printed name in other languages, ISO 639-1 → text. */
  nameI18n: z.record(z.string().trim().min(2).max(2), z.string().trim().max(TERMS_LIMITS.name)).nullish(),
  /** FatturaPA ModalitaPagamento. */
  method: z.enum(PAYMENT_METHOD_CODES as [string, ...string[]]),
  instalments: z.array(instalmentInput).min(1).max(TERMS_LIMITS.instalments),
  earlyPaymentDiscountPct: pct.nullish(),
  earlyPaymentDays: days.nullish(),
}

export const termsView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable(),
  method: z.string(),
  instalments: z.array(output({ sharePct: z.string(), from: z.enum(INSTALMENT_EVENTS), days: z.number().int(), endOfMonth: z.boolean() })),
  earlyPaymentDiscountPct: z.string().nullable(),
  earlyPaymentDays: z.number().int().nullable(),
  deposit: output({ sharePct: z.string(), days: z.number().int() }).nullable(),
  summary: output({ it: z.string(), en: z.string() }),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  customers: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const one = { 200: output({ terms: termsView }) }
const params = input({ termsId: id() })

export const listTermsContract = defineContract({
  querystring: input({
    /** What this company may use: its own terms and every company's. */
    companyId: id().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: { 200: output({ terms: z.array(termsView) }) },
})
export const getTermsContract = defineContract({ params, response: one })
export const createTermsContract = defineContract({ body: input({ companyId: id().nullish(), ...fields }), response: { 201: output({ terms: termsView }) } })
export const updateTermsContract = defineContract({ params, body: input({ ...fields, version }).partial().required({ version: true }), response: one })
export const moveTermsContract = defineContract({ params, body: input({ version }), response: one })
