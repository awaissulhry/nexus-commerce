import { z } from 'zod'
import { ALERT_CHANNELS, ALERT_SEVERITIES, RULE_KINDS, RULE_TRIGGERS } from '@nexus/factory-domain/alerts/kinds'
import { ALERT_RESOLUTIONS, ALERT_STATES, ALERT_TILES, ALERT_VERBS, BULK_MAX, NOTE_MAX } from '@nexus/factory-domain/alerts/rules'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { TIMER_STATUSES } from '@nexus/factory-domain/timers/rules'

/**
 * The stored alerts' and exception rules' contracts (B-W2a-33; ANA-036, PLT-100; design home.alerts "Alerts" tiles,
 * "Open alerts", "Rules", popups alert and rule; admin.automation "Reminders & timers"). People come as {id, name, me};
 * dates of the facts are business days (YYYY-MM-DD). No amount anywhere (an alert's facts carry none), and no figure
 * about a person: "for me" is the reader's own, "unassigned" names nobody.
 */

const person = output({ id: id(), name: z.string(), me: z.boolean() })
const version = z.number().int().min(1)
const phrase = output({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) })

export const alertView = output({
  id: id(),
  ruleId: id(),
  ruleKind: z.string(),
  ruleName: z.string(),
  /** What the kind watches, in words. */
  kindLabel: z.string(),
  severity: z.enum(ALERT_SEVERITIES),
  state: z.enum(ALERT_STATES),
  /** The record it is about, with its label when it fired (the record opens in a new tab: ⌘-click). */
  record: output({ type: z.string(), id: id(), label: z.string() }),
  companyId: id().nullable(),
  siteId: id().nullable(),
  partyId: id().nullable(),
  /** What and why, in English; `words` for the reader's language. */
  sentence: z.string(),
  words: phrase,
  /** The values it fired on (the rule's numbers, what was found). */
  facts: z.record(z.string(), z.unknown()),
  raisedAt: instant(),
  /** The how-manyth alert of its key (1: the first time). */
  occurrence: z.number().int(),
  ageDays: z.number().int(),
  acknowledged: output({ by: person, at: instant() }).nullable(),
  assigned: output({ to: person, by: person, at: instant() }).nullable(),
  /** Snoozed: until when (`now` false: the time passed, it is back). */
  snoozed: output({ until: instant(), by: person, at: instant(), now: z.boolean() }).nullable(),
  resolved: output({ at: instant(), resolution: z.enum(ALERT_RESOLUTIONS), by: person.nullable(), note: z.string().nullable() }).nullable(),
  /** Open for the reader: assigned to them, or nobody's and its rule tells them. */
  forMe: z.boolean(),
  /** What the reader may do now. */
  verbs: z.array(z.enum(ALERT_VERBS)),
  version: z.number().int(),
})

const alertParams = input({ id: id() })
const one = output({ alert: alertView })

const scopeQuery = { companyId: id().optional(), siteId: id().optional() }

export const listAlertsContract = defineContract({
  querystring: input({
    /** A tile pressed: Open for me · Critical · Unassigned · Acknowledged · Resolved today. */
    tile: z.enum(ALERT_TILES).optional(),
    /** Default UNRESOLVED (open and acknowledged). */
    state: z.enum([...ALERT_STATES, 'UNRESOLVED', 'ALL']).optional(),
    severity: z.enum(ALERT_SEVERITIES).optional(),
    ruleKind: z.enum(RULE_KINDS).optional(),
    ruleId: id().optional(),
    /** One record's alerts (a record page's "alerts" chip). */
    recordType: z.string().max(60).optional(),
    recordId: id().optional(),
    /** Also the alerts snoozed now (default: off the list until their time). */
    snoozed: z.enum(['true', 'false']).optional(),
    q: z.string().max(100).optional(),
    ...scopeQuery,
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      asOf: instant(),
      /** The tiles under the company and site filters (never the tile or other filters): each count is its rows. */
      tiles: z.array(output({ tile: z.enum(ALERT_TILES), count: z.number().int(), complete: z.boolean() })),
      total: notMoney(z.number().int()),
      /** False: more than 1000 alerts match; the first 1000 in rank order were read. */
      complete: z.boolean(),
      items: z.array(alertView),
      nextCursor: z.string().nullable(),
      live: output({ events: z.array(z.string()) }),
    }),
  },
})

export const alertCountsContract = defineContract({
  querystring: input(scopeQuery),
  response: { 200: output({ asOf: instant(), tiles: z.array(output({ tile: z.enum(ALERT_TILES), count: z.number().int(), complete: z.boolean() })) }) },
})

const historyEntry = output({
  verb: z.enum(['RAISED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNASSIGNED', 'SNOOZED', 'RESOLVED']),
  at: instant(),
  /** Who did it; null: the system. */
  actor: person.nullable(),
  assignee: person.nullable(),
  snoozedUntil: instant().nullable(),
  note: z.string().nullable(),
  facts: z.record(z.string(), z.unknown()).nullable(),
})

export const getAlertContract = defineContract({
  params: alertParams,
  response: {
    200: output({
      alert: alertView,
      rule: output({ id: id(), name: z.string(), sentence: z.string(), enabled: z.boolean(), threshold: z.record(z.string(), z.union([z.number(), z.boolean()])) }),
      history: z.array(historyEntry),
      /** Open alerts of the same kind on other records (at most 5). */
      similar: z.array(output({ id: id(), record: output({ type: z.string(), id: id(), label: z.string() }), severity: z.enum(ALERT_SEVERITIES), state: z.enum(ALERT_STATES), raisedAt: instant() })),
    }),
  },
})

export const acknowledgeContract = defineContract({ params: alertParams, body: input({ version }), response: { 200: one } })
export const assignContract = defineContract({ params: alertParams, body: input({ version, /** null: take it back. */ assigneeId: id().nullable() }), response: { 200: one } })
export const snoozeContract = defineContract({ params: alertParams, body: input({ version, /** Off the lists and Today until then (at most 30 days). */ until: instant() }), response: { 200: one } })
export const resolveContract = defineContract({ params: alertParams, body: input({ version, /** What was done (required). */ note: z.string().max(NOTE_MAX * 2) }), response: { 200: one } })
export const bulkAcknowledgeContract = defineContract({
  body: input({ items: z.array(input({ id: id(), version })).min(1).max(BULK_MAX) }),
  response: { 200: output({ alerts: z.array(alertView) }) },
})

// ---- rules -----------------------------------------------------------------------------------------------------------------

const thresholdValue = z.record(z.string(), z.union([z.number(), z.boolean()]))

export const ruleView = output({
  id: id(),
  ruleKind: z.enum(RULE_KINDS),
  trigger: z.enum(RULE_TRIGGERS),
  kindLabel: z.string(),
  name: z.string(),
  /** The rule as one sentence (RuleSentence), in English and Italian. */
  sentence: output({ en: z.string(), it: z.string() }),
  threshold: thresholdValue,
  severity: z.enum(ALERT_SEVERITIES),
  /** Where it looks: a company and a site of it; null: everywhere. */
  place: output({ companyId: id().nullable(), siteId: id().nullable(), label: z.string().nullable() }),
  /** Whom it tells: the holders of this office role at the record's place. */
  recipient: output({ roleId: id(), name: z.string() }).nullable(),
  channels: z.array(z.enum(ALERT_CHANNELS)),
  cooldownMinutes: z.number().int(),
  cooldownWords: z.string(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  lastFiredAt: instant().nullable(),
  /** Alerts it raised in the last 7 days (a count per rule; never per person). */
  fired7Days: z.number().int(),
  openAlerts: z.number().int(),
  /** DATE rules: the timers waiting, and when the next one fires. */
  timers: output({ pending: z.number().int(), nextFireAt: instant().nullable() }).nullable(),
  canChange: z.boolean(),
  version: z.number().int(),
})

const kindView = output({
  kind: z.enum(RULE_KINDS),
  trigger: z.enum(RULE_TRIGGERS),
  recordType: z.string(),
  label: output({ en: z.string(), it: z.string() }),
  /** The numbers a rule of the kind takes, with the built-in ones. */
  defaults: thresholdValue,
})

export const listRulesContract = defineContract({
  querystring: input({ trigger: z.enum(RULE_TRIGGERS).optional(), ruleKind: z.enum(RULE_KINDS).optional() }),
  response: { 200: output({ asOf: instant(), rules: z.array(ruleView), kinds: z.array(kindView), canAdd: z.boolean() }) },
})

const ruleParams = input({ id: id() })
const ruleFields = {
  name: z.string().min(1).max(120).optional(),
  threshold: thresholdValue.optional(),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  companyId: id().nullable().optional(),
  siteId: id().nullable().optional(),
  recipientRoleId: id().nullable().optional(),
  channels: z.array(z.enum(ALERT_CHANNELS)).min(1).max(2).optional(),
  cooldownMinutes: z.number().int().min(0).max(43_200).optional(),
  enabled: z.boolean().optional(),
}

export const getRuleContract = defineContract({ params: ruleParams, response: { 200: output({ rule: ruleView }) } })
export const createRuleContract = defineContract({ body: input({ ruleKind: z.enum(RULE_KINDS), ...ruleFields }), response: { 201: output({ rule: ruleView }) } })
export const updateRuleContract = defineContract({ params: ruleParams, body: input({ version, ...ruleFields }), response: { 200: output({ rule: ruleView }) } })

export const testRuleContract = defineContract({
  params: ruleParams,
  /** The numbers and place to try (default: the rule's own); nothing is saved. */
  body: input({ threshold: thresholdValue.optional(), companyId: id().nullable().optional(), siteId: id().nullable().optional() }),
  response: {
    200: output({
      /** Records it would find now with these numbers (a DATE rule: whose window is open now). */
      wouldFind: z.number().int(),
      complete: z.boolean(),
      sample: z.array(output({ record: output({ type: z.string(), id: id(), label: z.string() }), sentence: z.string() })),
      /** Alerts the rule raised in the last 7 days, as it is now. */
      fired7Days: z.number().int(),
    }),
  },
})

export const ruleTimersContract = defineContract({
  params: ruleParams,
  response: {
    200: output({
      timers: z.array(
        output({
          id: id(),
          timerKey: z.string(),
          record: output({ type: z.string(), id: id(), label: z.string().nullable() }),
          dueAt: instant(),
          fireAt: instant(),
          status: z.enum(TIMER_STATUSES),
          firedAt: instant().nullable(),
          cancelledAt: instant().nullable(),
          cancelReason: z.string().nullable(),
        }),
      ),
    }),
  },
})
