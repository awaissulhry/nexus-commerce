import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { PICTURE_KINDS } from '@nexus/factory-domain/people/teams/picture'
import { TEAM_LIMITS } from '@nexus/factory-domain/people/teams/rules'
import { READY_MADE_KINDS, UNIT_LIMITS } from '@nexus/factory-domain/people/units/rules'

/**
 * The factory structure (owb-ss5 steps 5.2 + 5.3; the Shape of build/briefs/owb-ss5.md is FIXED: web B codes against it). A unit
 * is a Team row (a team is a unit that takes orders); a person is an Employee with their current TeamMember row. Pictures are
 * letters or one of the 12 icons on one of the 10 tones, never a photo (pick K). No figure about one person's work.
 *
 * The rules (lengths, the 12 icons, the 10 tones, cycles, merges, closing) are the domain's (people/units/rules): a body that
 * breaks one is a 409 whose issues are `refusal/<CODE>` and `body/<field>` (the web has the words of each code). The schemas
 * here hold the types and generous outer bounds only.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().max(max)

export const pictureOut = output({ kind: z.enum(PICTURE_KINDS), icon: z.string().nullable(), colour: z.string().nullable(), letters: z.string() })
const leaderOut = output({ employeeId: id(), name: z.string() }).nullable()

/** A unit on the structure page (the Shape). */
export const unitOut = output({
  id: id(),
  parentId: id().nullable(),
  name: z.string(),
  kindWord: z.string().nullable(),
  picture: pictureOut,
  leader: leaderOut,
  takesOrders: z.boolean(),
  closed: z.boolean(),
  siteId: id(),
  /** How many people sit in it today (the owner's own view of who is where). */
  people: z.number().int(),
})

/** A person on the structure page (the Shape): their unit today (null: in no unit yet), whether they lead it, their role. */
export const personOut = output({
  employeeId: id(),
  name: z.string(),
  unitId: id().nullable(),
  isLeader: z.boolean(),
  role: z.string().nullable(),
  picture: pictureOut,
})

/** One unit's profile (the Shape): the unit, its profile, its own facts, its work now, its people. */
export const unitRecordOut = unitOut.extend({
  about: z.string().nullable(),
  standIn: output({ employeeId: id(), name: z.string(), until: z.string().nullable() }).nullable(),
  /** The customers it likes to work for that this person may see (a wish, not a wall). */
  worksFor: z.array(output({ partyId: id(), name: z.string() })),
  maxBaskets: z.number().int().nullable(),
  takesNewOrders: z.boolean(),
  /** "Your own facts": the unit's custom field values this person sees (Team in platform/fields records). */
  ownFacts: z.array(output({ label: z.string(), value: z.string() })),
  /** Its open order rows: the order, the customer's CODE (never its name), the order's state. */
  work: z.array(output({ orderId: id(), number: z.string(), customerCode: z.string(), state: z.string() })),
  members: z.array(personOut),
  version: z.number().int(),
})

export const structureContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    /** Closed units too (default true: the page reads `closed` and draws only the open ones in the chart). */
    includeClosed: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }),
  response: { 200: output({ units: z.array(unitOut), people: z.array(personOut), may: output({ manage: z.boolean() }) }) },
})

export const unitRecordContract = defineContract({
  params: input({ unitId: id() }),
  response: { 200: unitRecordOut },
})

const profileFields = {
  kindWord: text(200).nullable().optional(),
  pictureKind: z.enum(PICTURE_KINDS).optional(),
  pictureIcon: text(60).nullable().optional(),
  pictureColour: text(60).nullable().optional(),
  about: text(2000).nullable().optional(),
  worksForPartyIds: z.array(id()).max(UNIT_LIMITS.worksFor * 2).optional(),
  maxBaskets: z.number().int().nullable().optional(),
  takesNewOrders: z.boolean().optional(),
  takesOrders: z.boolean().optional(),
  /** Who stands in for the leader (null: nobody, and the last day goes with them). The leader: PUT /people/teams/:teamId/lead. */
  standInEmployeeId: id().nullable().optional(),
  /** The stand-in's last day (null: until said otherwise); only beside a stand-in. */
  standInUntil: businessDate().nullable().optional(),
}

export const createUnitContract = defineContract({
  body: input({
    /** The site it is on; left out: the site of the unit above. */
    siteId: id().optional(),
    /** Left out: made from the name (capitals, unique on the site). */
    code: text(TEAM_LIMITS.code * 2).optional(),
    name: text(TEAM_LIMITS.name * 2),
    /** The unit it sits under (null or left out: the top). */
    parentId: id().nullable().optional(),
    /** The line of its site it works on (a team: the loans to it need one). */
    lineId: id().nullable().optional(),
    ...profileFields,
  }),
  response: { 200: output({ unit: unitRecordOut }), 201: output({ unit: unitRecordOut }) },
})

export const updateUnitContract = defineContract({
  params: input({ unitId: id() }),
  body: input({
    version: version(),
    name: text(TEAM_LIMITS.name * 2).optional(),
    ...profileFields,
  }),
  response: { 200: output({ unit: unitRecordOut }) },
})

export const moveUnitContract = defineContract({
  params: input({ unitId: id() }),
  body: input({ version: version(), parentId: id().nullable() }),
  response: { 200: output({ unit: unitRecordOut }) },
})

export const mergeUnitsContract = defineContract({
  body: input({
    keepId: id(),
    mergeIds: z.array(id()).max(UNIT_LIMITS.merge * 2),
    /** The name of the one unit (its own name kept when it is the same). */
    name: text(TEAM_LIMITS.name * 2),
    /** Who leads it (a person of the units that become one); left out: its leader stays. */
    leaderEmployeeId: id().nullable().optional(),
  }),
  response: {
    200: output({
      unit: unitRecordOut,
      moved: output({ people: z.number().int(), orders: z.number().int(), units: z.number().int() }),
      closed: z.array(id()),
    }),
  },
})

export const closeUnitContract = defineContract({
  params: input({ unitId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ unit: unitRecordOut }) },
})

const readyMadeBody = input({
  kind: z.enum(READY_MADE_KINDS),
  /** The site; left out: the one site where this person keeps the structure (more than one: 409 SITE_NEEDED). */
  siteId: id().optional(),
})

/** One line a unit (the lead's fixed answer): its name and what happens to it, in words; a blocker's line says why it cannot be applied. Empty: nothing changes. */
const readyMadeRows = z.array(output({ name: z.string(), words: z.string() }))

export const readyMadePreviewContract = defineContract({
  body: readyMadeBody,
  response: { 200: output({ rows: readyMadeRows }) },
})

export const readyMadeApplyContract = defineContract({
  body: readyMadeBody,
  response: { 200: output({ rows: readyMadeRows, applied: z.boolean() }) },
})

const historyOut = output({ rows: z.array(output({ at: z.string(), who: z.string(), words: z.string(), icon: z.string() })) })

export const unitHistoryContract = defineContract({
  params: input({ unitId: id() }),
  response: { 200: historyOut },
})

export const employeeHistoryContract = defineContract({
  params: input({ employeeId: id() }),
  response: { 200: historyOut },
})
