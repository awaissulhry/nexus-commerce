import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The invoice's language and currency (B-W2b-396; FIN-063, PLT-131): what it is written and billed in, the rate it keeps
 * and its euro equivalent; the office's language and typed rate on a draft. Euro amounts are marked money.price (the API
 * drops them for staff without the grain); a rate is not money. A version is the edit-conflict guard.
 */

const invoiceParams = input({ invoiceId: id() })
const version = z.number().int().min(1).optional()

export const languageCurrencyView = output({
  invoiceId: id(),
  version: z.number().int(),
  status: z.string(),
  language: output({
    code: z.string(),
    /** INVOICE: set on the invoice; CONTACT / CUSTOMER: what a draft takes now (its invoices contact's, else the customer's). */
    source: z.enum(['INVOICE', 'CONTACT', 'CUSTOMER']),
    /** What clearing it would give (the contact's or the customer's). */
    decided: output({ code: z.string(), source: z.enum(['CONTACT', 'CUSTOMER']) }),
  }),
  currency: output({ code: z.string(), companyCurrency: z.string(), euro: z.boolean() }),
  /** Null in euro. TYPED: the office's (a draft); KEPT: the issued invoice's; DAY_RATE: the day's rate the issue would take. */
  rate: output({ exchangeRate: z.string(), rateDate: businessDate(), source: z.enum(['TYPED', 'KEPT', 'DAY_RATE']), words: z.string() }).nullable(),
  /** The total, taxable amount and VAT in euro at that rate (null in euro or without a rate). */
  euro: money.price(output({ netEur: z.number().int(), vatEur: z.number().int(), grossEur: z.number().int() }).nullable()),
  /** No rate yet, in words (the issue waits for one); null when there is one or in euro. */
  waits: z.string().nullable(),
  /** The rule waiting for the accountant (GATE-ACCOUNTANT). */
  rule: output({ status: z.literal('UNVERIFIED'), words: z.string() }),
})

export const languageCurrencyContract = defineContract({ params: invoiceParams, response: { 200: output({ languageCurrency: languageCurrencyView }) } })

export const putLanguageContract = defineContract({
  params: invoiceParams,
  body: input({
    version,
    /** ISO 639-1; null: decided again (the invoices contact's, else the customer's). */
    language: z.string().trim().min(2).max(2).nullable(),
  }),
  response: { 200: output({ languageCurrency: languageCurrencyView }) },
})

export const putRateContract = defineContract({
  params: invoiceParams,
  body: input({
    version,
    /** Units of the invoice's currency per euro (1.0850); null: the issue takes the day's rate. */
    exchangeRate: z.string().trim().max(30).nullable(),
    /** The rate's day (today or before); with a rate only. */
    rateDate: businessDate().optional(),
  }),
  response: { 200: output({ languageCurrency: languageCurrencyView }) },
})
