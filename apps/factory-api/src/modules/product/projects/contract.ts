import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PROJECT_LIMITS, PROJECT_OUTCOMES, PROJECT_STATUSES } from '@nexus/factory-domain/projects/rules'
import { FOLLOW_REASONS } from '@nexus/factory-domain/threads/followers'
import { PROJECT_SORTS, PROJECT_TARGETS, PROJECT_VIEWS } from './list'

/** The projects' routes (threads plan TH-5, B-TH-066 … B-TH-072; modules/product/projects). No money anywhere. */

const words = output({ it: z.string(), en: z.string() })
const person = output({ id: id(), name: z.string() })
const version = z.number().int().min(1)
const projectParams = input({ projectId: id() })
const target = output({ state: z.string(), days: z.number().int(), words: words.nullable() })

const project = output({
  id: id(),
  number: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  companyId: id(),
  company: output({ id: id(), code: z.string() }),
  /** The ONE outside company (customer, brand, supplier or workshop), chosen at creation; null: office only. */
  party: output({ id: id(), code: z.string(), name: z.string(), roles: z.array(z.string()) }).nullable(),
  lead: person,
  seasonCode: z.string().nullable(),
  targetDate: businessDate(),
  target,
  status: z.enum(PROJECT_STATUSES),
  statusWords: words,
  outcome: z.enum(PROJECT_OUTCOMES).nullable(),
  outcomeWords: words.nullable(),
  outcomeNote: z.string().nullable(),
  closedAt: instant().nullable(),
  closedBy: person.nullable(),
  createdAt: instant(),
  createdBy: person.nullable(),
  lastMessageAt: instant().nullable(),
  threadStatus: z.string().nullable(),
  version: z.number().int(),
  officeOnly: z.boolean(),
  /** "Everyone in the company who reads threads can open this project" (members-only office projects come later). */
  openToOfficeWords: words,
  may: output({ manage: z.boolean(), post: z.boolean(), moves: z.array(z.string()) }),
})
const one = output({ project })
/** B-TH-071: the project as made, for a route of another module ("Start a project" from a request). */
export const projectOutput = project

const listRow = output({
  id: id(),
  number: z.string(),
  name: z.string(),
  companyId: id(),
  party: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  lead: person,
  status: z.enum(PROJECT_STATUSES),
  statusWords: words,
  targetDate: businessDate(),
  target,
  seasonCode: z.string().nullable(),
  lastMessageAt: instant().nullable(),
  /** The reader's OWN unread notifications of it (0 when muted); never anyone else's. */
  newForMe: z.number().int(),
  muted: z.boolean(),
  /** I am one of its people (any reason). */
  mine: z.boolean(),
  linked: z.number().int(),
  version: z.number().int(),
})

const linkedRecord = output({
  linkId: id(),
  recordType: z.string(),
  recordId: id(),
  group: z.string(),
  /** Null when the reader may not open the record ("you cannot open it"). */
  label: z.string().nullable(),
  status: z.string().nullable(),
  mayOpen: z.boolean(),
  note: z.string().nullable(),
  linkedAt: instant(),
  linkedBy: person.nullable(),
})
const links = output({ count: z.number().int(), records: z.array(linkedRecord) })

const people = output({
  office: output({
    count: z.number().int(),
    people: z.array(output({ userId: id(), name: z.string(), lead: z.boolean(), me: z.boolean(), reason: z.enum(FOLLOW_REASONS), addedBy: person.nullable(), muted: z.boolean(), since: instant() })),
  }),
  outside: output({ count: z.number().int(), people: z.array(output({ userId: id(), name: z.string(), reason: z.enum(FOLLOW_REASONS), addedBy: person.nullable(), since: instant() })) }),
  invited: output({ count: z.number().int(), people: z.array(output({ shareId: id(), name: z.string().nullable(), email: z.string(), until: instant(), permissions: z.array(z.string()) })) }),
})

const linkAsk = input({ recordType: z.string().min(1).max(64), recordId: id(), note: z.string().max(PROJECT_LIMITS.linkNote + 10).nullable().optional() })

// ---- B-TH-066: the record --------------------------------------------------------------------------------------------------

export const createProjectContract = defineContract({
  body: input({
    companyId: id(),
    name: z.string().max(PROJECT_LIMITS.name + 10),
    /** Chosen now, never changed; null or absent: an office-only project. */
    partyId: id().nullable().optional(),
    leadId: id().optional(),
    targetDate: businessDate(),
    seasonCode: z.string().max(40).nullable().optional(),
    goal: z.string().max(PROJECT_LIMITS.goal + 10).nullable().optional(),
    colleagueIds: z.array(id()).max(20).optional(),
    links: z.array(linkAsk).max(20).optional(),
  }),
  response: { 201: one },
})
export const updateProjectContract = defineContract({
  params: projectParams,
  body: input({
    version,
    name: z.string().max(PROJECT_LIMITS.name + 10).optional(),
    goal: z.string().max(PROJECT_LIMITS.goal + 10).nullable().optional(),
    leadId: id().optional(),
    targetDate: businessDate().optional(),
    seasonCode: z.string().max(40).nullable().optional(),
  }),
  response: { 200: one },
})
export const moveProjectContract = defineContract({ params: projectParams, body: input({ version }), response: { 200: one } })
export const closeProjectContract = defineContract({
  params: projectParams,
  body: input({ version, outcome: z.enum(PROJECT_OUTCOMES), outcomeNote: z.string().max(PROJECT_LIMITS.outcomeNote + 10), tellCustomer: z.boolean().optional() }),
  response: { 200: one },
})
export const similarProjectsContract = defineContract({
  querystring: input({ companyId: id(), partyId: id().optional(), name: z.string().max(PROJECT_LIMITS.name + 10) }),
  response: { 200: output({ projects: z.array(output({ id: id(), number: z.string(), name: z.string(), status: z.enum(PROJECT_STATUSES) })) }) },
})

// ---- B-TH-067: linked records ---------------------------------------------------------------------------------------------

export const linkRecordContract = defineContract({ params: projectParams, body: linkAsk, response: { 200: output({ link: output({ id: id(), recordType: z.string(), recordId: id() }), links }) } })
export const linkManyContract = defineContract({
  params: projectParams,
  body: input({ recordType: z.enum(['Style', 'SampleRound']), recordIds: z.array(id()).min(1).max(PROJECT_LIMITS.bulk), note: z.string().max(PROJECT_LIMITS.linkNote + 10).nullable().optional() }),
  response: { 200: output({ linked: z.number().int(), skipped: z.array(output({ recordId: id(), code: z.string(), words })), links }) },
})
export const unlinkRecordContract = defineContract({ params: input({ projectId: id(), linkId: id() }), response: { 200: output({ links }) } })
export const recordProjectsContract = defineContract({
  params: input({ recordType: z.string().min(1).max(64), recordId: id() }),
  response: { 200: output({ count: z.number().int(), projects: z.array(output({ id: id(), number: z.string(), name: z.string(), status: z.enum(PROJECT_STATUSES) })) }) },
})

// ---- B-TH-068: people ------------------------------------------------------------------------------------------------------

export const projectPeopleContract = defineContract({ params: projectParams, response: { 200: output({ people }) } })
export const peopleChoicesContract = defineContract({
  params: projectParams,
  querystring: input({ q: z.string().trim().max(100).optional() }),
  response: { 200: output({ office: z.array(output({ userId: id(), name: z.string() })), outside: z.array(output({ userId: id(), name: z.string() })), mayAddOutside: z.boolean() }) },
})
export const addPersonContract = defineContract({ params: projectParams, body: input({ userId: id() }), response: { 200: output({ people }) } })
export const removePersonContract = defineContract({ params: input({ projectId: id(), userId: id() }), response: { 200: output({ people }) } })

// ---- B-TH-070: the list and the page ----------------------------------------------------------------------------------------

export const listProjectsContract = defineContract({
  querystring: input({
    view: z.enum(PROJECT_VIEWS).optional(),
    companyId: id().optional(),
    partyId: id().optional(),
    outside: z.literal('none').optional(),
    leadId: id().optional(),
    seasonCode: z.string().max(40).optional(),
    target: z.enum(PROJECT_TARGETS).optional(),
    q: z.string().trim().max(100).optional(),
    sort: z.enum(PROJECT_SORTS).optional(),
    cursor: z.string().max(8).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: { 200: output({ rows: z.array(listRow), total: z.number().int(), next: z.string().nullable(), complete: z.boolean() }) },
})
export const projectPageContract = defineContract({
  params: projectParams,
  response: {
    200: output({
      project,
      people,
      links,
      tasks: output({ open: z.number().int(), overdue: z.number().int() }),
      files: output({ count: z.number().int() }),
      me: output({ following: z.boolean(), muted: z.boolean(), reason: z.enum(FOLLOW_REASONS).nullable() }),
    }),
  },
})
export const projectCountsContract = defineContract({ querystring: input({ partyId: id() }), response: { 200: output({ open: z.number().int(), all: z.number().int() }) } })

// ---- B-TH-071: My projects --------------------------------------------------------------------------------------------------

export const myProjectsContract = defineContract({ response: { 200: output({ projects: z.array(listRow.extend({ lead: person.extend({ me: z.boolean() }) })) }) } })

// ---- B-TH-069 / B-TH-072: the portal ------------------------------------------------------------------------------------------

export const portalProjectsContract = defineContract({
  response: { 200: output({ projects: z.array(output({ id: id(), number: z.string(), name: z.string(), status: z.enum(PROJECT_STATUSES), targetDate: businessDate() })) }) },
})
export const portalProjectNewsContract = defineContract({
  params: projectParams,
  querystring: input({ cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
  response: {
    200: output({
      entries: z.array(output({ id: id(), at: instant(), recordType: z.string(), recordId: id(), theirRef: z.string().nullable(), ourRef: z.string().nullable(), status: output({ from: z.string().nullable(), to: z.string().nullable() }), folded: z.number().int() })),
      nextCursor: z.string().nullable(),
    }),
  },
})
