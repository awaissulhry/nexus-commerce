import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { PRICE_LIST_KINDS } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { CARRIER_CODE_MAX, INCOTERMS_2020, INVOICE_TIMINGS } from '@nexus/factory-domain/sales/terms/terms'
import {
  addressBody,
  blockBody,
  contactBody,
  createPartyBody,
  defaultAddressesBody,
  listPartiesQuery,
  partyRow,
  partyView,
  statusBody,
  taxIdentityBody,
  updateAddressBody,
  updateContactBody,
  updatePartyBody,
  updateTaxIdentityBody,
  viesCheckBody,
  viesCheckView,
  viesHistoryQuery,
  viesStandingView,
} from '@nexus/factory-domain/parties/contracts'

/** The party routes' contracts (A2 SCR-032, 033, 056, 057): the bodies and answers are factory-domain's parties/contracts. */

const one = { 200: output({ party: partyView }) }
const created = { 201: output({ party: partyView }) }
const party = input({ partyId: id() })

export const listPartiesContract = defineContract({
  querystring: listPartiesQuery,
  response: { 200: output({ parties: z.array(partyRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})
export const getPartyContract = defineContract({ params: party, response: one })
export const createPartyContract = defineContract({ body: createPartyBody, response: created })
export const updatePartyContract = defineContract({ params: party, body: updatePartyBody, response: one })
export const statusContract = defineContract({ params: party, body: statusBody, response: one })
export const blockContract = defineContract({ params: party, body: blockBody, response: one })
export const addAddressContract = defineContract({ params: party, body: addressBody, response: created })
export const updateAddressContract = defineContract({ params: input({ partyId: id(), addressId: id() }), body: updateAddressBody, response: one })
export const defaultAddressesContract = defineContract({ params: party, body: defaultAddressesBody, response: one })
export const addContactContract = defineContract({ params: party, body: contactBody, response: created })
export const updateContactContract = defineContract({ params: input({ partyId: id(), contactId: id() }), body: updateContactBody, response: one })
export const addTaxIdentityContract = defineContract({ params: party, body: taxIdentityBody, response: created })
export const updateTaxIdentityContract = defineContract({ params: input({ partyId: id(), taxIdentityId: id() }), body: updateTaxIdentityBody, response: one })
export const viesHistoryContract = defineContract({ params: party, querystring: viesHistoryQuery, response: { 200: output({ checks: z.array(viesCheckView), nextCursor: z.string().nullable() }) } })
export const checkViesContract = defineContract({ params: party, body: viesCheckBody, response: { 201: output({ check: viesCheckView, vies: viesStandingView, party: partyView }) } })

// B-W2a-19 (SAL-012): the customer's commercial terms (modules/parties commercial-terms.ts).
const chainList = output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(PRICE_LIST_KINDS), currency: z.string(), status: z.string(), companyId: id().nullable() })
export const commercialTermsView = output({
  partyId: id(),
  code: z.string(),
  companyId: id().nullable(),
  currency: z.string(),
  language: z.string(),
  paymentTermsId: id().nullable(),
  paymentTerms: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.string(), summary: output({ it: z.string(), en: z.string() }), deposit: output({ sharePct: z.string(), days: z.number().int() }).nullable() }).nullable(),
  paymentTermsText: z.string().nullable(),
  priceListId: notMoney(id().nullable()),
  priceList: notMoney(chainList.nullable()),
  discountGroup: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  priceChain: notMoney(z.array(chainList)),
  defaultDepositPct: z.string().nullable(),
  invoiceTiming: z.enum(INVOICE_TIMINGS),
  invoiceTypePreset: z.enum(['TD01', 'TD24']),
  incoterm: z.string().nullable(),
  preferredCarrierCode: z.string().nullable(),
  minimumOrderAmount: money.price(z.number().int().nullable()),
  version: z.number().int(),
})
export const getCommercialTermsContract = defineContract({ params: party, response: { 200: output({ terms: commercialTermsView }) } })
export const updateCommercialTermsContract = defineContract({
  params: party,
  body: input({
    version: z.number().int().min(1),
    currency: currency().optional(),
    language: z.string().trim().toLowerCase().length(2).optional(),
    paymentTermsId: id().nullish(),
    priceListId: notMoney(id().nullish()),
    defaultDepositPct: z.string().trim().max(12).nullish(),
    invoiceTiming: z.enum(INVOICE_TIMINGS).optional(),
    incoterm: z.enum(INCOTERMS_2020).nullish(),
    preferredCarrierCode: z.string().trim().min(1).max(CARRIER_CODE_MAX).nullish(),
    /** Net, in the customer's currency, minor units. */
    minimumOrderAmount: money.price(amountMinor().min(0).nullable()),
  }),
  response: { 200: output({ terms: commercialTermsView }) },
})
