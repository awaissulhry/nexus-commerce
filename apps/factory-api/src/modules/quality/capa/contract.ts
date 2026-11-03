import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import {
  ACTION_KINDS,
  ACTION_STATUSES,
  CAPA_LIMITS,
  CAPA_PRIORITIES,
  CAPA_STATUSES,
  CAPA_TYPES,
  CAPA_VIEWS,
  ESCALATION_REASONS,
  SOURCE_TYPES,
} from '@nexus/factory-domain/quality/capa/rules'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108; QHS-087, QHS-093, QHS-094, QHS-096; design quality.capa). No money
 * anywhere. Every write takes an Idempotency-Key; a CAPA's own writes its `version`, an action's write the action's
 * `version`. Refusals in words: `body/<field>` (400), a step its state does not take (409 invalid_state, `held/<CODE>`
 * in issues[0].path: FINAL, NOT_LAST_STAGE, NO_ACTION_DONE, ACTIONS_OPEN, ACTION_ENDED, ESCALATED_ELSEWHERE, NCR_CANCELLED,
 * NCR_KEEPS_CAPA, OTHER_COMPANY, TOO_MANY_REMINDERS), a stale version (409 conflict). Office people by id, their names in
 * `people`; no worker anywhere.
 */

const version = z.number().int().min(1)
const status = z.enum(CAPA_STATUSES)
const text = (max: number) => z.string().max(max)
const words = (max: number) => text(max).nullable()
const capaParams = input({ capaId: id() })
const actionParams = input({ capaId: id(), actionId: id() })
const person = output({ id: id(), name: z.string() })
const issue = output({ path: z.string(), message: z.string() })
const teamMember = input({ userId: id(), role: text(CAPA_LIMITS.teamRole) })
const sourceInput = input({ recordType: z.enum(SOURCE_TYPES), recordId: id(), note: words(CAPA_LIMITS.note).optional() })
const customer = output({ id: id(), code: z.string(), name: z.string() })

/** One row of the list (design capa-grid) and the head of the record. */
export const capaRow = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  type: z.enum(CAPA_TYPES),
  title: z.string(),
  status,
  priority: z.enum(CAPA_PRIORITIES),
  customer: customer.nullable(),
  ownerId: id(),
  team: z.array(output({ userId: id(), role: z.string() })),
  dueOn: businessDate(),
  /** The first due day of its open actions (the design's "Next due"). */
  nextDue: businessDate().nullable(),
  /** Open and its own due day is behind us. */
  overdue: z.boolean(),
  /** The records it came from: how many, and the first five (label null: a record the reader may not see). */
  sources: output({ count: z.number().int(), items: z.array(output({ id: id(), recordType: z.string(), recordId: id(), label: z.string().nullable() })) }),
  actions: output({ count: z.number().int(), open: z.number().int(), overdue: z.number().int(), done: z.number().int() }),
  ageDays: z.number().int(),
  closedAt: instant().nullable(),
  cancelledAt: instant().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const actionView = output({
  id: id(),
  seq: z.number().int(),
  kind: z.enum(ACTION_KINDS),
  description: z.string(),
  ownerId: id(),
  dueOn: businessDate(),
  status: z.enum(ACTION_STATUSES),
  overdue: z.boolean(),
  remindersSent: z.number().int(),
  lastRemindedAt: instant().nullable(),
  /** The escalation path (null: the company's overdue-action rule's audience). */
  escalateToId: id().nullable(),
  escalatedAt: instant().nullable(),
  doneAt: instant().nullable(),
  doneById: id().nullable(),
  evidenceNote: z.string().nullable(),
  /** Its evidence files (StoredFile recordType "CapaAction"). */
  files: z.number().int(),
  cancelReason: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const check = output({ key: z.enum(['LAST_STAGE', 'ACTION_DONE', 'NO_OPEN_ACTION']), ok: z.boolean(), words: z.string() })

/** GET /quality/capa/:capaId — the record's tabs Problem, Actions, Report, and its band. */
export const capaRecordView = output({
  capa: capaRow.extend({
    problem: output({ what: z.string().nullable(), where: z.string().nullable(), when: z.string().nullable(), howMany: z.string().nullable() }),
    closedById: id().nullable(),
    closeNote: z.string().nullable(),
    cancelReason: z.string().nullable(),
    createdById: id().nullable(),
  }),
  /** What it came from; `record` null: a record the reader may not see (an NCR of another site, a complaint of another customer). */
  sources: z.array(
    output({
      id: id(),
      recordType: z.enum(SOURCE_TYPES),
      recordId: id(),
      note: z.string().nullable(),
      createdAt: instant(),
      createdById: id().nullable(),
      record: output({ number: z.string(), title: z.string().nullable(), state: z.string(), severity: z.string().nullable(), category: z.string().nullable(), siteId: id().nullable(), namesThisCapa: z.boolean() }).nullable(),
    }),
  ),
  /** D3, live from the NCRs the reader sees: their containment actions and holds still active. */
  containment: z.array(
    output({
      ncrId: id(),
      number: z.string(),
      stage: z.string(),
      activeHolds: z.number().int(),
      actions: z.array(output({ seq: z.number().int(), kind: z.string(), description: z.string().nullable(), status: z.string(), dueAt: instant().nullable(), doneAt: instant().nullable() })),
    }),
  ),
  /** D4, the cause codes its NCRs name (the root-cause tools are W3). */
  causes: z.array(output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), process: z.string() })),
  actions: z.array(actionView),
  /** The 8D report's versions kept, newest first. */
  documents: z.array(output({ id: id(), version: z.number().int(), language: z.string(), number: z.string().nullable(), fileId: id(), createdAt: instant(), createdById: id().nullable() })),
  next: output({ stage: status.nullable() }),
  closing: output({ checks: z.array(check), ready: z.boolean() }),
  may: output({ manage: z.boolean(), edit: z.boolean(), close: z.boolean(), report: z.boolean() }),
  people: z.array(person),
})

const one = output({ record: capaRecordView })

// ---- reads ------------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    /** A saved row: open (default) | mine | overdue | closed | cancelled | all. */
    view: z.enum(CAPA_VIEWS).optional(),
    /** One status or a comma list; wins over `view`. */
    status: z.string().max(200).optional(),
    type: z.enum(CAPA_TYPES).optional(),
    priority: z.enum(CAPA_PRIORITIES).optional(),
    customerId: id().optional(),
    /** me | a person's id. */
    owner: z.string().max(40).optional(),
    /** The CAPAs of an NCR or a complaint. */
    sourceType: z.enum(SOURCE_TYPES).optional(),
    sourceId: id().optional(),
    /** Number, title, customer code or name. */
    q: z.string().max(100).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(CAPA_LIMITS.list).optional(),
  }),
  response: { 200: output({ capas: z.array(capaRow), nextCursor: z.string().nullable(), people: z.array(person), asOf: instant() }) },
})

export const countsContract = defineContract({
  response: { 200: output({ tiles: output({ open: z.number().int(), actionsOverdue: z.number().int(), mine: z.number().int() }), asOf: instant() }) },
})

export const peopleContract = defineContract({
  querystring: input({ companyId: id(), customerId: id().optional() }),
  response: { 200: output({ people: z.array(output({ id: id(), name: z.string(), manages: z.boolean(), remindable: z.boolean(), me: z.boolean() })) }) },
})

export const escalateContract = defineContract({
  querystring: input({ recordType: z.enum(SOURCE_TYPES), /** Ids, comma separated (≤ 50). */ ids: z.string().max(2000) }),
  response: {
    200: output({
      records: z.array(
        output({
          recordType: z.enum(SOURCE_TYPES),
          recordId: id(),
          number: z.string(),
          title: z.string().nullable(),
          companyId: id(),
          state: z.string(),
          /** The rule that suggests it (ncr-capa "repeat defect", "critical", "customer complaint"). */
          reasons: z.array(z.enum(ESCALATION_REASONS)),
          escalatedTo: output({ capaId: id(), number: z.string(), status }).nullable(),
          /** Why it cannot go (`held/<CODE>`), else null. */
          problem: issue.nullable(),
        }),
      ),
      companyId: id().nullable(),
      sameCompany: z.boolean(),
      ready: z.boolean(),
      capas: z.array(output({ id: id(), number: z.string(), title: z.string(), type: z.enum(CAPA_TYPES), status, customer: customer.nullable(), version: z.number().int() })),
      mayOpen: z.boolean(),
      mayView: z.boolean(),
      asOf: instant(),
    }),
  },
})

export const getContract = defineContract({ params: capaParams, response: { 200: one } })

// ---- the CAPA's writes ------------------------------------------------------------------------------------------------

const problemFields = {
  problemWhat: words(CAPA_LIMITS.problem).optional(),
  problemWhere: words(CAPA_LIMITS.problem).optional(),
  problemWhen: words(CAPA_LIMITS.problem).optional(),
  problemHowMany: words(CAPA_LIMITS.problem).optional(),
}

export const openContract = defineContract({
  body: input({
    /** The company (else the one of the records it comes from). */
    companyId: id().optional(),
    type: z.enum(CAPA_TYPES),
    title: text(CAPA_LIMITS.title),
    /** Default: the caller. */
    ownerId: id().optional(),
    team: z.array(teamMember).max(CAPA_LIMITS.team).optional(),
    dueOn: businessDate(),
    priority: z.enum(CAPA_PRIORITIES).optional(),
    /** A CUSTOMER or BRAND of the company (an 8D for a customer). */
    customerId: id().nullable().optional(),
    ...problemFields,
    /** The NCRs and complaints it comes from, escalated in the same command. */
    sources: z.array(sourceInput).max(CAPA_LIMITS.sources).optional(),
  }),
  response: { 201: one },
})

export const editContract = defineContract({
  params: capaParams,
  body: input({
    version,
    title: text(CAPA_LIMITS.title).optional(),
    ownerId: id().optional(),
    team: z.array(teamMember).max(CAPA_LIMITS.team).optional(),
    dueOn: businessDate().optional(),
    priority: z.enum(CAPA_PRIORITIES).optional(),
    customerId: id().nullable().optional(),
    ...problemFields,
  }),
  response: { 200: one },
})

export const stageContract = defineContract({ params: capaParams, body: input({ version, to: status }), response: { 200: one } })
export const closeContract = defineContract({ params: capaParams, body: input({ version, /** The closing words (D8). */ note: text(CAPA_LIMITS.closeNote) }), response: { 200: one } })
export const cancelContract = defineContract({ params: capaParams, body: input({ version, reason: text(CAPA_LIMITS.reason) }), response: { 200: one } })

export const addSourcesContract = defineContract({
  params: capaParams,
  body: input({ /** The CAPA's version when the screen has it (escalating from the NCR list need not). */ version: version.optional(), sources: z.array(sourceInput).min(1).max(CAPA_LIMITS.sources) }),
  response: { 201: output({ record: capaRecordView, added: z.number().int() }) },
})
export const removeSourceContract = defineContract({ params: input({ capaId: id(), sourceId: id() }), querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: one } })

// ---- actions ----------------------------------------------------------------------------------------------------------

export const addActionContract = defineContract({
  params: capaParams,
  body: input({
    kind: z.enum(ACTION_KINDS),
    description: text(CAPA_LIMITS.description),
    /** Default: the caller. */
    ownerId: id().optional(),
    dueOn: businessDate(),
    /** The escalation path; null or left out: the company's overdue-action rule's audience. */
    escalateToId: id().nullable().optional(),
  }),
  response: { 201: output({ record: capaRecordView, actionId: id() }) },
})

export const editActionContract = defineContract({
  params: actionParams,
  body: input({
    version,
    kind: z.enum(ACTION_KINDS).optional(),
    description: text(CAPA_LIMITS.description).optional(),
    ownerId: id().optional(),
    dueOn: businessDate().optional(),
    escalateToId: id().nullable().optional(),
  }),
  response: { 200: one },
})

export const doneActionContract = defineContract({ params: actionParams, body: input({ version, /** What was done; else a file of the action uploaded first. */ evidenceNote: words(CAPA_LIMITS.evidence).optional() }), response: { 200: one } })
export const cancelActionContract = defineContract({ params: actionParams, body: input({ version, reason: text(CAPA_LIMITS.reason) }), response: { 200: one } })
export const remindActionContract = defineContract({
  params: actionParams,
  body: input({ version }),
  response: { 200: output({ record: capaRecordView, reminder: output({ reminder: z.number().int(), taskId: id().nullable(), assigneeId: id().nullable() }) }) },
})

// ---- the 8D report ------------------------------------------------------------------------------------------------------

export const previewReportContract = defineContract({ params: capaParams, querystring: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }), response: {} })
export const makeReportContract = defineContract({
  params: capaParams,
  body: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: {
    201: output({
      report: output({ id: id(), version: z.number().int(), language: z.string(), number: z.string().nullable(), fileId: id(), createdAt: instant(), createdById: id().nullable() }),
      /** False: the newest version already showed exactly this. */
      made: z.boolean(),
    }),
  },
})
