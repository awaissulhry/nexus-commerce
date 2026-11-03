import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FOUR_EYES_RULES } from '@nexus/factory-domain/quality/release/rules'
import { ALERT_AUDIENCES, ALERT_CHANNELS, ALERT_LIMITS, QUALITY_ALERT_EVENTS } from '@nexus/factory-domain/quality/rules/alerts'
import { FOUR_EYES_CONDITIONS, LOOSENINGS, SEPARATION_IDS } from '@nexus/factory-domain/quality/rules/duties'
import { RESULTS_FIELDS } from '@nexus/factory-domain/quality/rules/results'

/**
 * Quality rules (B-W2b-118; QHS-154, QHS-300; design quality.settings SCR-260): the page's read, the two cards' saves
 * (who may sign what; the result rules) and the alert and escalation rules. Office routes; every write takes an
 * Idempotency-Key and the version read (a settings row never saved: 0). Refusals in words at `body/<field>` (400); a stale
 * version 409; a looser rule without the reason 400 `body/reason`, without a fresh code 403 `stepUp`.
 */

const source = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])
const condition = z.enum(FOUR_EYES_CONDITIONS)
const rule4 = z.enum(FOUR_EYES_RULES)
const event = z.enum(QUALITY_ALERT_EVENTS)
const audience = z.enum(ALERT_AUDIENCES)
const channel = z.enum(ALERT_CHANNELS)
const place = output({ id: id(), code: z.string(), name: z.string() })

export const rulesView = output({
  /** null: the rules of every company (the tenant-wide row). */
  companyId: id().nullable(),
  company: place.nullable(),
  /** The scope's own row: its version (0: never saved) and when it last changed. */
  version: z.number().int().min(0),
  updatedAt: instant().nullable(),
  /** quality.settings.manage over the scope (every company: a grant over every company). */
  mayChange: z.boolean(),
  duties: output({
    own: output({ releaseFourEyes: rule4.nullable(), fourEyesConditions: z.array(condition), secondPersonPartyIds: z.array(id()), placerMayRelease: z.boolean().nullable() }).nullable(),
    inForce: output({
      releaseFourEyes: output({ rule: rule4, source }),
      conditions: z.array(condition),
      /** The conditions the rule of every company asks (a company cannot drop them on its own). */
      conditionsFromTenant: z.array(condition),
      placerMayRelease: output({ value: z.boolean(), source }),
    }),
    /** The customers whose garments always need a second person (the scope's own list, then every company's). */
    customers: z.array(output({ id: id(), code: z.string(), name: z.string(), listedOn: z.enum(['COMPANY', 'TENANT']) })),
  }),
  results: output({
    own: output({ stopAtRejectNumber: z.boolean().nullable(), benchUndoSeconds: z.number().int().nullable() }).nullable(),
    inForce: output({ stopAtRejectNumber: output({ value: z.boolean(), source }), benchUndoSeconds: output({ value: z.number().int(), source }) }),
    limits: output({ benchUndoMin: z.number().int(), benchUndoMax: z.number().int() }),
  }),
  /** Who floor records name at each site (Production › Settings, Q16): the maker check reads scans, or a signed statement. */
  monitoring: z.array(output({ siteId: id(), code: z.string(), name: z.string(), scanSubject: z.enum(['WORKER', 'STATION']) })),
  /** The separations every role keeps: kept by every system role; the tenant's custom roles that break one, named. */
  separations: z.array(output({ id: z.enum(SEPARATION_IDS), kept: z.boolean(), roles: z.array(output({ id: id(), key: z.string(), name: z.string(), permissions: z.array(z.string()) })) })),
})
export type RulesView = z.infer<typeof rulesView>

export const rulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: rulesView },
})

export const saveDutiesContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    version: z.number().int().min(0),
    /** null: follow the rule of every company (a company) or the default (every company). */
    releaseFourEyes: rule4.nullable(),
    fourEyesConditions: z.array(condition).max(2),
    secondPersonPartyIds: z.array(id()).max(200),
    placerMayRelease: z.boolean().nullable(),
    /** A looser rule (LOOSENINGS) asks why, and a fresh code. */
    reason: z.string().max(1000).nullable().optional(),
  }),
  response: { 200: output({ rules: rulesView, loosened: z.array(z.enum(LOOSENINGS)) }) },
})

export const saveResultsContract = defineContract({
  body: input({
    companyId: id().nullable().optional(),
    version: z.number().int().min(0),
    stopAtRejectNumber: z.boolean().nullable(),
    benchUndoSeconds: z.number().int().nullable(),
  }),
  response: { 200: output({ rules: rulesView, changed: z.array(z.enum(RESULTS_FIELDS)) }) },
})

// ---- alert and escalation rules ------------------------------------------------------------------------------------------

export const alertRuleView = output({
  id: id(),
  companyId: id().nullable(),
  company: place.nullable(),
  event,
  audience,
  roleId: id().nullable(),
  role: output({ id: id(), key: z.string(), name: z.string() }).nullable(),
  withinMinutes: z.number().int(),
  daysBefore: z.array(z.number().int()),
  channels: z.array(channel),
  enabled: z.boolean(),
  /** For the company asked: false when that company keeps its own rules of the event (this one of every company does not apply there). */
  inForce: z.boolean(),
  /** The rule as one sentence (factory-domain alertRuleSentence). */
  sentence: output({ it: z.string(), en: z.string() }),
  lastFiredAt: instant().nullable(),
  /** Firings in the last 7 days (tests left out). */
  fired7d: z.number().int().min(0),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type AlertRuleView = z.infer<typeof alertRuleView>

export const alertRulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      companyId: id().nullable(),
      rules: z.array(alertRuleView),
      events: z.array(output({ event, timing: z.enum(['EVENT', 'WAIT', 'DAYS', 'ESCALATION']), ownerNamed: z.boolean() })),
      /** The office roles a rule may tell. */
      roles: z.array(output({ id: id(), key: z.string(), name: z.string() })),
      /** Where the caller may keep rules: every company (a grant over every company), and these companies. */
      places: output({ everywhere: z.boolean(), companies: z.array(place) }),
      /** The design's rules for every company that are missing (factory-domain STARTER_ALERT_RULES). */
      starterMissing: z.array(event),
      mayManage: z.boolean(),
    }),
  },
})

const ruleBody = {
  audience,
  roleId: id().nullable(),
  withinMinutes: z.number().int().min(0).max(ALERT_LIMITS.withinMinutesMax),
  daysBefore: z.array(z.number().int()).max(ALERT_LIMITS.daysBeforeCount),
  channels: z.array(channel).min(1).max(2),
}

export const createAlertRuleContract = defineContract({
  body: input({ companyId: id().nullable(), event, ...ruleBody, enabled: z.boolean().optional() }),
  response: { 201: output({ rule: alertRuleView }) },
})

export const editAlertRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({
    version: z.number().int().min(1),
    audience: audience.optional(),
    roleId: id().nullable().optional(),
    withinMinutes: ruleBody.withinMinutes.optional(),
    daysBefore: ruleBody.daysBefore.optional(),
    channels: ruleBody.channels.optional(),
    enabled: z.boolean().optional(),
  }),
  response: { 200: output({ rule: alertRuleView }) },
})

export const deleteAlertRuleContract = defineContract({
  params: input({ ruleId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: id(), event }) },
})

export const starterAlertRulesContract = defineContract({
  body: input({}),
  response: { 200: output({ added: z.array(event), ruleIds: z.array(id()) }) },
})

export const testAlertRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({}),
  response: { 200: output({ sent: z.boolean(), sentence: output({ it: z.string(), en: z.string() }) }) },
})
