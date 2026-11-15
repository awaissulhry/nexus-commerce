import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FREIGHT_BILLINGS } from '@nexus/factory-domain/shipping/carrier-accounts/rules'

/**
 * Carrier accounts (B-W2b-400; LOG-033 our own contracts per company and site, LOG-038 the customer's carrier account). An
 * account number is WRITE-ONLY: sent once, sealed, never answered (only `endsIn`, its last four characters taken from the
 * request at that moment, never kept) and never in an audit row, an event or a receipt. No money.
 */

const version = z.number().int().min(1)
const accountNumber = z.string().trim().min(3).max(40)

export const contractView = output({
  id: id(),
  companyId: id(),
  /** Null: every site of the company. */
  siteId: id().nullable(),
  siteCode: z.string().nullable(),
  carrierCode: z.string(),
  carrierName: z.string(),
  /** Labels for this carrier are bought only on this contract ("use only our rates"). */
  ownRatesOnly: z.boolean(),
  active: z.boolean(),
  /** A sealed number is on file (never shown). */
  numberOnFile: z.boolean(),
  words: z.string(),
  /** With `siteId` asked: this is the contract a label of that site and carrier is bought on (the site's, else the company's). */
  usedForSite: z.boolean().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

export const listContractsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional(), carrierCode: z.string().trim().min(1).max(40).optional(), includeOff: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ contracts: z.array(contractView) }) },
})

export const addContractContract = defineContract({
  body: input({ companyId: id(), siteId: id().nullable().optional(), carrierCode: z.string().trim().min(1).max(40), accountNumber, ownRatesOnly: z.boolean().optional() }),
  response: { 201: output({ contract: contractView, endsIn: z.string() }) },
})

export const changeContractContract = defineContract({
  params: input({ contractId: id() }),
  /** A new number (asks a fresh step-up) and/or "use only our rates". */
  body: input({ version, accountNumber: accountNumber.optional(), ownRatesOnly: z.boolean().optional() }),
  response: { 200: output({ contract: contractView, endsIn: z.string().nullable() }) },
})

export const switchOffContractContract = defineContract({
  params: input({ contractId: id() }),
  body: input({ version }),
  response: { 200: output({ contract: contractView }) },
})

export const customerAccountView = output({
  partyId: id(),
  code: z.string(),
  name: z.string(),
  /** The customer's carrier (its preferred carrier) and the name a DDT prints. */
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  /** A sealed account number with that carrier is on file (never shown). */
  accountOnFile: z.boolean(),
  freightBilling: z.enum(FREIGHT_BILLINGS),
  freightBillingWords: z.string(),
  defaultCarrierService: z.string().nullable(),
  /** The party's version (the change's edit guard). */
  version: z.number().int(),
})

export const getCustomerAccountContract = defineContract({
  params: input({ partyId: id() }),
  response: { 200: output({ account: customerAccountView }) },
})

export const setCustomerAccountContract = defineContract({
  params: input({ partyId: id() }),
  /**
   * `accountNumber`: a new number (sealed; replaces the one on file), null removes it (the freight goes back to us unless
   * said), absent keeps it. `carrierCode` null clears the carrier (and the account and service with it).
   */
  body: input({
    version,
    carrierCode: z.string().trim().min(1).max(40).nullable().optional(),
    accountNumber: accountNumber.nullable().optional(),
    freightBilling: z.enum(FREIGHT_BILLINGS).optional(),
    defaultCarrierService: z.string().trim().min(1).max(100).nullable().optional(),
  }),
  response: { 200: output({ account: customerAccountView, endsIn: z.string().nullable() }) },
})
