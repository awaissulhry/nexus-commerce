import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CALENDAR_KIND, DEADLINE_KINDS, DEADLINE_LIMITS, DEADLINE_STATUSES, ITEM_STATES, REPEAT_UNITS } from '@nexus/factory-domain/safety/calendar/rules'

/**
 * The safety calendar (B-W2b-120; QHS-227; design plant.calendar: tiles, the calendar Month | List, Add deadline, the
 * Deadline window, the calendar print). An item is said by its kind and its params (data words: a check type's label, a
 * course's name, an incident's number): the screens compose their own sentence, never the API's English. A health visit
 * is a count (no name), an INAIL report a count per incident: names stay on their own pages behind their own gates.
 */

const version = () => z.number().int().min(1)
const codeName = output({ code: z.string(), name: z.string() })

export const itemOut = output({
  /** Unique in one read: `<kind>:<record id>` or `<kind>:<group key>` for a count. */
  key: z.string(),
  kind: z.string().regex(CALENDAR_KIND),
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  companyId: id(),
  company: codeName,
  siteId: id().nullable(),
  site: codeName.nullable(),
  dueOn: z.string(),
  state: z.enum(ITEM_STATES),
  toConfirm: z.boolean(),
  /** A count of people, visits or reports this item stands for; null: one record. */
  count: z.number().int().min(1).nullable(),
  /** The data words of the item (its title, a check type, a course, a role, a number): the screen's sentence fills them in. */
  params: z.record(z.string(), z.string()),
  ownerId: id().nullable(),
  owner: z.string().nullable(),
  /** Evidence asked for and whether a file is on record (typed deadlines); null: the source page keeps the evidence. */
  evidence: output({ required: z.boolean(), onFile: z.boolean() }).nullable(),
  law: z.string().nullable(),
  /**
   * Where the item is kept: the design page id (`plant.preventive`, …), the record it opens there, and the record it
   * belongs to (a check plan's machine, a filing's incident) for a page that is not built yet.
   */
  source: output({ page: z.string().nullable(), recordType: z.string().nullable(), recordId: id().nullable(), parentType: z.string().nullable(), parentId: id().nullable() }),
  /** A deadline typed here that the caller may change (safety.calendar.manage); the others open their source. */
  editable: z.boolean(),
})
export type CalendarItemOut = z.infer<typeof itemOut>

export const calendarContract = defineContract({
  querystring: input({
    from: businessDate(),
    to: businessDate(),
    /** Also what is still open from before `from` (late): the List mode and the export never lose an overdue item. */
    late: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    companyId: id().optional(),
    siteId: id().optional(),
  }),
  response: {
    200: output({
      items: z.array(itemOut),
      from: z.string(),
      to: z.string(),
      today: z.string(),
      /** Kinds whose source could not be read this time (said on screen; never drawn as "nothing due"). */
      failed: z.array(z.string()),
      canManage: z.boolean(),
      canUpload: z.boolean(),
    }),
  },
})

export const countsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({ overdue: z.number().int(), dueSoon: z.number().int(), rolesWithoutPerson: z.number().int(), rlsPending: z.number().int(), failed: z.array(z.string()), today: z.string() }),
  },
})

export const deadlineOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  siteId: id().nullable(),
  site: codeName.nullable(),
  title: z.string(),
  kind: z.enum(DEADLINE_KINDS),
  dueOn: z.string(),
  repeatEvery: z.number().int().nullable(),
  repeatUnit: z.enum(REPEAT_UNITS).nullable(),
  ownerId: id().nullable(),
  owner: z.string().nullable(),
  evidenceRequired: z.boolean(),
  evidence: z.array(output({ fileId: id(), name: z.string(), kind: z.string(), at: z.string() })),
  status: z.enum(DEADLINE_STATUSES),
  state: z.enum(ITEM_STATES),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  doneNote: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  previousId: id().nullable(),
  nextId: id().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
})

export const deadlineRecordContract = defineContract({
  params: input({ deadlineId: id() }),
  response: { 200: output({ deadline: deadlineOut, earlier: z.array(output({ id: id(), dueOn: z.string(), status: z.enum(DEADLINE_STATUSES), doneAt: z.string().nullable() })), canUpload: z.boolean(), today: z.string() }) },
})

export const ownersContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ owners: z.array(output({ id: id(), name: z.string(), me: z.boolean() })) }) },
})

const title = () => z.string().trim().min(1).max(DEADLINE_LIMITS.title)
const repeatEvery = () => z.number().int().min(DEADLINE_LIMITS.repeatMin).max(DEADLINE_LIMITS.repeatMax)
const note = () => z.string().trim().max(DEADLINE_LIMITS.note)

export const createDeadlineContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id().nullable().optional(),
    title: title(),
    kind: z.enum(DEADLINE_KINDS),
    dueOn: businessDate(),
    repeatEvery: repeatEvery().nullable().optional(),
    repeatUnit: z.enum(REPEAT_UNITS).nullable().optional(),
    ownerId: id().nullable().optional(),
    evidenceRequired: z.boolean().default(false),
    note: note().optional(),
  }),
  response: { 200: output({ deadline: deadlineOut }), 201: output({ deadline: deadlineOut }) },
})

export const editDeadlineContract = defineContract({
  params: input({ deadlineId: id() }),
  body: input({
    version: version(),
    title: title().optional(),
    dueOn: businessDate().optional(),
    repeatEvery: repeatEvery().nullable().optional(),
    repeatUnit: z.enum(REPEAT_UNITS).nullable().optional(),
    ownerId: id().nullable().optional(),
    evidenceRequired: z.boolean().optional(),
    note: note().nullable().optional(),
  }),
  response: { 200: output({ deadline: deadlineOut }) },
})

export const doneDeadlineContract = defineContract({
  params: input({ deadlineId: id() }),
  body: input({ version: version(), note: note().optional() }),
  response: { 200: output({ deadline: deadlineOut, next: deadlineOut.nullable() }) },
})

export const cancelDeadlineContract = defineContract({
  params: input({ deadlineId: id() }),
  body: input({ version: version(), reason: z.string().trim().min(1).max(DEADLINE_LIMITS.reason) }),
  response: { 200: output({ deadline: deadlineOut }) },
})
