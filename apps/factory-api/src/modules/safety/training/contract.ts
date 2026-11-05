import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { IMPACT_KINDS } from '@nexus/factory-domain/safety/rolesheets/rules'
import { COURSE_FIELDS, COURSE_STATUSES, COURSE_TYPES, HOURS, NEED_STATES, TRAINING_LIMITS } from '@nexus/factory-domain/safety/training/rules'

/**
 * The course catalogue and who needs which course (B-W2b-133; QHS-241, QHS-242; design people.skills "Course catalogue",
 * "Who needs what", the pop-up "Course" with "14 due dates move"). No money; a person's name only inside one record (a role
 * sheet's or a machine type's people, the people whose date a course change would move: the register names people for the
 * roles that keep it); lists carry counts. Never the floor.
 */

const L = TRAINING_LIMITS
const words = (max: number) => z.string().trim().min(1).max(max)
const maybeWords = (max: number) => z.string().trim().max(max)
const version = () => z.number().int().min(1)
const fingerprint = () => z.string().regex(/^[0-9a-f]{64}$/)
const hours = () => z.string().trim().regex(HOURS, 'Hours with at most two decimals ("4", "12.5").')
const names = z.record(z.string(), z.string()).nullable()
const namesIn = z.record(z.string().regex(/^[a-z]{2,3}$/), maybeWords(L.name))
const codeName = output({ code: z.string(), name: z.string() })
const counts = { people: z.number().int(), met: z.number().int(), due: z.number().int(), overdue: z.number().int() }
const law = output({ training: z.string(), agreement: z.string(), machines: z.string() })
const courseType = z.enum(COURSE_TYPES)
const courseStatus = z.enum(COURSE_STATUSES)
const needState = z.enum(NEED_STATES)

export const courseOut = output({
  id: id(),
  /** Null: a course of the whole group. */
  companyId: id().nullable(),
  company: codeName.nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  type: courseType,
  /** Decimal strings ("12", "12.5"). */
  hours: z.string(),
  refresherMonths: z.number().int().nullable(),
  refresherHours: z.string().nullable(),
  inPersonRequired: z.boolean(),
  provider: z.string().nullable(),
  legalBasis: z.string(),
  sortOrder: z.number().int(),
  status: courseStatus,
  version: z.number().int(),
  updatedAt: instant(),
  /** How many ACTIVE role sheets (the caller reads) and active machine types ask it. */
  requiredBy: output({ roleSheets: z.number().int(), machineClasses: z.number().int() }),
  canManage: z.boolean(),
})

const courseRef = output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, type: courseType, hours: z.string(), refresherMonths: z.number().int().nullable(), status: courseStatus, companyId: id().nullable() })

export const listCoursesContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional(),
    type: courseType.optional(),
    q: z.string().trim().max(100).optional(),
  }),
  response: { 200: output({ courses: z.array(courseOut), complete: z.boolean(), canAdd: z.boolean(), canAddGroupWide: z.boolean(), law, today: businessDate() }) },
})

const roleRef = output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, companyId: id(), siteId: id(), site: codeName })
const classOut = output({ id: id(), code: z.string(), label: z.record(z.string(), z.string()), icon: z.string().nullable(), active: z.boolean() })

export const courseRecordContract = defineContract({
  params: input({ courseId: id() }),
  response: {
    200: output({
      course: courseOut,
      createdAt: instant(),
      /** Who asks it: the role sheets (the caller reads; days after taking the role, null: before starting) and the machine types. */
      askedBy: output({
        roleSheets: z.array(roleRef.extend({ withinDays: z.number().int().nullable() })),
        machineClasses: z.array(classOut.extend({ withinDays: z.number().int().nullable() })),
      }),
      /** The people they ask it of (counts): met, due, overdue. */
      people: output(counts),
      law,
      today: businessDate(),
    }),
  },
})

const courseFieldsIn = {
  name: words(L.name),
  nameI18n: namesIn.nullish(),
  hours: hours(),
  /** A refresher every 1 to 120 months; null: none. */
  refresherMonths: z.number().int().min(1).max(L.refresherMonths).nullable().optional(),
  refresherHours: hours().nullable().optional(),
  inPersonRequired: z.boolean().optional(),
  provider: maybeWords(L.provider).nullish(),
  /** The rule it rests on; left out: the type's (factory-domain COURSE_TYPE_LAW). */
  legalBasis: words(L.legalBasis).optional(),
  sortOrder: z.number().int().min(0).max(L.sortOrder).optional(),
}

const newCourseIn = {
  /** Unique in the group; letters, digits and . _ / - (stored in capitals). */
  code: words(L.code),
  type: courseType,
  ...courseFieldsIn,
}

export const createCourseContract = defineContract({
  body: input({
    /** Null or left out: a course of the whole group (a grant over every company). */
    companyId: id().nullable().optional(),
    ...newCourseIn,
  }),
  response: { 201: output({ course: courseOut }), 200: output({ course: courseOut }) },
})

export const standardListContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      /** The common courses to review: type, name, the law; hours and periods null (the company types its own). */
      courses: z.array(
        output({
          code: z.string(),
          type: courseType,
          name: z.string(),
          nameI18n: z.record(z.string(), z.string()),
          legalBasis: z.string(),
          hours: z.null(),
          refresherMonths: z.null(),
          refresherHours: z.null(),
          /** A course with this code is in the catalogue already (codes are unique in the group). */
          codeTaken: z.boolean(),
          /** Courses of the same type the catalogue has (of the company asked and of the group). */
          existing: z.array(output({ id: id(), code: z.string(), name: z.string(), status: courseStatus })),
        }),
      ),
      canAddGroupWide: z.boolean(),
      law,
    }),
  },
})

export const createStandardContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    /** The reviewed list: each course with the hours (and refresher) typed from the company's programme. */
    courses: z.array(input(newCourseIn)).min(1).max(L.standard),
  }),
  response: { 201: output({ courses: z.array(courseOut) }), 200: output({ courses: z.array(courseOut) }) },
})

const draftIn = {
  name: words(L.name).optional(),
  nameI18n: namesIn.nullish(),
  hours: hours().optional(),
  refresherMonths: z.number().int().min(1).max(L.refresherMonths).nullable().optional(),
  refresherHours: hours().nullable().optional(),
  inPersonRequired: z.boolean().optional(),
  provider: maybeWords(L.provider).nullish(),
  legalBasis: words(L.legalBasis).optional(),
  sortOrder: z.number().int().min(0).max(L.sortOrder).optional(),
}

const fieldValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), z.string())])
const personDates = output({ employeeId: id(), name: z.string(), completedOn: businessDate(), validUntil: businessDate().nullable(), withNewPeriod: businessDate().nullable() })

const coursePreviewOut = {
  /** The fields that change, from → to (hours as numbers). */
  changes: z.array(output({ field: z.enum(COURSE_FIELDS), from: fieldValue, to: fieldValue })),
  /**
   * A new refresher period: records keep the date they were given (nothing moves by itself); whose date the new period WOULD
   * put elsewhere (names: the keeper of the register; at most 100, `wouldMove` counts all). Null: the period does not change.
   */
  refresher: output({
    from: z.number().int().nullable(),
    to: z.number().int().nullable(),
    holders: z.number().int(),
    followPeriod: z.number().int(),
    wouldMove: z.number().int(),
    ownDate: z.number().int(),
    people: z.array(personDates),
  }).nullable(),
  /** Send it back with the save: a change made meanwhile is refused (IMPACT_CHANGED). */
  fingerprint: z.string(),
}

export const previewCourseContract = defineContract({
  params: input({ courseId: id() }),
  body: input(draftIn),
  response: { 200: output({ course: courseOut, ...coursePreviewOut, today: businessDate() }) },
})

export const saveCourseContract = defineContract({
  params: input({ courseId: id() }),
  body: input({ version: version(), ...draftIn, impactFingerprint: fingerprint().optional() }),
  response: { 200: output({ course: courseOut, ...coursePreviewOut, changed: z.boolean() }) },
})

export const courseStatusContract = defineContract({
  params: input({ courseId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ course: courseOut }) },
})

// ---- who needs what -------------------------------------------------------------------------------------------------------

const requirementOut = output({
  courseId: id(),
  /** Days after taking the role or the authorisation; null: before starting. */
  withinDays: z.number().int().nullable(),
  note: z.string().nullable(),
  ...counts,
})

export const requirementsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({
      /** ACTIVE role sheets the caller reads: the people in the role (a count) and per course met / due / overdue. */
      roleSheets: z.array(roleRef.extend({ people: z.number().int(), courses: z.array(requirementOut) })),
      /** Active machine types: the people authorised on them the caller reads (a count) and per course the same. */
      machineClasses: z.array(classOut.extend({ people: z.number().int(), courses: z.array(requirementOut) })),
      /** Person × course rows over both (each person once per course, the earliest due day). */
      overall: output({ ...counts, needs: z.number().int() }),
      courses: z.array(courseRef),
      complete: z.boolean(),
      canManageClasses: z.boolean(),
      law,
      today: businessDate(),
    }),
  },
})

const personNeedOut = output({
  employeeId: id(),
  name: z.string(),
  siteId: id(),
  /** The day they took the role, or the day the authorisation starts. */
  since: businessDate(),
  courses: z.array(output({ courseId: id(), dueOn: businessDate(), state: needState })),
})

const sheetRequirementOut = requirementOut.extend({ id: id() })

export const roleSheetNeedsContract = defineContract({
  params: input({ roleSheetId: id() }),
  response: {
    200: output({
      roleSheet: roleRef.extend({ status: courseStatus }),
      courses: z.array(sheetRequirementOut),
      people: z.array(personNeedOut),
      refs: z.array(courseRef),
      law,
      today: businessDate(),
    }),
  },
})

export const machineClassNeedsContract = defineContract({
  params: input({ machineClassId: id() }),
  response: {
    200: output({
      machineClass: classOut,
      /** Each line's id and version: what a change is checked against. */
      courses: z.array(sheetRequirementOut.extend({ version: z.number().int() })),
      people: z.array(personNeedOut),
      sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      refs: z.array(courseRef),
      canManage: z.boolean(),
      law,
      today: businessDate(),
    }),
  },
})

const requirementsIn = z
  .array(input({ courseId: id(), withinDays: z.number().int().min(0).max(L.withinDays).nullable(), note: maybeWords(L.note).nullish() }))
  .max(L.requirements)

const impactLineOut = output({
  kind: z.enum(IMPACT_KINDS),
  courseId: id().nullable(),
  people: z.number().int(),
  already: z.number().int(),
  /** Who (at most 100; `people` counts all); null on a course no longer asked (a count). */
  names: z.array(output({ employeeId: id(), name: z.string() })).nullable(),
  withinDays: output({ from: z.number().int().nullable(), to: z.number().int().nullable() }).nullable(),
})

const classPreviewOut = {
  changes: output({
    added: z.array(id()),
    removed: z.array(id()),
    changed: z.array(output({ courseId: id(), withinDays: output({ from: z.number().int().nullable(), to: z.number().int().nullable() }) })),
    /** Only a note changed on these. */
    noted: z.array(id()),
    nothing: z.boolean(),
  }),
  impact: z.array(impactLineOut),
  /** People authorised on the type of machine now (the caller reads). */
  people: z.number().int(),
  refs: z.array(courseRef),
  /** Send it back with the change: one made meanwhile is refused (IMPACT_CHANGED). */
  fingerprint: z.string(),
}

export const previewClassContract = defineContract({
  params: input({ machineClassId: id() }),
  body: input({ requirements: requirementsIn }),
  response: { 200: output({ machineClass: classOut, ...classPreviewOut, today: businessDate() }) },
})

export const applyClassContract = defineContract({
  params: input({ machineClassId: id() }),
  body: input({ requirements: requirementsIn, fingerprint: fingerprint() }),
  response: { 200: output({ machineClass: classOut, ...classPreviewOut, applied: z.boolean() }) },
})
