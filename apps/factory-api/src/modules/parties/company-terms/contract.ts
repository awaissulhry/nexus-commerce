import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { TERMS_LIMITS } from '@nexus/factory-domain/parties/company-terms/terms'

/** The terms-per-company routes' contracts (B-W2b-290; SAL-028, SAL-013; modules/parties/company-terms). */

const label = output({ code: z.string(), name: z.string() })
const source = z.enum(['COMPANY', 'PARTY'])
const termsView = output({
  id: id(),
  companyId: id(),
  paymentTermsId: id().nullable(),
  paymentTermsLabel: label.nullable(),
  paymentTermsText: z.string().nullable(),
  priceListId: notMoney(id().nullable()),
  priceListLabel: notMoney(label.nullable()),
  depositPct: z.string().nullable(),
  poNumberRequired: z.boolean(),
  /** B-W2b-304's: read with the price grain (minor units of its currency). */
  creditLimitAmount: money.price(z.number().int().nullable()),
  creditLimitCurrency: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: instant(),
  endedAt: instant().nullable(),
  endedBy: z.string().nullable(),
  version: z.number().int(),
})
const companyTermsView = output({
  partyId: id(),
  code: z.string(),
  tenantWide: z.boolean(),
  partyVersion: z.number().int(),
  companies: z.array(
    output({
      company: output({ id: id(), code: z.string(), name: z.string() }),
      terms: termsView.nullable(),
      inForce: output({
        paymentTermsId: id().nullable(),
        paymentTermsText: z.string().nullable(),
        priceListId: notMoney(id().nullable()),
        depositPct: z.string().nullable(),
        poNumberRequired: z.boolean(),
        source: output({ paymentTerms: source, priceList: notMoney(source), deposit: source }),
      }),
      mayChange: z.boolean(),
      history: z.array(termsView),
    }),
  ),
})
const answer = output({ terms: companyTermsView })
const target = input({ partyId: id(), companyId: id() })

export const getCompanyTermsContract = defineContract({ params: input({ partyId: id() }), response: { 200: answer } })
export const setCompanyTermsContract = defineContract({
  params: target,
  body: input({
    version: z.number().int().min(1).optional(),
    paymentTermsId: id().nullish(),
    paymentTerms: z.string().max(TERMS_LIMITS.paymentTerms + 100).nullish(),
    priceListId: notMoney(id().nullish()),
    depositPct: z.string().trim().max(12).nullish(),
    poNumberRequired: z.boolean().optional(),
  }),
  response: { 200: answer },
})
export const endCompanyTermsContract = defineContract({ params: target, body: input({ version: z.number().int().min(1) }), response: { 200: answer } })
