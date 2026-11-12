import { z } from 'zod'
import {
  APPROVAL_EVENT_ACTIONS,
  APPROVAL_LIMITS,
  APPROVAL_MEANINGS,
  APPROVAL_TASK_KINDS,
  APPROVAL_TASK_STATUSES,
  APPROVAL_TILES,
  FIELD_KINDS,
  RULE_COMBINATORS,
  RULE_OPERATORS,
} from '@nexus/factory-domain/approvals/rules'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The approval engine's contracts (B-W2b-282; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105; design home.approvals
 * "tiles", "notice", "queue", "asked-by-me" and the popups review, sign, reject, why-me; admin.automation "approval-rules"
 * and the popup rule). People come as {id, name, me}; a floor worker is named only inside one request ("A floor worker" in a
 * list). A money fact (a value, a from → to, a rule's threshold) carries its grain and is left out (a threshold: `held`)
 * for a reader without that grain; summaries carry no money.
 */

const words = output({ en: z.string(), it: z.string() })
const person = output({ id: id(), name: z.string(), me: z.boolean() })
const version = z.number().int().min(1)
const grain = z.enum(GRAINS).nullable()
const decision = output({ allowed: z.boolean(), why: z.string().nullable() })

// ---- kinds and rules ------------------------------------------------------------------------------------------------------

const fieldView = output({
  id: z.string(),
  label: words,
  kind: z.enum(FIELD_KINDS),
  unit: z.string().nullable(),
  grain,
  options: z.array(output({ value: z.string(), label: words })),
  min: z.number().nullable(),
  max: z.number().nullable(),
  /** Why the reader may not use it in a rule (a money fact without its grain); null: they may. */
  heldReason: z.string().nullable(),
})

export const kindView = output({
  kind: z.enum(APPROVAL_TASK_KINDS),
  recordType: z.string(),
  label: words,
  fields: z.array(fieldView),
  /** A person may ask a yes on its records from the generic route (else only its own page asks). */
  askable: z.boolean(),
})

export const kindsContract = defineContract({
  response: {
    200: output({
      kinds: z.array(kindView),
      /** Kinds a request may be of whose checker no step registered yet (their rules cannot be written or tested). */
      notRegistered: z.array(z.enum(APPROVAL_TASK_KINDS)),
      meanings: z.array(output({ meaning: z.enum(APPROVAL_MEANINGS), label: words })),
      operators: z.array(z.enum(RULE_OPERATORS)),
    }),
  },
})

const conditionRow = z.strictObject({
  id: z.string().min(1).max(80).optional(),
  field: z.string().min(1).max(80),
  operator: z.enum(RULE_OPERATORS),
  value: z.union([z.string().max(APPROVAL_LIMITS.rowValue), z.array(z.string().max(APPROVAL_LIMITS.rowValue)).max(APPROVAL_LIMITS.rowValues)]).nullable(),
})
const condition = z.strictObject({ combinator: z.enum(RULE_COMBINATORS), rows: z.array(conditionRow).max(APPROVAL_LIMITS.conditionRows) })
const approver = z.union([z.strictObject({ roleId: id() }), z.strictObject({ userId: id() })])

const ruleView = output({
  id: id(),
  kind: z.enum(APPROVAL_TASK_KINDS),
  kindLabel: words,
  /** The kind has a checker (else its rule is listed but cannot be tested or asked). */
  registered: z.boolean(),
  name: z.string(),
  /** The rule in a sentence (a threshold the reader may not see: "…"). */
  sentence: words,
  companyId: id().nullable(),
  companyName: z.string().nullable(),
  condition: output({
    combinator: z.enum(RULE_COMBINATORS),
    rows: z.array(output({ id: z.string().nullable(), field: z.string(), operator: z.enum(RULE_OPERATORS), value: z.union([z.string(), z.array(z.string())]).nullable(), held: z.boolean() })),
  }),
  approver: output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string() }),
  signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable(),
  requireStepUp: z.boolean(),
  sequence: z.number().int(),
  dueHours: z.number().int().nullable(),
  active: z.boolean(),
  effectiveFrom: instant().nullable(),
  /** Requests it asked in the last 30 days (a count per rule; never per person). */
  fired30Days: z.number().int(),
  changedBy: person.nullable(),
  updatedAt: instant(),
  canChange: z.boolean(),
  /** Why the reader may not change it (a threshold in a money grain they lack, no grant over its company); null: they may. */
  heldReason: z.string().nullable(),
  version: z.number().int(),
})

export const listRulesContract = defineContract({
  querystring: input({ kind: z.enum(APPROVAL_TASK_KINDS).optional(), active: z.enum(['true', 'false']).optional() }),
  response: {
    200: output({
      asOf: instant(),
      rules: z.array(ruleView),
      /** "Nobody approves their own request" (PLT-042): the database's rule, shown as a locked rule. */
      fixed: z.array(output({ code: z.literal('NO_SELF_APPROVAL'), sentence: words })),
      canAdd: z.boolean(),
    }),
  },
})

const ruleParams = input({ id: id() })
const ruleFields = {
  name: z.string().trim().min(1).max(APPROVAL_LIMITS.ruleName),
  condition,
  approver,
  signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable().default(null),
  requireStepUp: z.boolean().default(false),
  sequence: z.number().int().min(APPROVAL_LIMITS.sequenceMin).max(APPROVAL_LIMITS.sequenceMax).default(100),
  dueHours: z.number().int().min(1).max(APPROVAL_LIMITS.dueHoursMax).nullable().default(null),
  effectiveFrom: instant().nullable().default(null),
}

export const getRuleContract = defineContract({ params: ruleParams, response: { 200: output({ rule: ruleView }) } })
/** A new rule is written OFF (the Owner's answer): a person switches it on with PUT { active: true }. */
export const createRuleContract = defineContract({
  body: input({ kind: z.enum(APPROVAL_TASK_KINDS), companyId: id().nullable(), ...ruleFields }),
  response: { 201: output({ rule: ruleView }) },
})
export const updateRuleContract = defineContract({
  params: ruleParams,
  body: input({
    version,
    name: ruleFields.name.optional(),
    condition: condition.optional(),
    approver: approver.optional(),
    signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable().optional(),
    requireStepUp: z.boolean().optional(),
    sequence: z.number().int().min(APPROVAL_LIMITS.sequenceMin).max(APPROVAL_LIMITS.sequenceMax).optional(),
    dueHours: z.number().int().min(1).max(APPROVAL_LIMITS.dueHoursMax).nullable().optional(),
    effectiveFrom: instant().nullable().optional(),
    active: z.boolean().optional(),
  }),
  response: { 200: output({ rule: ruleView }) },
})

/** The rule popup's Test (design: "Would have asked for 4 of the last 50 quotes" with links; who would approve). Nothing is saved. */
export const testRuleContract = defineContract({
  body: input({ kind: z.enum(APPROVAL_TASK_KINDS), companyId: id().nullable(), condition, approver: approver.optional() }),
  response: {
    200: output({
      /** The kind's latest records the reader may see, at most 50. */
      tested: z.number().int(),
      wouldAsk: z.number().int(),
      samples: z.array(output({ record: output({ type: z.string(), id: id(), label: z.string() }), companyId: id() })),
      /** Who would approve the first sample's request, else a request of the rule's company (the role's holders there, never the person asking). */
      approvers: z.array(output({ id: id(), name: z.string() })),
      sentence: words,
    }),
  },
})

// ---- requests -----------------------------------------------------------------------------------------------------------

const factView = output({ field: z.string(), label: words.nullable(), value: z.unknown(), grain })
const changeView = output({ field: z.string(), label: words.nullable(), from: z.unknown(), to: z.unknown(), grain })
const requester = output({ kind: z.enum(['PERSON', 'WORKER']), id: id(), name: z.string(), me: z.boolean() })
const approverView = output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string(), me: z.boolean() })

export const taskRow = output({
  id: id(),
  kind: z.enum(APPROVAL_TASK_KINDS),
  kindLabel: words,
  status: z.enum(APPROVAL_TASK_STATUSES),
  summary: z.string(),
  record: output({ type: z.string(), id: id() }),
  companyId: id(),
  siteId: id().nullable(),
  requester,
  approver: approverView,
  /** The rule that named the approver (the first that held), with the reader's sentence. */
  rule: output({ id: id(), name: z.string(), sentence: words }).nullable(),
  signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable(),
  requireStepUp: z.boolean(),
  changeSize: words,
  /** The rule's values ("order value 6200"), each money fact only with its grain. */
  facts: z.array(factView),
  requestedAt: instant(),
  dueAt: instant().nullable(),
  overdue: z.boolean(),
  decidedAt: instant().nullable(),
  /** A pending request re-read now: CURRENT, CHANGED (since asked), GONE, or null (no checker, or not pending). */
  recheck: z.enum(['CURRENT', 'CHANGED', 'GONE']).nullable(),
  /** Approve as the reader now (held with the words: "You asked for this; Lucia can approve it"). */
  approve: decision,
  version: z.number().int(),
})

export const listTasksContract = defineContract({
  querystring: input({
    tile: z.enum(APPROVAL_TILES).optional(),
    status: z.enum([...APPROVAL_TASK_STATUSES, 'ALL']).optional(),
    kind: z.enum(APPROVAL_TASK_KINDS).optional(),
    recordType: z.string().max(80).optional(),
    recordId: id().optional(),
    companyId: id().optional(),
    q: z.string().max(100).optional(),
    cursor: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      asOf: instant(),
      tiles: z.array(output({ tile: z.enum(APPROVAL_TILES), count: z.number().int() })),
      /** The one most serious fact (design "notice"): requests on this page that changed since they were asked. */
      notice: output({ changedSinceAsked: z.number().int() }),
      rows: z.array(taskRow),
      nextCursor: z.string().nullable(),
    }),
  },
})

const historyLineView = output({
  id: z.string(),
  /** Where it comes from: the approval engine (ApprovalEvent), or a domain approval's own table. */
  source: z.string(),
  action: z.enum(APPROVAL_EVENT_ACTIONS),
  at: instant(),
  by: output({ kind: z.enum(['PERSON', 'WORKER', 'SYSTEM']), id: id().nullable(), name: z.string(), me: z.boolean() }),
  words: z.string().nullable(),
  reasonCode: z.string().nullable(),
  meaning: z.enum(APPROVAL_MEANINGS).nullable(),
  taskId: id().nullable(),
})

export const taskDetail = taskRow.extend({
  changes: z.array(changeView),
  fingerprint: z.string(),
  /** The re-check line (design review "Still current · checked 10:42" / "Changed since asked: …"). */
  recheckLine: output({ checkedAt: instant(), words: z.string(), changed: z.array(output({ field: z.string(), label: words.nullable(), was: z.unknown(), now: z.unknown(), grain })) }).nullable(),
  /** Every rule that held when it was asked (the first named the approver). */
  rules: z.array(output({ id: id(), name: z.string(), sentence: words })),
  /** Who may decide it (never the person who asked), by name; at most 50. */
  deciders: z.array(output({ id: id(), name: z.string() })),
  decided: output({
    by: person,
    at: instant(),
    comment: z.string().nullable(),
    reasonCode: z.string().nullable(),
    reasonLabel: words.nullable(),
    reason: z.string().nullable(),
    stepUpAt: instant().nullable(),
  }).nullable(),
  withdrawn: output({ at: instant(), by: person.nullable() }).nullable(),
  staleAt: instant().nullable(),
  history: z.array(historyLineView),
  reject: decision,
  withdraw: decision,
})

const taskParams = input({ id: id() })
export const getTaskContract = defineContract({ params: taskParams, response: { 200: output({ task: taskDetail }) } })

export const approveContract = defineContract({
  params: taskParams,
  body: input({ version, comment: z.string().trim().min(1).max(APPROVAL_LIMITS.comment).nullable().default(null) }),
  response: { 200: output({ task: taskDetail }) },
})

export const rejectContract = defineContract({
  params: taskParams,
  body: input({ version, reasonCode: z.string().min(1).max(40), reason: z.string().trim().min(1).max(APPROVAL_LIMITS.rejectReason) }),
  response: { 200: output({ task: taskDetail }) },
})

export const withdrawContract = defineContract({
  params: taskParams,
  body: input({ version, note: z.string().trim().min(1).max(APPROVAL_LIMITS.note).nullable().default(null) }),
  response: { 200: output({ task: taskDetail }) },
})

/** "One command asks for a yes" from the generic route: no rule holds → `asked` false, nothing written (as today). */
export const askContract = defineContract({
  body: input({ kind: z.enum(APPROVAL_TASK_KINDS), recordId: id(), note: z.string().trim().min(1).max(APPROVAL_LIMITS.note).nullable().default(null) }),
  response: { 200: output({ asked: z.literal(false), why: z.string() }), 201: output({ asked: z.literal(true), task: taskDetail }) },
})

export const historyContract = defineContract({
  params: input({ recordType: z.string().min(1).max(80), recordId: id() }),
  querystring: input({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ record: output({ type: z.string(), id: id() }), lines: z.array(historyLineView), nextCursor: z.string().nullable() }) },
})
