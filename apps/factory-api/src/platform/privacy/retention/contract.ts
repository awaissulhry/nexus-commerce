import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { RETENTION_ACTIONS, RULE_HELD, RULE_LIMITS, SWEEP_FAILURES, SWEEP_HELD, SWEEP_MODES, SWEEP_STATUSES, WAITING_LEDGERS } from '@nexus/factory-domain/privacy/retention/retention'

/**
 * Retention rules and their sweeps (B-W2b-405; PLT-204; design admin.privacy "Retention rules"). Lengths here only stop oversized
 * bodies; the domain answers the rules in words (privacy/retention/retention.ts). Every code comes with its words.
 */

const count = () => z.number().int().min(0)
const version = z.number().int().min(1)
const action = z.enum(RETENTION_ACTIONS)
const companyRef = output({ id: id(), code: z.string(), name: z.string() })
const personRef = output({ id: id(), name: z.string() })
const coded = <Codes extends readonly [string, ...string[]]>(codes: Codes) => output({ code: z.enum(codes), words: z.string() })
const may = output({ allowed: z.boolean(), held: coded(RULE_HELD).nullable() })

export const sweepView = output({
  id: id(),
  ruleId: id(),
  mode: z.enum(SWEEP_MODES),
  keepMonths: z.number().int(),
  thenAction: action,
  /** Records counted from before this day were due. */
  cutoffOn: businessDate(),
  status: z.enum(SWEEP_STATUSES),
  startedAt: instant(),
  finishedAt: instant().nullable(),
  due: count(),
  applied: count(),
  held: count(),
  failed: count(),
  /** Why the held records stayed (a REPORT sweep holds nothing: it says what an applying one would hold). */
  heldWhy: coded(SWEEP_HELD).nullable(),
  failures: z.array(output({ code: z.enum(SWEEP_FAILURES), words: z.string(), recordId: id().nullable() })),
  requestedBy: personRef.nullable(),
})

export const ruleView = output({
  id: id(),
  key: z.string(),
  /** null: the whole group (a company's own rule wins for its records). */
  company: companyRef.nullable(),
  recordType: z.string(),
  /** The sweep knows this record type (rules/index.ts); otherwise the rule only reports nothing. */
  known: z.boolean(),
  keepMonths: z.number().int(),
  period: z.string(),
  thenAction: action,
  legalReason: z.string(),
  active: z.boolean(),
  /** GATE-PRIVACY: switched on to apply (else the sweep only reports). */
  applyOn: z.boolean(),
  applyOnAt: instant().nullable(),
  applyOnBy: personRef.nullable(),
  /** A made-up period until the privacy paperwork is signed. */
  unverified: z.boolean(),
  unverifiedWords: z.string().nullable(),
  countsFrom: z.string().nullable(),
  /** What an applying sweep does with its action, in words. */
  does: z.string().nullable(),
  /** Every due record is held whatever is chosen (the database keeps it). */
  holdsAll: coded(SWEEP_HELD).nullable(),
  version: z.number().int(),
  lastSweep: sweepView.nullable(),
  actions: output({ change: may, switchOff: may, switchOn: may, applyOn: may, applyOff: may, sweepNow: may }),
})

const typeView = output({
  recordType: z.string(),
  companyScoped: z.boolean(),
  actions: z.array(action),
  countsFrom: z.string(),
  does: z.array(output({ action, words: z.string() })),
  holdsAll: coded(SWEEP_HELD).nullable(),
})

export const listRetentionContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      rules: z.array(ruleView),
      /** The record types a rule may name ("Add a rule"). */
      types: z.array(typeView),
      /** The append-only ledgers: kept, waiting for the Owner's decision (never swept). */
      ledgers: z.array(output({ recordType: z.enum(WAITING_LEDGERS), what: z.string(), words: z.string() })),
      /** The purges that run on their own dates (by their own jobs; not editable here). */
      datedPurges: z.array(output({ key: z.string(), job: z.string(), recordType: z.string(), what: z.string(), when: z.string(), why: z.string() })),
      /** Records the privacy pack keeps for good. */
      keptForGood: z.array(z.string()),
      /** The nightly sweep: when it runs, and that a rule only reports until switched on. */
      sweep: output({ schedule: z.string(), words: z.string() }),
    }),
  },
})

const ruleParams = input({ ruleId: id() })
const ruleAnswer = { 200: output({ rule: ruleView }) }

export const createRuleContract = defineContract({
  body: input({
    companyId: id().nullable(),
    recordType: z.string().min(1).max(100),
    keepMonths: z.number().int().min(RULE_LIMITS.minMonths).max(RULE_LIMITS.maxMonths),
    thenAction: action,
    legalReason: z.string().max(RULE_LIMITS.legalReason + 100),
  }),
  response: { 201: output({ rule: ruleView }) },
})

export const changeRuleContract = defineContract({
  params: ruleParams,
  body: input({
    version,
    keepMonths: z.number().int().min(RULE_LIMITS.minMonths).max(RULE_LIMITS.maxMonths).optional(),
    thenAction: action.optional(),
    legalReason: z.string().max(RULE_LIMITS.legalReason + 100).optional(),
  }),
  response: ruleAnswer,
})

export const ruleActiveContract = defineContract({ params: ruleParams, body: input({ version, active: z.boolean() }), response: ruleAnswer })
export const ruleApplyContract = defineContract({ params: ruleParams, body: input({ version, on: z.boolean() }), response: ruleAnswer })
export const sweepNowContract = defineContract({ params: ruleParams, response: { 201: output({ rule: ruleView, sweep: sweepView }) } })
export const listSweepsContract = defineContract({ params: ruleParams, response: { 200: output({ sweeps: z.array(sweepView) }) } })
