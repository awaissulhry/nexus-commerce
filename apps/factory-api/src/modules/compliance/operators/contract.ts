import { z } from 'zod'
import { ADDRESS_MAX, CONTACT_MAX, NAME_MAX, NOTE_MAX, OPERATOR_ROLES, SCOPE_LEVELS } from '@nexus/factory-domain/compliance/operators/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Economic operators per style and market (B-W2b-249; PRD-298; design compliance.settings › rm-operators): who is the
 * manufacturer, authorised representative, importer, distributor or fulfilment provider, with the name, postal address
 * and contact as printed on labels and DoCs. No price, no cost, no person.
 */

const version = () => z.number().int().min(1)

export const operatorView = output({
  id: id(),
  role: z.enum(OPERATOR_ROLES),
  /** STYLE, BRAND (its private-label styles), COMPANY (its styles), TENANT (every style). */
  level: z.enum(SCOPE_LEVELS),
  companyId: id().nullable(),
  style: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  brand: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** null: every market. */
  marketCode: z.string().nullable(),
  /** null: our company (the manufacturer only). */
  party: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  printedName: z.string(),
  printedAddress: z.string(),
  contact: z.string().nullable(),
  validFrom: businessDate(),
  validTo: businessDate().nullable(),
  /** Valid on the day asked (today by default). */
  validOnDay: z.boolean(),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type OperatorView = z.infer<typeof operatorView>

export const listOperatorsContract = defineContract({
  querystring: input({
    styleId: id().optional(),
    brandPartyId: id().optional(),
    marketCode: z.string().trim().min(2).max(40).optional(),
    role: z.enum(OPERATOR_ROLES).optional(),
    /** The day validity is read on; default today. */
    on: businessDate().optional(),
    /** true: only the rows valid on the day. */
    current: z.enum(['true', 'false']).optional(),
  }),
  response: { 200: output({ operators: z.array(operatorView), day: businessDate(), asOf: instant(), mayManage: z.boolean() }) },
})

export const resolveOperatorsContract = defineContract({
  querystring: input({
    styleId: id(),
    marketCode: z.string().trim().min(2).max(40).optional(),
    on: businessDate().optional(),
    /** The company that makes it, for a style of every company (the batch's company); default the style's. */
    companyId: id().optional(),
  }),
  response: {
    200: output({
      style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), brandPartyId: id().nullable(), soldUnderOurName: z.boolean() }),
      marketCode: z.string().nullable(),
      day: businessDate(),
      /** Per role, the row that applies (the most specific): style, brand, company, tenant; the market's before every market's. */
      operators: z.array(output({ role: z.enum(OPERATOR_ROLES), level: z.enum(SCOPE_LEVELS), forMarket: z.boolean(), operator: operatorView })),
      /** What the market needs: a manufacturer always; an importer or authorised representative where the market says so. */
      needs: z.array(output({ role: z.enum(['MANUFACTURER', 'IMPORTER_OR_REPRESENTATIVE', 'GPSR_CONTACT']), met: z.boolean() })),
    }),
  },
})

const operatorParams = input({ operatorId: id() })

export const getOperatorContract = defineContract({ params: operatorParams, response: { 200: output({ operator: operatorView }) } })

const fields = {
  printedName: z.string().trim().min(1).max(NAME_MAX),
  printedAddress: z.string().trim().min(1).max(ADDRESS_MAX),
  contact: z.string().trim().min(1).max(CONTACT_MAX).nullable(),
  validFrom: businessDate(),
  validTo: businessDate().nullable(),
  note: z.string().trim().min(1).max(NOTE_MAX).nullable(),
}

export const createOperatorContract = defineContract({
  body: input({
    role: z.enum(OPERATOR_ROLES),
    /** One of: a style, a brand (a BRAND party: its private-label styles), or neither (a company's or every style). */
    styleId: id().nullable().optional(),
    brandPartyId: id().nullable().optional(),
    /** A company's default (no style): its company; a brand's for one company. Ignored for a style (the style's company). */
    companyId: id().nullable().optional(),
    marketCode: z.string().trim().min(2).max(40).nullable().optional(),
    /** The operator; leave it out only for a manufacturer that is our own company. */
    partyId: id().nullable().optional(),
    printedName: fields.printedName,
    printedAddress: fields.printedAddress,
    contact: fields.contact.optional(),
    validFrom: fields.validFrom,
    validTo: fields.validTo.optional(),
    note: fields.note.optional(),
  }),
  response: { 200: output({ operator: operatorView }) },
})

export const editOperatorContract = defineContract({
  params: operatorParams,
  body: input({
    version: version(),
    partyId: id().nullable().optional(),
    printedName: fields.printedName.optional(),
    printedAddress: fields.printedAddress.optional(),
    contact: fields.contact.optional(),
    validFrom: fields.validFrom.optional(),
    /** A last day ends the row (a row is never removed). */
    validTo: fields.validTo.optional(),
    note: fields.note.optional(),
  }),
  response: { 200: output({ operator: operatorView }) },
})
