import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Alert routes (B-W2b-435; ANA-041 "alert routing by place and role"; apps/factory-api platform/alerts/routes): who an exception
 * rule tells at one place — a company, a site, a line or a customer — and an office role (its holders there) or one office
 * person. A route is added and removed, never changed. Live to the people who see the rules (alerts.view): the rules list and the
 * rule dialog read again.
 *
 *   alert.route_added     a route of a rule was added
 *   alert.route_removed   a route of a rule was removed
 */

const route = { routeId: z.uuid(), ruleId: z.uuid(), scope: z.enum(['COMPANY', 'SITE', 'LINE', 'CUSTOMER']), scopeId: z.uuid() }
const live = { permission: 'alerts.view', fields: ['ruleId', 'scope'] } as const

export const events = [
  defineEvent({
    type: 'alert.route_added',
    context: 'alert-routes',
    description: "A route of an exception rule was added: the rule's alerts about that place go to that role's holders or that person.",
    payload: z.strictObject(route),
    live,
  }),
  defineEvent({
    type: 'alert.route_removed',
    context: 'alert-routes',
    description: 'A route of an exception rule was removed: its alerts about that place go back to the other routes, or the rule’s own role.',
    payload: z.strictObject(route),
    live,
  }),
] as const
