import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { CHECKED_LIMITS, LIMIT_STATES } from '@nexus/factory-domain/people/limits/checks'
import { RULE_ACTIONS, RULE_KINDS, RULE_LIMITS, RULE_SOURCES } from '@nexus/factory-domain/people/limits/rules'

/**
 * Working-time limits (B-W2b-42; MES-232; design people.settings "Working-time limits"). Office only; no money. A limit
 * carries no person. What it says about ONE person stays inside one record (Owner answer W1): the warnings list shows a
 * tone per limit, never a name or a figure.
 */

const version = z.number().int().min(1)

const ruleOut = output({
  id: id(),
  companyId: id().nullable(),
  siteId: id().nullable(),
  kind: z.enum(RULE_KINDS),
  limitMinutes: z.number().int(),
  breakMinutes: z.number().int().nullable(),
  referenceMonths: z.number().int().nullable(),
  action: z.enum(RULE_ACTIONS),
  /** Role keys told when someone comes close (besides the exception rule's own recipient). */
  alertRoles: z.array(z.string()),
  source: z.enum(RULE_SOURCES),
  legalReference: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
})

export const listLimitsContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({
      companyId: id().nullable(),
      siteId: id().nullable(),
      limits: z.array(
        output({
          kind: z.enum(RULE_KINDS),
          /** The most specific limit in force here; null: none on record, the law's value warns. */
          inForce: ruleOut.nullable(),
          /** The row of this very scope (what a save changes; version null makes one). */
          own: ruleOut.nullable(),
          law: output({ limitMinutes: z.number().int(), breakMinutes: z.number().int().nullable(), referenceMonths: z.number().int().nullable(), legalReference: z.string(), words: z.string() }),
        }),
      ),
      /** The office roles a limit may alert. */
      roles: z.array(output({ key: z.string(), name: z.string() })),
      canManage: z.boolean(),
    }),
  },
})

export const saveLimitContract = defineContract({
  body: input({
    /** null with no site: the whole group's limit. */
    companyId: id().nullable(),
    siteId: id().nullable().optional(),
    kind: z.enum(RULE_KINDS),
    /** The version read; null: no row at this scope yet. */
    version: version.nullable(),
    limitMinutes: z.number().int().min(1).max(100000),
    breakMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    referenceMonths: z.number().int().min(1).max(RULE_LIMITS.referenceMonthsMax).nullable().optional(),
    action: z.enum(RULE_ACTIONS),
    alertRoles: z.array(z.string().max(60)).max(RULE_LIMITS.alertRoles),
    source: z.enum(RULE_SOURCES),
    legalReference: z.string().min(1).max(RULE_LIMITS.legalReferenceMax),
  }),
  response: { 200: ruleOut },
})

export const archiveLimitContract = defineContract({ params: input({ ruleId: id() }), body: input({ version }), response: { 200: ruleOut } })

export const checkOut = output({
  rule: z.enum(CHECKED_LIMITS),
  state: z.enum(LIMIT_STATES),
  level: z.enum(RULE_ACTIONS),
  date: businessDate(),
  law: z.string(),
  words: z.string(),
  values: z.record(z.string(), z.union([z.number(), z.string()])),
})

export const warningsContract = defineContract({
  querystring: input({
    siteId: id(),
    teamId: id().optional(),
    lineId: id().optional(),
    rule: z.enum(CHECKED_LIMITS).optional(),
    /** Refused when it names a person (a list never filters by person, Owner answer W1). */
    employeeId: z.string().max(64).optional(),
  }),
  response: {
    200: output({
      siteId: id(),
      today: businessDate(),
      /** dayId: the person's latest attendance day, what the row opens (their name is inside it). */
      rows: z.array(output({ dayId: id().nullable(), teamId: id().nullable(), lineId: id().nullable(), checks: z.array(output({ rule: z.enum(CHECKED_LIMITS), state: z.enum(LIMIT_STATES), level: z.enum(RULE_ACTIONS) })) })),
      words: z.array(z.string()),
    }),
  },
})

export const personLimitsContract = defineContract({
  params: input({ employeeId: id() }),
  response: {
    200: output({
      person: output({ employeeId: id(), name: z.string(), displayName: z.string(), siteId: id() }),
      today: businessDate(),
      overtime: output({ year: z.string(), approvedMinutes: z.number().int(), pendingMinutes: z.number().int(), limitMinutes: z.number().int() }),
      checks: z.array(checkOut),
    }),
  },
})

export type ListLimitsQuery = z.infer<typeof listLimitsContract.querystring>
export type SaveLimitBody = z.infer<typeof saveLimitContract.body>
export type WarningsQuery = z.infer<typeof warningsContract.querystring>
