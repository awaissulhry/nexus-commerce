import type { Permission } from '../core/permissions'

/**
 * The one-off links' permissions (plan A1 §3.10 "Links", §3.11; features SAL-099, PLT-007). Declared in
 * `auth/permissions/catalogue.ts` (LINKS_PERMISSIONS for the office, LINK_SESSION_PERMISSIONS for link sessions).
 *
 *   office (role assignments)   links.view, links.manage
 *   link sessions (the purpose) links.open and one permission per answer the purpose allows; never in a role
 */

/** See the links of a record: who they were made for, their state, their uses and the evidence of each answer. */
export const LINKS_VIEW = 'links.view' satisfies Permission
/** Make a link for a record (to send to its customer or supplier) and revoke one. */
export const LINKS_MANAGE = 'links.manage' satisfies Permission

/** A link session opens its one record. Every purpose holds it. */
export const LINK_OPEN = 'links.open' satisfies Permission
/** A link session accepts the quote it opens (QUOTE_ACCEPT). */
export const LINK_ACCEPT = 'links.accept' satisfies Permission
/** A link session declines the quote or purchase order it opens. */
export const LINK_DECLINE = 'links.decline' satisfies Permission
/** A link session confirms the purchase order it opens (PO_CONFIRM). */
export const LINK_CONFIRM = 'links.confirm' satisfies Permission

export const LINKS_OFFICE_PERMISSIONS = [LINKS_VIEW, LINKS_MANAGE] as const
export const LINK_SESSION_PERMISSIONS = [LINK_OPEN, LINK_ACCEPT, LINK_DECLINE, LINK_CONFIRM] as const
