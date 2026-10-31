import { z } from 'zod'
import { businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { ENTRY_CHANGES, PRICE_LIST_KINDS, PRICE_LIST_LIMITS, PRICE_LIST_STATES, PRICE_VERSION_STATUSES } from '@nexus/factory-domain/sales/pricelists/pricelists'

/**
 * The price lists' contracts (B-W2a-19; SAL-165; design sales.pricelists and the record "Price list"). Prices are the
 * price grain (money.price), a price row's standard cost the cost grain, its margin the margin grain: the API drops a
 * marked field the caller's grains do not reach and refuses a body that sends one. A list's `version` guards its own
 * edits; a version's `version` guards its days, prices and activation (COL-078).
 */

const version = z.number().int().min(1)
const note = z.string().trim().max(PRICE_LIST_LIMITS.note)

const shownVersion = output({ id: id(), revision: z.number().int(), status: z.enum(PRICE_VERSION_STATUSES), validFrom: z.string().nullable(), validTo: z.string().nullable() })

export const listRowView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PRICE_LIST_KINDS),
  currency: z.string(),
  baseList: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** Today: DRAFT (never activated), SCHEDULED, IN_FORCE, EXPIRED or ARCHIVED. */
  state: z.enum(PRICE_LIST_STATES),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  shownVersion: shownVersion.nullable(),
  draftVersionId: id().nullable(),
  /** Prices in the shown version (styles and colourways priced). */
  stylesPriced: notMoney(z.number().int()),
  customers: z.number().int(),
  startsSoon: z.boolean(),
  endsSoon: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const versionView = output({
  id: id(),
  revision: z.number().int(),
  status: z.enum(PRICE_VERSION_STATUSES),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  activatedAt: instant().nullable(),
  activatedById: id().nullable(),
  note: z.string().nullable(),
  entries: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const listDetailView = listRowView.extend({
  note: z.string().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  versions: z.array(versionView),
  /** B-W2b-16: `from` = since when the customer has the list (`fromSource` ROW: its history; AUDIT: given before W2b). */
  customers: z.array(output({ id: id(), code: z.string(), legalName: z.string(), status: z.string(), companyId: id().nullable(), version: z.number().int(), from: businessDate().nullable(), fromSource: z.enum(['ROW', 'AUDIT']).nullable() })),
  fallbackOf: z.array(output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(PRICE_LIST_KINDS), status: z.string() })),
})

const entryView = output({
  id: id(),
  styleId: id(),
  style: output({ code: z.string(), name: z.string(), status: z.string() }),
  /** Null: the style's price for every colourway. */
  colourwayId: id().nullable(),
  colourway: output({ code: z.string(), name: z.string() }).nullable(),
  /** Net, per piece, in the list's currency. */
  unitPrice: money.price(z.string()),
  /** One piece at the style's base size from today's cost sheet (for every colourway: the dearest); null: unknown. */
  standardCost: money.cost(z.string().nullable()),
  marginPct: money.margin(z.string().nullable()),
  /** The margin is under the sales settings' floor. */
  belowFloor: money.margin(z.boolean()),
  version: z.number().int(),
})

const versionAnswer = output({ version: versionView, entries: z.array(entryView) })
const listParams = input({ listId: id() })
const versionParams = input({ listId: id(), versionId: id() })
const one = { 200: output({ list: listDetailView }) }

export const listListsContract = defineContract({
  querystring: input({
    /** What this company may use: its own lists and every company's. */
    companyId: id().optional(),
    kind: z.enum(PRICE_LIST_KINDS).optional(),
    /** The saved rows: IN_FORCE (Active), DRAFT (Drafts), EXPIRED, SCHEDULED; ARCHIVED lists only when asked. */
    state: z.enum(PRICE_LIST_STATES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  }),
  response: { 200: output({ asOf: z.string(), lists: z.array(listRowView), tiles: output({ inForce: z.number().int(), startingIn30Days: z.number().int(), endingIn30Days: z.number().int() }) }) },
})
export const getListContract = defineContract({ params: listParams, response: one })
export const createListContract = defineContract({
  body: input({
    companyId: id().nullish(),
    code: z.string().trim().min(1).max(PRICE_LIST_LIMITS.code),
    name: z.string().trim().min(1).max(PRICE_LIST_LIMITS.name),
    kind: z.enum(PRICE_LIST_KINDS),
    currency: currency().optional(),
    /** @not-money the list a style missing here is priced from */
    baseListId: id().nullish(),
    note: note.nullish(),
    validFrom: businessDate().nullish(),
    validTo: businessDate().nullish(),
  }),
  response: { 201: output({ list: listDetailView }) },
})
export const updateListContract = defineContract({
  params: listParams,
  body: input({ version, code: z.string().trim().min(1).max(PRICE_LIST_LIMITS.code).optional(), name: z.string().trim().min(1).max(PRICE_LIST_LIMITS.name).optional(), baseListId: id().nullish(), note: note.nullish() }),
  response: one,
})
export const moveListContract = defineContract({ params: listParams, body: input({ version }), response: one })
/** B-W2b-16: `validFrom` (adding only; default today, never a later day) is the customers' "From". */
export const customersContract = defineContract({ params: listParams, body: input({ partyIds: z.array(id()).min(1).max(200), validFrom: businessDate().optional() }), response: one })

export const getVersionContract = defineContract({ params: versionParams, response: { 200: versionAnswer } })
export const nextVersionContract = defineContract({
  params: listParams,
  body: input({ fromVersionId: id().nullish(), validFrom: businessDate().nullish(), validTo: businessDate().nullish(), note: note.nullish() }),
  response: { 201: versionAnswer },
})
export const editVersionContract = defineContract({ params: versionParams, body: input({ version, validFrom: businessDate().nullish(), validTo: businessDate().nullish(), note: note.nullish() }), response: { 200: versionAnswer } })
export const deleteVersionContract = defineContract({ params: versionParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ deleted: output({ id: id(), revision: z.number().int() }) }) } })
export const setPricesContract = defineContract({
  params: versionParams,
  body: input({
    version,
    entries: z.array(input({ styleId: id(), colourwayId: id().nullable(), unitPrice: money.price(unitPrice().nullable()) })).min(1).max(PRICE_LIST_LIMITS.entries),
  }),
  response: { 200: versionAnswer },
})
export const activateContract = defineContract({
  params: versionParams,
  body: input({ version, validFrom: businessDate().optional(), validTo: businessDate().nullish() }),
  response: { 200: versionAnswer.extend({ ended: output({ id: id(), revision: z.number().int(), validTo: z.string() }).nullable() }) },
})
export const compareContract = defineContract({
  params: versionParams,
  querystring: input({ with: id() }),
  response: {
    200: output({
      before: output({ id: id(), revision: z.number().int() }),
      after: output({ id: id(), revision: z.number().int() }),
      changed: z.number().int(),
      rows: z.array(
        output({
          styleId: id(),
          style: output({ id: id(), code: z.string(), name: z.string() }),
          colourwayId: id().nullable(),
          colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          before: money.price(z.string().nullable()),
          after: money.price(z.string().nullable()),
          change: z.enum(ENTRY_CHANGES),
          changePct: money.price(z.string().nullable()),
        }),
      ),
    }),
  },
})
