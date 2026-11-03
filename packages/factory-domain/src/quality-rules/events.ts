import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ALERT_AUDIENCES, ALERT_RULE_CHANGES, QUALITY_ALERT_EVENTS } from '../quality/rules/alerts'
import { DUTIES_FIELDS, LOOSENINGS } from '../quality/rules/duties'
import { RESULTS_FIELDS } from '../quality/rules/results'

/**
 * Quality rules (B-W2b-118; QHS-154, QHS-300; design quality.settings "live: settings.changed → 'Changed … · 10:42' under
 * each card"). apps/factory-api's modules/quality/rules emits them in the commands that make the change. Its own module
 * folder (as quality-capa, quality-plans): the quality events file is other steps'.
 *
 *   quality.rules_changed        who may sign what (the four-eyes release, its conditions and customers, the hold release)
 *                                or the result rules changed, for a company or every company: which fields, what it loosened
 *   quality.alert_rule_changed   an alert and escalation rule was added, changed, removed, or the starter rules were added
 *   quality.alert_fired          a rule fired for a record (or was tested by a person): the bell's fan-out tells its audience
 *
 * Reach the Quality rules page of the office (quality.rules.view): ids, codes and counts only; never a person's name.
 */

const scope = z.uuid().nullable()

export const events = [
  defineEvent({
    type: 'quality.rules_changed',
    context: 'quality-rules',
    description: 'Who may sign what (four-eyes release, its conditions and customers, the hold release) or how results are counted changed, for a company or every company.',
    payload: z.strictObject({
      companyId: scope,
      card: z.enum(['DUTIES', 'RESULTS']),
      fields: z.array(z.enum([...DUTIES_FIELDS, ...RESULTS_FIELDS])).min(1),
      loosened: z.array(z.enum(LOOSENINGS)),
    }),
    live: { permission: 'quality.rules.view', fields: ['companyId', 'card', 'fields'] },
  }),
  defineEvent({
    type: 'quality.alert_rule_changed',
    context: 'quality-rules',
    description: 'A quality alert and escalation rule was added, changed or removed, or the starter rules were added.',
    payload: z.strictObject({
      ruleIds: z.array(z.uuid()).min(1).max(50),
      companyId: scope,
      events: z.array(z.enum(QUALITY_ALERT_EVENTS)).min(1),
      change: z.enum(ALERT_RULE_CHANGES),
    }),
    live: { permission: 'quality.rules.view', fields: ['ruleIds', 'companyId', 'change'] },
  }),
  defineEvent({
    type: 'quality.alert_fired',
    context: 'quality-rules',
    description: "A quality alert rule fired for a record (once per rule, record and step), or a person tested it: the bell's fan-out tells the rule's audience (a test: that person only).",
    payload: z.strictObject({
      ruleId: z.uuid(),
      event: z.enum(QUALITY_ALERT_EVENTS),
      audience: z.enum(ALERT_AUDIENCES),
      recordType: z.string().min(1).max(40),
      recordId: z.uuid(),
      label: z.string().min(1).max(80),
      companyId: scope,
      siteId: scope,
      /** A wait's 0, or a date rule's days before. */
      step: z.number().int().min(0),
      /** A date rule: the date it counts to. */
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      /** A test sends to this person only. */
      testFor: z.uuid().nullable(),
    }),
    live: { permission: 'quality.rules.view', fields: ['ruleId', 'event'] },
  }),
]
