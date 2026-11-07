import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Tasks and notifications for partners (B-W2b-167; COL-043, PLT-148, COL-063; design portal.frame action-needed, the bell,
 * E-mail settings; portal.customer.home and portal.supplier.home). Two sets:
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles; every main role of every kind holds it):
 *   home.view       see Home: what waits for you (the one task list), your notifications (the bell), the rail's badges and
 *                   the counts at a glance, and the live channel of your session. Which tasks a person sees is the API's:
 *                   a task kind needs what its verb needs (approving `portal.approve`, sending a file `portal.upload`,
 *                   answering `portal.comment`, paying or accepting a price the price grain).
 *
 * The OFFICE's (area `partners`, checked with can() against the record the request is on):
 *   tasks.manage    ask a customer, supplier or workshop for something on a record (a document, an answer, measurements,
 *                   progress) by a date; move the date, cancel or reopen a request. Seeing a party's requests is
 *                   partners.view (B-W2b-162).
 */
export const PORTAL_HOME_DEFINITIONS = definePartnerPermissions('portal', {
  'home.view': { risk: 'read', description: 'See your Home: what waits for you, your notifications and the counts of your organisation, as they change.' },
})

export const PARTNER_TASKS_DEFINITIONS = definePermissions('partners', {
  'tasks.manage': { risk: 'write', description: 'Ask a customer, supplier or workshop for something on a record (a document, an answer, measurements, progress) by a date; move the date, cancel or reopen the request.' },
})

export const PORTAL_HOME_VIEW = 'portal.home.view' satisfies Permission
export const PARTNERS_TASKS_MANAGE = 'partners.tasks.manage' satisfies Permission
export const PORTAL_HOME_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_HOME_VIEW])
export const PARTNER_TASKS_PERMISSIONS: readonly Permission[] = Object.freeze([PARTNERS_TASKS_MANAGE])
