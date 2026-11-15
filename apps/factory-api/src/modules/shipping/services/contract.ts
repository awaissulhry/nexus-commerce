import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INTEGRATION_MODES } from '@nexus/factory-domain/ports/provider'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { BILLED_TO, BOOKING_WARNINGS, SERVICE_REFUSALS } from '@nexus/factory-domain/shipping/services/booking'
import { CARRIER_SERVICES, DESTINATIONS, SERVICE_STATES } from '@nexus/factory-domain/shipping/services/catalogue'
import { MAX_PARCEL_VALUE } from '@nexus/factory-domain/shipping/services/insurance'
import { FREIGHT_BILLINGS } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { statusSchema, transportBySchema } from '../views'

/**
 * Carrier services (B-W2b-400; LOG-041, LOG-042, Q20). A version is the SHIPMENT's (the booking, a parcel's values), the
 * settings' (the site's rule) or the connection's (the services chosen), as read (COL-078). Values are the price grain:
 * marked, so a reader without money.price gets none and a body that sends one without it is refused.
 */

const version = z.number().int().min(1)
const value = z.number().int().min(0).max(MAX_PARCEL_VALUE)
const dutyPayer = z.enum(['SENDER', 'RECEIVER'])
const shipmentParams = input({ shipmentId: id() })
const problem = <Codes extends readonly [string, ...string[]]>(codes: Codes) => output({ code: z.enum(codes), message: z.string() })
const rule = output({ insure: z.boolean().nullable(), words: z.string() })

export const bookingViewSchema = output({
  shipment: output({
    id: id(),
    number: z.string(),
    status: statusSchema,
    transportBy: transportBySchema,
    carrierCode: z.string().nullable(),
    carrierName: z.string().nullable(),
    serviceCode: z.string().nullable(),
    express: z.boolean(),
    dutyPayer: dutyPayer.nullable(),
    paperless: z.boolean(),
    version: z.number().int(),
  }),
  destination: output({ from: z.string().nullable(), to: z.string().nullable(), kind: z.enum(DESTINATIONS).nullable(), words: z.string() }),
  /** What the carrier offers here (starting values, unverified; a carrier not known refuses nothing). */
  carrier: output({ known: z.boolean(), offers: output({ express: z.boolean(), dutiesPaid: z.boolean(), paperless: z.boolean(), insurance: z.boolean(), customerAccount: z.boolean() }), words: z.string() }),
  testMode: z.boolean(),
  /** The Sendcloud connection the labels are bought with; null: none named (or not needed in test mode). */
  connection: output({ mode: z.enum(INTEGRATION_MODES) }).nullable(),
  billedTo: output({ kind: z.enum(BILLED_TO), words: z.string(), contractId: id().nullable() }),
  /** Our own live contract with the carrier for the site (else the company's); null: none. */
  contract: output({ id: id(), siteId: id().nullable(), ownRatesOnly: z.boolean() }).nullable(),
  customer: output({
    partyId: id(),
    name: z.string(),
    carrierCode: z.string().nullable(),
    carrierName: z.string().nullable(),
    freightBilling: z.enum(FREIGHT_BILLINGS),
    accountOnFile: z.boolean(),
    defaultCarrierService: z.string().nullable(),
    applied: z.boolean(),
  }).nullable(),
  /** The order's currency (the parcels' values) and the company's (the site's rule). */
  currency: z.string(),
  companyCurrency: z.string(),
  insureAbove: money.price(z.number().int().nullable()),
  parcels: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      labelled: z.boolean(),
      goodsValue: money.price(z.number().int()),
      declaredValue: money.price(z.number().int().nullable()),
      insuredValue: money.price(z.number().int().nullable()),
      rule,
      version: z.number().int(),
    }),
  ),
  insuredParcels: z.number().int(),
  insuredTotal: money.price(z.number().int()),
  /** The booking cost's lines: each service used, its state and its cost in words (no figure is invented). */
  extras: z.array(output({ service: z.enum(CARRIER_SERVICES), state: z.enum(SERVICE_STATES), words: z.string(), stateWords: z.string(), costWords: notMoney(z.string()) })),
  /** What stops the booking (the label buy refuses the same, 409 `refusal/<CODE>`). */
  problems: z.array(problem(SERVICE_REFUSALS)),
  warnings: z.array(problem(BOOKING_WARNINGS)),
  bookable: z.boolean(),
  may: output({ change: output({ allowed: z.boolean(), refusal: problem(SERVICE_REFUSALS).nullable() }) }),
})

export const getBookingContract = defineContract({ params: shipmentParams, response: { 200: bookingViewSchema } })

export const setServicesContract = defineContract({
  params: shipmentParams,
  body: input({
    version: version.optional(),
    serviceCode: z.string().trim().min(1).max(100).nullable().optional(),
    express: z.boolean().optional(),
    dutyPayer: dutyPayer.nullable().optional(),
    paperless: z.boolean().optional(),
    /** Take the customer's carrier and default service (a service code sent wins). */
    customerDefaults: z.boolean().optional(),
  }),
  response: { 200: bookingViewSchema },
})

export const setParcelValueContract = defineContract({
  params: input({ shipmentId: id(), parcelId: id() }),
  /** `insuredValue` absent: by the site's rule; null: not insured. */
  body: input({ version: version.optional(), declaredValue: money.price(value.nullable()), insuredValue: money.price(value.nullable()) }),
  response: { 200: bookingViewSchema },
})

export const valuesByRuleContract = defineContract({ params: shipmentParams, body: input({ version: version.optional() }), response: { 200: bookingViewSchema } })

const ruleView = output({
  siteId: id(),
  siteCode: z.string(),
  hasSettings: z.boolean(),
  insureAbove: money.price(z.number().int().nullable()),
  currency: z.string(),
  words: z.string(),
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
})

export const getInsuranceRuleContract = defineContract({ params: input({ siteId: id() }), response: { 200: output({ rule: ruleView }) } })

export const setInsuranceRuleContract = defineContract({
  params: input({ siteId: id() }),
  body: input({ version: version.optional(), insureAbove: money.price(value.nullable()) }),
  response: { 200: output({ rule: ruleView }) },
})

const connectionView = output({
  accountId: id(),
  companyId: id(),
  code: z.string(),
  label: z.string(),
  mode: z.enum(INTEGRATION_MODES),
  status: z.string(),
  version: z.number().int(),
  services: z.array(output({ service: z.enum(CARRIER_SERVICES), chosen: z.boolean(), mapped: z.boolean(), verified: z.boolean(), words: z.string(), costWords: notMoney(z.string()) })),
  contracts: z.array(output({ carrierCode: z.string(), providerContractId: z.number().int() })),
  words: z.string(),
})

export const listCarrierServicesContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: output({ connections: z.array(connectionView) }) } })

export const setCarrierServicesContract = defineContract({
  params: input({ accountId: id() }),
  body: input({
    version,
    services: z.array(z.enum(CARRIER_SERVICES)).max(CARRIER_SERVICES.length),
    contracts: z.array(input({ carrierCode: z.string().trim().min(1).max(40), providerContractId: z.number().int().min(1).max(2_147_483_647) })).max(50),
  }),
  response: { 200: output({ connection: connectionView }) },
})
