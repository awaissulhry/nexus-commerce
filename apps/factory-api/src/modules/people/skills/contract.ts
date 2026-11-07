import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { QUALIFICATION_DECISIONS, QUALIFICATION_FINDINGS, QUALIFICATION_MODES, QUALIFICATION_OUTCOMES, TRAINING_NEED_STATES } from '@nexus/factory-domain/people/skills/qualification'
import { DUE_STATES } from '@nexus/factory-domain/safety/records/rules'
import { AUTHORISATION_STATES, SKILL_KINDS, SKILL_LEVELS, SKILL_LIMITS, SKILL_STATUSES, TRAINEE_STATES } from '@nexus/factory-domain/people/skills/rules'
import { refOut } from '../employees/contract'

/**
 * Skills and machine authorisations (B-W2b-39; MES-241, MES-244, MES-246, MES-024; design people.skills, people.employees
 * › Skills & training, floor.operation "Checks before it counts", production.dispatch "assign"). A level is a
 * qualification a person judged, never a figure about one person's work: no answer carries a score, a count per person
 * or a rank (Statuto dei Lavoratori art. 4; AI Act Annex III 4(b)).
 */

const version = () => z.number().int().min(1)
const day = () => z.string()
const words = () => z.record(z.string(), z.string().max(SKILL_LIMITS.name))
const reason = () => z.string().trim().min(1).max(SKILL_LIMITS.reason)

const classOut = output({ id: id(), code: z.string(), labelEn: z.string(), labelIt: z.string() })

export const skillOut = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  kind: z.enum(SKILL_KINDS),
  operation: refOut.nullable(),
  machineClass: classOut.nullable(),
  sortOrder: z.number().int(),
  status: z.enum(SKILL_STATUSES),
  version: z.number().int(),
})

export const levelOut = output({
  id: id(),
  employeeId: id(),
  skill: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(SKILL_KINDS), status: z.enum(SKILL_STATUSES) }),
  level: z.enum(SKILL_LEVELS),
  since: day(),
  assessedAt: z.string(),
  assessedBy: z.string().nullable(),
  traineeUntil: day().nullable(),
  trainee: z.enum(TRAINEE_STATES),
  signedOffOn: day().nullable(),
  signedOffBy: z.string().nullable(),
  trainer: output({ employeeId: id(), name: z.string() }).nullable(),
  removedAt: z.string().nullable(),
  removedBy: z.string().nullable(),
  removeReason: z.string().nullable(),
  version: z.number().int(),
})

export const authorisationOut = output({
  id: id(),
  employeeId: id(),
  machineClass: classOut,
  authorisedOn: day(),
  validUntil: day().nullable(),
  state: z.enum(AUTHORISATION_STATES),
  authorisedBy: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  revokeReason: z.string().nullable(),
  version: z.number().int(),
})

// ---- the catalogue ------------------------------------------------------------------------------------------------------

export const listSkillsContract = defineContract({
  querystring: input({ kind: z.enum(SKILL_KINDS).optional(), status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(), companyId: id().optional() }),
  response: { 200: output({ skills: z.array(skillOut), canManage: z.boolean() }) },
})

export const createSkillContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    code: z.string().trim().min(1).max(SKILL_LIMITS.code),
    name: z.string().trim().min(1).max(SKILL_LIMITS.name),
    nameI18n: words().optional(),
    kind: z.enum(SKILL_KINDS),
    operationId: id().nullable().optional(),
    machineClassId: id().nullable().optional(),
    sortOrder: z.number().int().optional(),
  }),
  response: { 200: output({ skill: skillOut }), 201: output({ skill: skillOut }) },
})

export const updateSkillContract = defineContract({
  params: input({ skillId: id() }),
  body: input({ version: version(), name: z.string().trim().min(1).max(SKILL_LIMITS.name).optional(), nameI18n: words().optional(), sortOrder: z.number().int().optional() }),
  response: { 200: output({ skill: skillOut, changed: z.boolean() }) },
})

export const skillStatusContract = defineContract({
  params: input({ skillId: id() }),
  body: input({ version: version() }),
  response: { 200: output({ skill: skillOut, changed: z.boolean() }) },
})

// ---- levels and trainees ------------------------------------------------------------------------------------------------

export const setLevelContract = defineContract({
  body: input({
    employeeId: id(),
    skillId: id(),
    level: z.enum(SKILL_LEVELS),
    since: businessDate().optional(),
    traineeUntil: businessDate().nullable().optional(),
    version: version().optional(),
  }),
  response: { 200: output({ level: levelOut, changed: z.boolean() }) },
})

export const signOffContract = defineContract({
  params: input({ levelId: id() }),
  body: input({ version: version(), signedOffOn: businessDate().optional(), trainerEmployeeId: id().nullable().optional(), level: z.enum(SKILL_LEVELS).optional() }),
  response: { 200: output({ level: levelOut }) },
})

export const removeLevelContract = defineContract({
  params: input({ levelId: id() }),
  body: input({ version: version(), reason: reason() }),
  response: { 200: output({ level: levelOut }) },
})

// ---- machine authorisations ---------------------------------------------------------------------------------------------

// B-W2b-139: the courses a type of machine asks, against the day the authorisation starts.
const trainingLineOut = output({ courseId: id(), code: z.string(), name: z.string(), withinDays: z.number().int().nullable(), state: z.enum(TRAINING_NEED_STATES), dueOn: day(), validUntil: day().nullable() })
const authorisedOut = output({ authorisation: authorisationOut, words: z.string(), training: z.array(trainingLineOut), held: z.boolean() })

export const authoriseContract = defineContract({
  body: input({ employeeId: id(), machineClassId: id(), authorisedOn: businessDate().optional(), validUntil: businessDate().nullable().optional() }),
  response: { 200: authorisedOut, 201: authorisedOut },
})

export const prerequisitesContract = defineContract({
  querystring: input({ employeeId: id(), machineClassId: id(), authorisedOn: businessDate().optional() }),
  response: {
    200: output({
      machineClass: classOut.extend({ active: z.boolean(), authorisationRequired: z.boolean() }),
      authorisedOn: day(),
      training: z.array(trainingLineOut),
      trainingValid: z.boolean(),
      held: z.boolean(),
      /** Fitness (yes / no only) comes with the health pages (B-W2b-135). */
      fitness: z.null(),
      words: z.string(),
      employeeActive: z.boolean(),
      today: day(),
    }),
  },
})

export const authorisationRuleContract = defineContract({
  params: input({ machineClassId: id() }),
  body: input({ version: version(), required: z.boolean() }),
  response: {
    200: output({
      machineClass: classOut.extend({ active: z.boolean(), authorisationRequired: z.boolean(), version: z.number().int(), updatedAt: z.string() }),
      changed: z.boolean(),
      authorisedPeople: z.number().int(),
      words: z.string(),
    }),
  },
})

export const validUntilContract = defineContract({
  params: input({ authorisationId: id() }),
  body: input({ version: version(), validUntil: businessDate().nullable() }),
  response: { 200: output({ authorisation: authorisationOut }) },
})

export const revokeContract = defineContract({
  params: input({ authorisationId: id() }),
  body: input({ version: version(), reason: reason() }),
  response: { 200: output({ authorisation: authorisationOut }) },
})

// ---- the matrix, a person's skills, one cell ----------------------------------------------------------------------------

const levelCellOut = output({ skillId: id(), levelId: id(), level: z.enum(SKILL_LEVELS), since: day(), traineeUntil: day().nullable(), trainee: z.enum(TRAINEE_STATES), signedOffOn: day().nullable(), version: z.number().int() })
const authorisationCellOut = output({
  machineClassId: id(),
  authorisationId: id(),
  state: z.enum(AUTHORISATION_STATES),
  authorisedOn: day(),
  validUntil: day().nullable(),
  ending: z.boolean(),
  /** B-W2b-139: held by expired or missing training (design "Machines (Authorised / Held / —)"), and the courses. */
  held: z.boolean(),
  heldBy: z.array(id()),
  version: z.number().int(),
})
// B-W2b-139: a safety course's cell (design DueCell: valid until, due, overdue, Needed; shaded = required by the role sheet).
const trainingCellOut = output({
  courseId: id(),
  state: z.enum(DUE_STATES),
  needed: z.boolean(),
  required: z.boolean(),
  dueOn: day().nullable(),
  overdue: z.boolean(),
  soon: z.boolean(),
  neededBy: day().nullable(),
  record: output({ id: id(), completedOn: day(), validUntil: day().nullable(), languageChecked: z.boolean() }).nullable(),
  lastResult: z.enum(['PASSED', 'FAILED']).nullable(),
  languageNotChecked: z.boolean(),
})
const courseRefOut = output({ id: id(), code: z.string(), name: z.string(), nameI18n: z.record(z.string(), z.string()).nullable(), type: z.string(), hours: z.string(), refresherMonths: z.number().int().nullable(), status: z.string(), companyId: id().nullable() })

export const matrixContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    companyId: id().optional(),
    lineId: id().optional(),
    teamId: id().optional(),
    show: z.enum(['ALL', 'SKILLS', 'MACHINES', 'SAFETY']).optional(),
    tile: z.enum(['TRAINEES', 'AUTHORISATIONS_ENDING', 'TRAINING_OVERDUE', 'TRAINING_DUE_SOON', 'AUTHORISATIONS_HELD', 'LANGUAGE_NOT_CHECKED']).optional(),
    sort: z.enum(['TEAM', 'NAME']).optional(),
    q: z.string().trim().max(80).optional(),
  }),
  response: {
    200: output({
      rows: z.array(
        output({
          employeeId: id(),
          name: z.string(),
          displayName: z.string(),
          companyId: id(),
          siteId: id(),
          line: refOut.nullable(),
          team: refOut.nullable(),
          levels: z.array(levelCellOut),
          authorisations: z.array(authorisationCellOut),
          /** B-W2b-139: null when the caller does not read this person's safety records (safety.view). */
          trainings: z.array(trainingCellOut).nullable(),
          canManage: z.boolean(),
          canAuthorise: z.boolean(),
        }),
      ),
      complete: z.boolean(),
      skills: z.array(skillOut),
      machineClasses: z.array(classOut.extend({ active: z.boolean(), authorisationRequired: z.boolean(), keptAtSites: z.array(id()) })),
      /** B-W2b-139: the safety courses of the cells (the Safety column group). */
      courses: z.array(courseRefOut),
      sites: z.array(refOut),
      tiles: output({
        trainees: z.number().int(),
        traineesOverdue: z.number().int(),
        authorisationsEnding: z.number().int(),
        /** B-W2b-139: person × course; null when the caller reads no one's safety records. */
        trainingOverdue: z.number().int().nullable(),
        trainingDueSoon: z.number().int().nullable(),
        authorisationsHeld: z.number().int(),
        languageNotChecked: z.number().int().nullable(),
      }),
      today: day(),
    }),
  },
})

export const employeeSkillsContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string(), companyId: id(), siteId: id(), status: z.enum(['ACTIVE', 'LEFT']) }),
      levels: z.array(levelOut),
      authorisations: z.array(authorisationOut),
      history: output({ levels: z.array(levelOut), authorisations: z.array(authorisationOut) }),
      canManage: z.boolean(),
      canAuthorise: z.boolean(),
      today: day(),
    }),
  },
})

export const cellContract = defineContract({
  querystring: input({ employeeId: id(), skillId: id().optional(), machineClassId: id().optional() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string() }),
      levels: z.array(levelOut),
      authorisations: z.array(authorisationOut),
      history: z.array(
        output({ id: id(), at: z.string(), action: z.string(), recordId: id(), by: z.string().nullable(), before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()).nullable(), reason: z.string().nullable() }),
      ),
      canManage: z.boolean(),
      canAuthorise: z.boolean(),
      today: day(),
    }),
  },
})

// ---- the qualification check --------------------------------------------------------------------------------------------

const requirementOut = output({
  kind: z.enum(['OPERATION', 'MACHINE_SKILL', 'AUTHORISATION', 'TRAINING']),
  code: z.string(),
  label: z.string(),
  state: z.string(),
  skill: refOut.nullable().optional(),
  level: z.enum(SKILL_LEVELS).nullable().optional(),
  levelId: id().nullable().optional(),
  traineeUntil: day().nullable().optional(),
  overdue: z.boolean().optional(),
  authorisationId: id().nullable().optional(),
  authorisedOn: day().nullable().optional(),
  validUntil: day().nullable().optional(),
  /** B-W2b-139 (kind TRAINING): the course, the class that asks it, the day it is due. */
  courseId: id().optional(),
  machineClass: z.string().optional(),
  dueOn: day().optional(),
})

const findingOut = output({
  code: z.enum(QUALIFICATION_FINDINGS),
  kind: z.enum(['SKILL', 'AUTHORISATION', 'PERSON']),
  mode: z.enum(['WARN', 'STRICT']),
  overridable: z.boolean(),
  requirement: z.string().nullable(),
  message: z.string(),
  fix: z.string(),
})

export const checkOut = output({
  person: output({ employeeId: id().nullable(), workerId: id().nullable(), name: z.string(), companyId: id(), siteId: id() }),
  operation: output({ id: id(), code: z.string(), name: z.string(), workOrderOperationId: id().nullable() }).nullable(),
  machines: z.array(output({ id: id(), assetNumber: z.string(), machineClass: output({ id: id(), code: z.string(), label: z.string() }) })),
  outcome: z.enum(QUALIFICATION_OUTCOMES),
  decision: z.enum(QUALIFICATION_DECISIONS),
  overridable: z.boolean(),
  trainee: z.boolean(),
  mode: z.enum(QUALIFICATION_MODES),
  rule: output({ mode: z.enum(QUALIFICATION_MODES), isDefault: z.boolean(), words: z.string() }),
  requirements: z.array(requirementOut),
  findings: z.array(findingOut),
  message: z.string(),
  today: day(),
})

export const officeCheckContract = defineContract({
  querystring: input({ employeeId: id().optional(), workerId: id().optional(), operationId: id().optional(), workOrderOperationId: id().optional(), machineId: id().optional(), stationId: id().optional() }),
  response: { 200: output({ check: checkOut }) },
})

export const floorCheckContract = defineContract({
  querystring: input({ workerId: id().optional(), operationId: id().optional(), workOrderOperationId: id().optional(), machineId: id().optional() }),
  response: {
    200: output({
      check: checkOut,
      guard: output({ mode: z.enum(['WARN', 'STRICT']), overridable: z.boolean(), message: z.string(), fix: z.string(), findings: z.array(findingOut) }).nullable(),
      stationId: id().nullable(),
    }),
  },
})

export const lineCheckContract = defineContract({
  querystring: input({ employeeId: id(), lineId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string() }),
      line: refOut,
      operations: z.array(output({ operationId: id(), code: z.string(), name: z.string(), state: z.string() })),
      canDo: z.number().int(),
      asTrainee: z.number().int(),
      kept: z.number().int(),
      notKept: z.number().int(),
      message: z.string(),
      today: day(),
    }),
  },
})
