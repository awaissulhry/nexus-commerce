import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { IMPACT_KINDS, ROLE_CHANGES, ROLE_SHEET_ITEM_KINDS, ROLE_SHEET_LIMITS, ROLE_SHEET_STATUSES, VISIT_CONSEQUENCES } from '@nexus/factory-domain/safety/rolesheets/rules'

/**
 * The role risk sheets (B-W2b-128; QHS-236; design plant.risk SCR-209: the Role sheets index, the record's Role sheets tab, the
 * sheet's form card, the pop-up "What this changes"; people.employees: the role of a person and its change). No money (a PPE
 * item's cost and supplier are never read here), never a person's health value: a sheet says whether the ROLE needs visits; a
 * person's visit is shown to the health readers only (`visit.shown`). Never the floor.
 */

const L = ROLE_SHEET_LIMITS
const words = (max: number) => z.string().trim().min(1).max(max)
const maybeWords = (max: number) => z.string().trim().max(max)
const version = () => z.number().int().min(1)
const fingerprint = () => z.string().regex(/^[0-9a-f]{64}$/)
const codeName = output({ code: z.string(), name: z.string() })
const names = z.record(z.string(), z.string()).nullable()
const status = z.enum(ROLE_SHEET_STATUSES)
const law = output({ roleSheet: z.string(), kit: z.string(), training: z.string(), surveillance: z.string(), yearlyVisit: z.string() })
const personLaw = output({ roleSheet: z.string(), kit: z.string(), training: z.string(), surveillance: z.string(), changeOfTask: z.string() })
const person = output({ employeeId: id(), name: z.string() })

export const sheetRowOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  siteId: id(),
  site: codeName,
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  status,
  /** ACTIVE people in the role (a count, never a figure about one person). */
  people: z.number().int(),
  risks: z.number().int(),
  surveillanceNeeds: z.number().int(),
  ppeItems: z.number().int(),
  courses: z.number().int(),
  /** Whether the role needs health surveillance (null: no plan yet) and every how many months. */
  surveillance: output({ needed: z.boolean().nullable(), frequencyMonths: z.number().int().nullable() }),
  /** Last changed. */
  updatedAt: instant(),
  version: z.number().int(),
  canManage: z.boolean(),
})

export const sheetOut = sheetRowOut.extend({
  description: z.string().nullable(),
  createdAt: instant(),
  items: z.array(output({ id: id(), seq: z.number().int(), kind: z.enum(ROLE_SHEET_ITEM_KINDS), title: z.string(), note: z.string().nullable() })),
  kit: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      ppeItemId: id(),
      item: output({ code: z.string(), name: z.string(), nameI18n: names, category: z.string(), standard: z.string().nullable(), sizes: z.array(z.string()), status }),
      quantity: z.number().int(),
      whenToWear: z.string(),
      note: z.string().nullable(),
    }),
  ),
  /** The courses the role asks (TrainingRequirement ROLE_SHEET). */
  requirements: z.array(
    output({
      id: id(),
      courseId: id(),
      course: output({ code: z.string(), name: z.string(), nameI18n: names, type: z.string(), hours: z.string(), refresherMonths: z.number().int().nullable(), status }),
      /** Days after taking the role; null: before starting. */
      withinDays: z.number().int().nullable(),
      note: z.string().nullable(),
    }),
  ),
  /** The role's health plan: needed (null: no plan yet), every how many months (the doctor's, set on the health page), the end-of-employment visit, the day it was set. */
  plan: output({ needed: z.boolean().nullable(), frequencyMonths: z.number().int().nullable(), endOfEmploymentVisit: z.boolean(), setOn: z.string().nullable() }),
  /** People in the role (the link to their records). */
  peopleInRole: z.array(person),
})

const placeQuery = { companyId: id().optional(), siteId: id().optional() }

export const listSheetsContract = defineContract({
  querystring: input({ ...placeQuery, status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional(), q: z.string().trim().max(100).optional() }),
  response: { 200: output({ roleSheets: z.array(sheetRowOut), complete: z.boolean(), canAdd: z.boolean(), law, today: z.string() }) },
})

export const sheetRecordContract = defineContract({
  params: input({ roleSheetId: id() }),
  response: { 200: output({ roleSheet: sheetOut, law, today: z.string() }) },
})

export const catalogueContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      ppeItems: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, category: z.string(), standard: z.string().nullable(), sizes: z.array(z.string()) })),
      courses: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, type: z.string(), hours: z.string(), refresherMonths: z.number().int().nullable() })),
    }),
  },
})

/** The whole content of a sheet, as the EditModeBar sends it. */
const contentIn = input({
  items: z.array(input({ kind: z.enum(ROLE_SHEET_ITEM_KINDS), title: words(L.title), note: maybeWords(L.note).nullish() })).max(L.items),
  kit: z.array(input({ ppeItemId: id(), quantity: z.number().int().min(1).max(L.quantity), whenToWear: words(L.whenToWear), note: maybeWords(L.note).nullish() })).max(L.kit),
  requirements: z.array(input({ courseId: id(), withinDays: z.number().int().min(0).max(L.withinDays).nullable(), note: maybeWords(L.note).nullish() })).max(L.requirements),
})
/** Whether the role needs health surveillance (left out: unchanged). */
const surveillanceIn = input({ needed: z.boolean() })
const header = {
  nameI18n: z.record(z.string().regex(/^[a-z]{2,3}$/), maybeWords(L.name)).nullish(),
  description: maybeWords(L.description).nullish(),
}

export const createSheetContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id(),
    /** Unique on the site; letters, digits and . _ / - (stored in capitals). */
    code: words(L.code),
    name: words(L.name),
    ...header,
    content: contentIn.optional(),
    surveillance: surveillanceIn.optional(),
  }),
  response: { 201: output({ roleSheet: sheetOut }), 200: output({ roleSheet: sheetOut }) },
})

const changesOut = output({
  /** The sheet's own fields that change (name, nameI18n, description). */
  header: z.array(z.string()),
  risks: output({ added: z.array(z.string()), removed: z.array(z.string()) }),
  surveillanceNeeds: output({ added: z.array(z.string()), removed: z.array(z.string()) }),
  kit: output({
    added: z.array(id()),
    removed: z.array(id()),
    changed: z.array(output({ ppeItemId: id(), quantity: output({ from: z.number().int(), to: z.number().int() }).nullable(), whenToWear: output({ from: z.string(), to: z.string() }).nullable() })),
  }),
  courses: output({ added: z.array(id()), removed: z.array(id()), changed: z.array(output({ courseId: id(), withinDays: output({ from: z.number().int().nullable(), to: z.number().int().nullable() }) })) }),
  surveillance: output({ from: z.boolean().nullable(), to: z.boolean() }).nullable(),
  nothing: z.boolean(),
})

const impactLineOut = output({
  kind: z.enum(IMPACT_KINDS),
  courseId: id().nullable(),
  ppeItemId: id().nullable(),
  people: z.number().int(),
  already: z.number().int(),
  /** Who, on the course and kit lines (at most 100; `people` counts all); null on the visit lines: counts only. */
  names: z.array(person).nullable(),
  withinDays: output({ from: z.number().int().nullable(), to: z.number().int().nullable() }).nullable(),
  quantity: z.number().int().nullable(),
  frequencyMonths: z.number().int().nullable(),
})

const refsOut = output({
  courses: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, type: z.string() })),
  ppeItems: z.array(output({ id: id(), code: z.string(), name: z.string(), nameI18n: names, category: z.string() })),
})

const previewOut = {
  changes: changesOut,
  impact: z.array(impactLineOut),
  /** ACTIVE people in the role now. */
  people: z.number().int(),
  refs: refsOut,
  /** Send it back with Apply: a change made meanwhile is refused (IMPACT_CHANGED). */
  fingerprint: z.string(),
}

const draftBody = { name: words(L.name).optional(), ...header, content: contentIn, surveillance: surveillanceIn.optional() }

export const previewSheetContract = defineContract({
  params: input({ roleSheetId: id() }),
  body: input(draftBody),
  response: { 200: output({ ...previewOut, today: z.string() }) },
})

export const applySheetContract = defineContract({
  params: input({ roleSheetId: id() }),
  body: input({ version: version(), ...draftBody, impactFingerprint: fingerprint().optional() }),
  response: { 200: output({ roleSheet: sheetOut, ...previewOut, applied: z.boolean() }) },
})

export const sheetStatusContract = defineContract({
  params: input({ roleSheetId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ roleSheet: sheetOut }) },
})

// ---- a person's role sheet (people.employees) -----------------------------------------------------------------------------

const sheetRef = output({ id: id(), code: z.string(), name: z.string(), status }).nullable()
const courseRef = output({ code: z.string(), name: z.string(), type: z.string() }).nullable()
const itemRef = output({ code: z.string(), name: z.string(), category: z.string() }).nullable()

export const personRoleSheetContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string(), siteId: id(), jobRole: z.string().nullable(), status: z.enum(['ACTIVE', 'LEFT']), version: z.number().int() }),
      roleSheet: sheetRef,
      /** The day they took the role (their newest role change, else their start). */
      since: businessDate().nullable(),
      asks: output({
        risks: z.array(z.string()),
        courses: z.array(output({ courseId: id(), course: courseRef, withinDays: z.number().int().nullable(), held: z.boolean() })),
        kit: z.array(output({ ppeItemId: id(), item: itemRef, quantity: z.number().int(), whenToWear: z.string(), held: z.number().int() })),
        /** The role's visits and the surveillance needs behind them: the health readers only (shown false: nothing said). */
        visits: output({ shown: z.boolean(), needed: z.boolean().nullable(), frequencyMonths: z.number().int().nullable(), needs: z.array(z.string()) }),
      }).nullable(),
      /** The ACTIVE sheets of the person's site, to choose from. */
      choices: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      canChange: z.boolean(),
      law: personLaw,
      today: z.string(),
    }),
  },
})

const personImpactOut = {
  from: sheetRef,
  to: sheetRef,
  change: z.enum(ROLE_CHANGES),
  courses: output({
    needed: z.array(output({ courseId: id(), course: courseRef, withinDays: z.number().int().nullable(), dueOn: businessDate(), held: z.boolean() })),
    noLonger: z.array(output({ courseId: id(), course: courseRef })),
  }),
  kit: output({
    toIssue: z.array(output({ ppeItemId: id(), item: itemRef, quantity: z.number().int(), whenToWear: z.string(), held: z.number().int(), short: z.number().int() })),
    noLonger: z.array(output({ ppeItemId: id(), item: itemRef })),
  }),
  /** The health readers see the visit (a change-of-task visit, the doctor not asked yet, none); others read shown false. */
  visit: output({ shown: z.boolean(), consequence: z.enum(VISIT_CONSEQUENCES).nullable(), frequencyMonths: z.number().int().nullable() }),
  fingerprint: z.string(),
}

export const previewRoleChangeContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ roleSheetId: id().nullable() }),
  response: { 200: output({ employee: output({ id: id(), name: z.string(), version: z.number().int() }), ...personImpactOut, law: personLaw, today: z.string() }) },
})

export const setRoleSheetContract = defineContract({
  params: input({ employeeId: id() }),
  body: input({ version: version(), roleSheetId: id().nullable(), impactFingerprint: fingerprint().optional(), reason: maybeWords(L.reason).optional() }),
  response: { 200: output({ employee: output({ id: id(), version: z.number().int(), roleSheet: sheetRef }), ...personImpactOut, changed: z.boolean() }) },
})
