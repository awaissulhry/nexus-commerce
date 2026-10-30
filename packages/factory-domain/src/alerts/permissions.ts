import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Exception rules and stored alerts (apps/factory-api platform/alerts; B-W2a-33; ANA-036, PLT-100; design home.alerts with
 * its popups alert and rule, admin.automation "Reminders & timers"). Office only. Every alert is also behind its record's
 * own view permission (an order's alert needs orders.view over the order's company and customer, a hold's
 * quality.holds.view over its site: alerts/kinds), so these never widen what a person sees.
 *
 *   view           see the alerts of the records one may see, their history, and the rules (what they watch, their
 *                  numbers, whom they tell, how often)
 *   handle         acknowledge, assign, snooze and resolve (with a note) those alerts
 *   rules.manage   change a rule's numbers, place, recipients, channels and cooldown, switch it on or off, add a rule
 */
export const ALERTS_DEFINITIONS = definePermissions('alerts', {
  view: {
    risk: 'read',
    description: 'See the alerts of the records you can see (why each fired, its history, who handles it) and the exception rules: what they watch, their numbers, whom they tell and how often.',
  },
  handle: {
    risk: 'write',
    description: 'Acknowledge, assign to a colleague, snooze and resolve (with a note saying what was done) the alerts of the records you can see.',
  },
  'rules.manage': {
    risk: 'write',
    description: "Change an exception rule's numbers, place, who it tells, how and how often, switch it on or off, and add a rule (for a company or a site).",
  },
})

export const ALERTS_VIEW = 'alerts.view' satisfies Permission
export const ALERTS_HANDLE = 'alerts.handle' satisfies Permission
export const ALERTS_RULES_MANAGE = 'alerts.rules.manage' satisfies Permission

export const ALERTS_PERMISSIONS: readonly Permission[] = Object.freeze([ALERTS_VIEW, ALERTS_HANDLE, ALERTS_RULES_MANAGE])
