import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Inviting a partner to one record (B-W2b-200; COL-061, COL-062), the OFFICE's (area `partners`, beside
 * partners.approvals.*), checked with can() against the record's company, site and party; inviting, changing and revoking
 * also need the record's own write permission (an order sales.orders.manage, a style product.styles.manage …), seeing the
 * shares its view permission (platform/shares records.ts):
 *   shares.view     who outside is invited to a record, what each may do, until when, and whether the share still lives
 *   shares.manage   invite a partner's contact to a record (a RECORD_INVITE link and its mail), change what they may do,
 *                   revoke the invitation (the share and its link stop together)
 *
 * The invited person holds no permission of its own: its link session's grants come from the RECORD_INVITE purpose
 * (links.open, links.post, links.upload, files.read: factory-domain links/purposes), and every use is narrowed to what the
 * share says now.
 */
export const PARTNERS_SHARES_DEFINITIONS = definePermissions('partners', {
  'shares.view': { risk: 'read', description: 'See who outside the company is invited to a record (a customer, supplier, workshop or brand contact), what each may do there and until when.' },
  'shares.manage': { risk: 'write', description: "Invite a partner's contact to one record by link (view, comment or upload, until a date), change what they may do, and revoke the invitation." },
})

export const PARTNERS_SHARES_VIEW = 'partners.shares.view' satisfies Permission
export const PARTNERS_SHARES_MANAGE = 'partners.shares.manage' satisfies Permission
export const PARTNERS_SHARES_PERMISSIONS: readonly Permission[] = Object.freeze([PARTNERS_SHARES_VIEW, PARTNERS_SHARES_MANAGE])

/**
 * Who invites and sees (the office templates, one line each; the owner from every(), read-only follows the registry): sales
 * brings customers and brands into their orders, quotes and styles; the buyer suppliers and workshops into their orders and
 * claims; the quality inspector the partner of a complaint or a return; the administrator all of them; the production
 * manager sees who is invited (a workshop's job, a brand's style).
 */
export const PARTNERS_SHARES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PARTNERS_SHARES_VIEW, PARTNERS_SHARES_MANAGE],
  sales: [PARTNERS_SHARES_VIEW, PARTNERS_SHARES_MANAGE],
  buyer: [PARTNERS_SHARES_VIEW, PARTNERS_SHARES_MANAGE],
  quality_inspector: [PARTNERS_SHARES_VIEW, PARTNERS_SHARES_MANAGE],
  production_manager: [PARTNERS_SHARES_VIEW],
})
