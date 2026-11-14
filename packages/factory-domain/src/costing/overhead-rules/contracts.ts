import { z } from 'zod'
import { businessDate, currency, id, input, instant, output, quantity, unitPrice } from '../../core/contracts'
import { money } from '../../money/marked'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { ABSORPTION_MISSING, OVERHEAD_BASES, OVERHEAD_RULE_STATUSES } from './rules'

/**
 * The contracts of the overhead absorption rules (B-W2b-419; FIN-007; design finance.settings › Costing): what
 * apps/factory-api's modules/costing/overhead-rules answers and the web's typed client reads. A rule's value — a percent
 * of labour or an amount per minute, garment or machine hour — is `money.cost`, as are the absorbed amounts. Every rule is
 * UNVERIFIED until the accountant confirms the bases and rates (GATE-ACCOUNTANT): the answers say so in words.
 */

const kind = () => z.enum(WORK_CENTRE_KINDS)
const note = () => z.string().trim().min(1).max(1000)

export const overheadRuleView = output({
  id: id(),
  /** null: every company of the tenant. */
  companyId: id().nullable(),
  key: z.string(),
  basis: z.enum(OVERHEAD_BASES),
  /** null: every kind of work centre. */
  workCentreKind: kind().nullable(),
  /** PERCENT_OF_LABOUR: the percent; the other bases: the amount in `currency`. */
  value: money.cost(z.string()),
  currency: z.string().nullable(),
  periodStart: businessDate(),
  /** null: until a later rule. */
  periodEnd: businessDate().nullable(),
  status: z.enum(OVERHEAD_RULE_STATUSES),
  note: z.string().nullable(),
  /** ACTIVE and its period holds today (Europe/Rome). */
  inForce: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type OverheadRuleView = z.infer<typeof overheadRuleView>

export const overheadRulesQuery = input({
  /** A company's own rules and every company's; left out: every rule the caller sees. */
  companyId: id().optional(),
  basis: z.enum(OVERHEAD_BASES).optional(),
  workCentreKind: kind().optional(),
  status: z.enum([...OVERHEAD_RULE_STATUSES, 'ALL']).default('ACTIVE'),
  /** ACTIVE and in force on this day. */
  on: businessDate().optional(),
})
export type OverheadRulesQuery = z.output<typeof overheadRulesQuery>

export const overheadRulesAnswer = output({ rules: z.array(overheadRuleView), unverified: z.string() })

export const createOverheadRuleBody = input({
  /** Left out or null: every company (a role over every company). */
  companyId: id().nullish(),
  basis: z.enum(OVERHEAD_BASES),
  /** Left out or null: every kind of work centre. */
  workCentreKind: kind().nullish(),
  value: money.cost(unitPrice()),
  /** Exactly for the amount bases; none for a percent of labour. */
  currency: currency().nullish(),
  /** The first day of a month. */
  periodStart: businessDate(),
  /** The last day of a month; left out or null: open-ended. */
  periodEnd: businessDate().nullish(),
  note: note().nullish(),
  /** End the active rule of the same key that starts earlier and runs into this period, on the day before this one starts. */
  endPrevious: z.boolean().optional(),
})
export type CreateOverheadRuleBody = z.output<typeof createOverheadRuleBody>

/** A correction of an ACTIVE rule: only the fields sent change (company, basis, kind and first day never do; a new figure from a later month is a new rule). */
export const updateOverheadRuleBody = input({
  version: z.number().int().min(1),
  value: money.cost(unitPrice()).optional(),
  currency: currency().nullable().optional(),
  /** The last day of a month (ends the rule), or null (open-ended again). */
  periodEnd: businessDate().nullable().optional(),
  note: note().nullable().optional(),
})
export type UpdateOverheadRuleBody = z.output<typeof updateOverheadRuleBody>

export const archiveOverheadRuleBody = input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500).optional() })
export type ArchiveOverheadRuleBody = z.output<typeof archiveOverheadRuleBody>

/** The answer of a write: the rule, and the earlier one it ended (endPrevious). */
export const overheadRuleAnswer = output({ rule: overheadRuleView, ended: overheadRuleView.nullable(), unverified: z.string() })

/**
 * The rules in force for a company's work of one kind on a day (one per basis, the most specific), and, with the figures
 * given, the overhead they absorb (as cost sheet lines take it).
 */
export const inForceQuery = input({
  companyId: id(),
  /** Left out: the rules for every kind only (a garment's own overhead). */
  workCentreKind: kind().optional(),
  /** Default: today (Europe/Rome). */
  on: businessDate().optional(),
  labourCost: money.cost(unitPrice()).optional(),
  minutes: quantity().optional(),
  units: quantity().optional(),
  machineHours: quantity().optional(),
})
export type InForceQuery = z.infer<typeof inForceQuery>

export const absorptionLineView = output({
  ruleId: id(),
  basis: z.enum(OVERHEAD_BASES),
  workCentreKind: kind().nullable(),
  quantity: z.string().nullable(),
  unitCost: money.cost(z.string().nullable()),
  pct: money.cost(z.string().nullable()),
  amount: money.cost(z.string().nullable()),
  missing: z.enum(ABSORPTION_MISSING).nullable(),
  /** What is missing, in words. */
  missingWords: z.string().nullable(),
})

export const inForceView = output({
  companyId: id(),
  workCentreKind: kind().nullable(),
  on: businessDate(),
  /** The company's currency (what the amounts are in). */
  currency: z.string(),
  rules: z.array(overheadRuleView),
  lines: z.array(absorptionLineView),
  /** Σ amounts; null while a line misses a figure. */
  total: money.cost(z.string().nullable()),
  /** No rule in force: the costing settings' overhead percent the cost sheet keeps (its settings row; null: none set). */
  fallback: output({ settingsId: id(), overheadPct: z.string() }).nullable(),
  words: z.string(),
  unverified: z.string(),
})
export type InForceView = z.infer<typeof inForceView>
