import { z } from 'zod'
import { defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { MAX_LEAD_TIME_DAYS, SOURCE_PREFERENCES, SOURCE_STATUSES, SOURCE_TEXT } from '@nexus/factory-domain/purchasing/sources/sources'

/**
 * Approved sources (B-W2a-10; SCM-005; design purchasing.suppliers › Items & prices "Approved sources", Products ›
 * material "Supplier prices"). The supplier's price and the last purchase price are costs: marked money.cost, so the API
 * drops them for a caller without the cost grain (a planner, the warehouse) and refuses a body that sends one. Each write
 * names the `version` it read (COL-078). A source's supplier, company, material and colour never change.
 */

const version = z.number().int().min(1)
const text = (max: number) => z.string().trim().max(max)
const leadTimeDays = z.number().int().min(0).max(MAX_LEAD_TIME_DAYS)

const sourceView = output({
  id: id(),
  /** null: every company of the tenant. */
  companyId: id().nullable(),
  company: output({ code: z.string(), name: z.string() }).nullable(),
  partyId: id(),
  supplier: output({ code: z.string(), name: z.string(), status: z.string() }),
  itemId: id(),
  item: output({ code: z.string(), name: z.string(), kind: z.string(), status: z.string(), baseUom: z.enum(UOMS), purchaseUom: z.enum(UOMS) }),
  /** null: every colour of the material. */
  itemColourId: id().nullable(),
  colour: output({ code: z.string(), name: z.string() }).nullable(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  description: z.string().nullable(),
  /** The unit the supplier sells in, and how many of the material's base unit one of it holds (the material's factor). */
  purchaseUom: z.enum(UOMS),
  purchaseFactor: z.string(),
  baseUom: z.enum(UOMS),
  /** False when the material no longer converts the supplier's unit (its units changed): buys fall back to its own. */
  unitUsable: z.boolean(),
  /** Per `purchaseUom`, in `currency`; null: no price on record yet. */
  unitPrice: money.cost(z.string().nullable()),
  currency: z.string(),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
  /** null: the supplier's usual lead time (`supplierLeadTimeDays`). */
  leadTimeDays: z.number().int().nullable(),
  supplierLeadTimeDays: z.number().int().nullable(),
  preference: z.enum(SOURCE_PREFERENCES),
  status: z.enum(SOURCE_STATUSES),
  note: z.string().nullable(),
  /** The latest purchase order line of this supplier for this material (and colour) that was sent: its price is a cost. */
  lastPurchase: output({
    purchaseOrderId: id(),
    number: z.string(),
    status: z.enum(PURCHASE_ORDER_STATUSES),
    orderDate: z.string(),
    quantity: z.string(),
    uom: z.enum(UOMS),
    unitPrice: money.cost(z.string()),
    currency: z.string(),
  }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
  createdById: id().nullable(),
})

const one = output({
  item: sourceView,
  /** The other source of the same scope that stopped being the PRIMARY one in this write; null: none. */
  demoted: output({ id: id(), partyId: id(), supplierName: z.string() }).nullable(),
})

const sourceParams = input({ supplierItemId: id() })

export const listSourcesContract = defineContract({
  querystring: input({
    /** A supplier's list (its Items & prices tab). */
    partyId: id().optional(),
    /** A material's suppliers (its Supplier prices tab). */
    itemId: id().optional(),
    /** With itemId: the sources that reach this colour (its own and every colour's). */
    itemColourId: id().optional(),
    /** The sources that hold for this company (its own and every company's). */
    companyId: id().optional(),
    /** Default ACTIVE. */
    status: z.enum([...SOURCE_STATUSES, 'ALL']).default('ACTIVE'),
    preference: z.enum(SOURCE_PREFERENCES).optional(),
    /** The supplier's article code, the material's code or name, case-insensitive. */
    q: z.string().trim().min(1).max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: { 200: output({ items: z.array(sourceView), nextCursor: id().nullable() }) },
})

export const getSourceContract = defineContract({ params: sourceParams, response: { 200: output({ item: sourceView }) } })

const fields = {
  supplierArticleCode: text(SOURCE_TEXT.code).nullish(),
  supplierColourCode: text(SOURCE_TEXT.code).nullish(),
  description: text(SOURCE_TEXT.description).nullish(),
  /** Any unit the material converts; default the material's purchase unit. */
  purchaseUom: z.enum(UOMS).optional(),
  /** Per `purchaseUom`, in `currency`. */
  unitPrice: money.cost(unitPrice().nullish()),
  /** ISO 4217; default the supplier's currency. */
  currency: z.string().trim().length(3).optional(),
  minOrderQty: quantity().nullish(),
  orderMultiple: quantity().nullish(),
  leadTimeDays: leadTimeDays.nullish(),
  /** PRIMARY makes the scope's current primary source a BACKUP. */
  preference: z.enum(SOURCE_PREFERENCES).optional(),
  note: text(SOURCE_TEXT.note).nullish(),
}

export const createSourceContract = defineContract({
  body: input({
    /** null: a source for every company of the tenant (needs a role over every company). */
    companyId: id().nullable(),
    partyId: id(),
    itemId: id(),
    itemColourId: id().nullish(),
    ...fields,
  }),
  response: { 201: one },
})

export const updateSourceContract = defineContract({ params: sourceParams, body: input({ version, ...fields }), response: { 200: one } })

export const archiveSourceContract = defineContract({ params: sourceParams, body: input({ version, reason: text(SOURCE_TEXT.reason).optional() }), response: { 200: one } })

export const restoreSourceContract = defineContract({ params: sourceParams, body: input({ version }), response: { 200: one } })

