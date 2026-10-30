import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ALERT_SEVERITIES } from './kinds'
import { ALERT_RESOLUTIONS } from './rules'

/**
 * The stored alerts' events (B-W2a-33; ANA-036; design home.alerts live "alert.raised / alert.acknowledged /
 * alert.resolved → list and Today"). apps/factory-api platform/alerts emits them in the command that changes the alert
 * (the scheduler's evaluation, a timer's firing, a person's verb). Ids, the kind and the record only: no words, no money,
 * no person but the assignee's id for the notification centre. Each reaches the screens of the people who see alerts
 * (alerts.view) in the alert's company and site; a screen reads its list again (it shows only what its reader may see).
 *
 *   alert.raised         a rule raised an alert for a record (the notification centre tells the rule's recipients)
 *   alert.acknowledged   someone acknowledged it
 *   alert.assigned       it was given to a person (they are told), or taken back (assigneeId null)
 *   alert.snoozed        it is off the lists until a time
 *   alert.resolved       a person resolved it with a note (HANDLED), or the system did when the condition cleared
 *   alert.rule_changed   a rule was added, or its numbers, place, recipients, channels, cooldown or state changed
 */

const about = {
  alertId: z.uuid(),
  ruleKind: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  recordType: z.string(),
  recordId: z.uuid(),
}
const live = { permission: 'alerts.view', fields: ['alertId', 'ruleKind', 'recordType', 'recordId'] } as const

export const events = [
  defineEvent({
    type: 'alert.raised',
    context: 'alerts',
    description: 'An exception rule raised an alert for a record (the rule tells its recipients).',
    payload: z.strictObject({ ...about, ruleId: z.uuid(), severity: z.enum(ALERT_SEVERITIES), occurrence: z.number().int().min(1) }),
    live,
  }),
  defineEvent({
    type: 'alert.acknowledged',
    context: 'alerts',
    description: 'Someone acknowledged an alert.',
    payload: z.strictObject(about),
    live,
  }),
  defineEvent({
    type: 'alert.assigned',
    context: 'alerts',
    description: 'An alert was given to a person (who is told), or taken back.',
    payload: z.strictObject({ ...about, assigneeId: z.uuid().nullable(), assignedById: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'alert.snoozed',
    context: 'alerts',
    description: 'An alert is off the lists until a time.',
    payload: z.strictObject({ ...about, snoozedUntil: z.iso.datetime() }),
    live,
  }),
  defineEvent({
    type: 'alert.resolved',
    context: 'alerts',
    description: 'An alert was resolved: by a person with a note saying what was done, or by the system when its condition no longer held.',
    payload: z.strictObject({ ...about, resolution: z.enum(ALERT_RESOLUTIONS) }),
    live,
  }),
  defineEvent({
    type: 'alert.rule_changed',
    context: 'alerts',
    description: "An exception rule was added, or its numbers, place, recipients, channels, cooldown or state changed.",
    payload: z.strictObject({ ruleId: z.uuid(), ruleKind: z.string().regex(/^[A-Z][A-Z0-9_]*$/), enabled: z.boolean(), fields: z.array(z.string()).max(20) }),
    live: { permission: 'alerts.view', fields: ['ruleId', 'ruleKind', 'enabled', 'fields'] },
  }),
] as const
