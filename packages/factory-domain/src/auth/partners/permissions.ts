import type { Permission } from '../../core/permissions'
import { definePermissions, type PermissionDefinition } from '../permissions/registry'

/**
 * Partner organisations, their people and their roles (B-W2b-162; PLT-006, PLT-021, PLT-022, SAL-060, SCM-092; design
 * sales.customers and purchasing.suppliers › Portal access, admin.users, portal.frame access-rules, portal.customer.account
 * and portal.supplier.profile › users). Two sets:
 *
 * The OFFICE's (area `partners`), checked with can() against the party (its company and itself; a tenant-wide party is
 * written only by a grant over every company):
 *   view      a party's Portal access: its portal switch, limits, people, roles, invitations; the partner organisations
 *   invite    invite a person of the party to its portal (with a role, what they may do, an end of access), send the
 *             invitation again, revoke it (step-up: it gives access to the factory's records)
 *   manage    change a person's role and end of access, suspend, reactivate and deactivate them; switch the party's portal
 *             on and off, its limits (people, roles) and the production progress it shows (Owner answer C1) (step-up)
 *   preview   open the party's portal as it is, read-only, every preview in the audit log
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role; the
 * role templates are ../roles/partner-templates.ts):
 *   colleagues.view     see the organisation's portal users and their roles ("Your admin is …")
 *   colleagues.manage   the partner's admin: invite colleagues within the factory's limits, change a role, deactivate
 *                       (step-up by an e-mail code on the portal session)
 *   comment, upload, approve
 *                       what ONE person may do on the records the role shows (COL-062 inside the portal): view only by
 *                       default; each is given to the person as its own small partner role (`partner-comment`, …) beside
 *                       the main one. A portal write checks its page's permission AND the matching one: posting a message
 *                       portal.comment, sending a file portal.upload, approving, accepting or signing portal.approve.
 */
export const PARTNERS_DEFINITIONS = definePermissions('partners', {
  view: { risk: 'read', description: "See a customer's or supplier's portal access: whether its portal is on, its limits, its people with their roles and end of access, open invitations; and the partner organisations." },
  invite: { risk: 'stepUp', description: "Invite a person of a customer, supplier, workshop or adviser to its portal with a role and an optional end of access; send the invitation again or revoke it." },
  manage: { risk: 'stepUp', description: "Change a portal person's role and end of access, suspend, reactivate or deactivate them; switch a partner's portal on or off, set how many people and which roles it may have, and whether a customer sees production progress." },
  preview: { risk: 'write', description: "Open a customer's or supplier's portal as it shows to them, read-only (every preview is in the audit log)." },
})

export const PARTNERS_VIEW = 'partners.view' satisfies Permission
export const PARTNERS_INVITE = 'partners.invite' satisfies Permission
export const PARTNERS_MANAGE = 'partners.manage' satisfies Permission
export const PARTNERS_PREVIEW = 'partners.preview' satisfies Permission
export const PARTNERS_PERMISSIONS: readonly Permission[] = Object.freeze([PARTNERS_VIEW, PARTNERS_INVITE, PARTNERS_MANAGE, PARTNERS_PREVIEW])

/**
 * Declares permissions only partner roles hold (`partner: true`): a portal step declares its own with this (area `portal`,
 * e.g. `definePartnerPermissions('portal', { 'orders.view': … })`), assembles them in the catalogue and gives them to the
 * partner templates (../roles/templates PARTNER_ADDS).
 */
export const definePartnerPermissions = (area: string, declarations: Parameters<typeof definePermissions>[1]): PermissionDefinition[] =>
  definePermissions(area, declarations).map((definition) => Object.freeze({ ...definition, partner: true as const }))

export const PORTAL_DEFINITIONS: PermissionDefinition[] = definePartnerPermissions('portal', {
  'colleagues.view': { risk: 'read', description: "See your organisation's portal users: names, roles, whether they see prices, their last sign-in and status." },
  'colleagues.manage': { risk: 'stepUp', description: "Your organisation's portal admin: invite colleagues within the limits the factory set, change their role, deactivate them." },
  comment: { risk: 'write', description: 'Write messages on the records your role shows.' },
  upload: { risk: 'write', description: 'Send files on the records your role shows.' },
  approve: { risk: 'write', description: 'Approve, accept or sign on the records your role shows (samples, proofs, quotes, changes).' },
})

export const PORTAL_COLLEAGUES_VIEW = 'portal.colleagues.view' satisfies Permission
export const PORTAL_COLLEAGUES_MANAGE = 'portal.colleagues.manage' satisfies Permission
export const PORTAL_COMMENT = 'portal.comment' satisfies Permission
export const PORTAL_UPLOAD = 'portal.upload' satisfies Permission
export const PORTAL_APPROVE = 'portal.approve' satisfies Permission
export const PORTAL_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_COLLEAGUES_VIEW, PORTAL_COLLEAGUES_MANAGE, PORTAL_COMMENT, PORTAL_UPLOAD, PORTAL_APPROVE])
