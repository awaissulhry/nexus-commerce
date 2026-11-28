import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { STRUCTURE_CATEGORIES, STRUCTURE_FROM, STRUCTURE_LIMITS } from '@nexus/factory-domain/production/structures/rules'
import { pictureOut } from '../order-teams/contract'

/**
 * Order structures and their rules (owb-ss6 steps 6.2, 6.3; build/briefs/owb-ss6.md § Shape — FIXED: web B codes against it).
 * Office only; nothing here carries money, and the customer never reads any of it. The company of a list or a new structure is
 * the screen's (`x-factory-company`); a rule's is its structure's; an order's its own.
 */

const version = z.number().int().min(1)
const category = z.enum(STRUCTURE_CATEGORIES)
/** A note: blank is none. */
const noteIn = z.string().trim().max(STRUCTURE_LIMITS.note)

export const structureRowOut = output({
  id: id(),
  name: z.string(),
  teams: z.array(output({ id: id(), name: z.string(), picture: pictureOut })),
  people: z.array(output({ userId: id(), name: z.string() })),
  note: z.string().nullable(),
  closed: z.boolean(),
  /** The open rules that give it. */
  usedByRules: z.number().int(),
  version: z.number().int(),
})

export const ruleRowOut = output({
  id: id(),
  sortOrder: z.number().int(),
  party: output({ id: id(), name: z.string() }).nullable(),
  category: z.string().nullable(),
  structure: output({ id: id(), name: z.string(), closed: z.boolean() }),
  active: z.boolean(),
  note: z.string().nullable(),
  closed: z.boolean(),
  /** "Never used": a rule above takes all its orders (deadBecause names it). */
  dead: z.boolean(),
  deadBecause: output({ ruleId: id() }).nullable(),
  /** The open orders not printed yet that this rule gives their structure now (count, and the first 5). */
  fitsNow: output({ count: z.number().int(), orders: z.array(output({ id: id(), number: z.string() })) }),
  version: z.number().int(),
})

const structureParams = input({ structureId: id() })
const ruleParams = input({ ruleId: id() })
const closeBody = input({ version: version.optional() }).optional()

export const listStructuresContract = defineContract({
  response: { 200: output({ structures: z.array(structureRowOut), may: output({ manage: z.boolean() }) }) },
})

export const createStructureContract = defineContract({
  body: input({
    name: z.string().trim().min(1).max(STRUCTURE_LIMITS.name),
    teamIds: z.array(id()).max(STRUCTURE_LIMITS.teams),
    peopleUserIds: z.array(id()).max(STRUCTURE_LIMITS.people),
    note: noteIn.optional(),
  }),
  response: { 200: structureRowOut, 201: structureRowOut },
})

export const updateStructureContract = defineContract({
  params: structureParams,
  body: input({
    version,
    name: z.string().trim().min(1).max(STRUCTURE_LIMITS.name).optional(),
    teamIds: z.array(id()).max(STRUCTURE_LIMITS.teams).optional(),
    peopleUserIds: z.array(id()).max(STRUCTURE_LIMITS.people).optional(),
    note: noteIn.nullable().optional(),
  }),
  response: { 200: structureRowOut },
})

export const closeStructureContract = defineContract({ params: structureParams, body: closeBody, response: { 200: structureRowOut } })

export const listRulesContract = defineContract({
  response: { 200: output({ rules: z.array(ruleRowOut), neverUsed: z.number().int(), may: output({ write: z.boolean() }) }) },
})

export const createRuleContract = defineContract({
  body: input({
    partyId: id().nullable(),
    category: category.nullable(),
    structureId: id(),
    note: noteIn.optional(),
    /** Its place on the list (1 first); without it, above the first rule that would take all its orders (rulePlace). */
    place: z.number().int().min(1).max(10_000).optional(),
  }),
  response: { 200: ruleRowOut, 201: ruleRowOut },
})

export const updateRuleContract = defineContract({
  params: ruleParams,
  body: input({
    version,
    partyId: id().nullable().optional(),
    category: category.nullable().optional(),
    structureId: id().optional(),
    active: z.boolean().optional(),
    note: noteIn.nullable().optional(),
  }),
  response: { 200: ruleRowOut },
})

export const orderRulesContract = defineContract({
  body: input({ ids: z.array(id()).min(1).max(500) }),
  response: { 200: output({ rules: z.array(ruleRowOut) }) },
})

export const closeRuleContract = defineContract({ params: ruleParams, body: closeBody, response: { 200: ruleRowOut } })

export const tryRulesContract = defineContract({
  body: input({ partyId: id().nullable(), category: category.nullable() }),
  response: {
    200: output({
      winner: output({ ruleId: id().nullable(), structureId: id().nullable(), words: z.string() }),
      others: z.array(output({ ruleId: id(), words: z.string() })),
    }),
  },
})

export const orderStructureOut = output({
  orderId: id(),
  /** Its FIRST print happened: the work started, it keeps its structure. */
  printed: z.boolean(),
  byHand: output({ structureId: id().nullable(), why: z.string(), by: z.string(), at: z.string() }).nullable(),
  lines: z.array(
    output({
      salesOrderLineId: id(),
      /** The line's words (style, name, colour): never a price. */
      label: z.string(),
      structure: output({ id: id(), name: z.string() }).nullable(),
      rule: output({ id: id() }).nullable(),
      from: z.enum(STRUCTURE_FROM),
      why: z.string(),
      /** Kept at the first print (OrderLineStructureKept). */
      kept: z.boolean(),
    }),
  ),
  may: output({ change: z.boolean() }),
})

const orderParams = input({ orderId: id() })

export const orderStructureContract = defineContract({ params: orderParams, response: { 200: orderStructureOut } })

export const putOrderStructureContract = defineContract({
  params: orderParams,
  body: input({ structureId: id().nullable(), why: z.string().trim().min(STRUCTURE_LIMITS.whyMin).max(STRUCTURE_LIMITS.why) }),
  response: { 200: orderStructureOut },
})

export const endOrderStructureContract = defineContract({ params: orderParams, response: { 200: orderStructureOut } })

export const customerRulesContract = defineContract({
  params: input({ partyId: id() }),
  response: { 200: output({ rules: z.array(ruleRowOut), may: output({ write: z.boolean() }) }) },
})
