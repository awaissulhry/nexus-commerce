import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The mail delivery log and the blocked addresses (apps/factory-api platform/email-out/delivery; B-W2a-41; PLT-149;
 * design admin.connections "Delivery log and blocked addresses"). Area `email`, beside email out's own list.
 *
 *   email.delivery.view     read the log: every mail the factory sent (record mail, sign-in mail, the digest), where it
 *                           is (waiting, sent, delivered, bounced, complained, failed) and which record it is about; the
 *                           blocked addresses and why. Checked with can() against the mail's company; the blocked list is
 *                           tenant-wide (any grant). Addresses are masked unless the reader also holds email.manage there.
 *   email.delivery.unblock  unblock an address (a person's reason): mail may go to it again. Tenant-wide (one list for
 *                           every company), so it needs a grant over every active company.
 *
 * Not step-up: unblocking widens nobody's rights; the admin role that holds it asks for two-factor at sign-in anyway.
 */
export const EMAIL_DELIVERY_DEFINITIONS = definePermissions('email', {
  'delivery.view': {
    risk: 'read',
    description: 'See the mail the factory sent and where each one is (sent, delivered, bounced, complained, failed), and the blocked addresses; addresses in full only with email.manage.',
  },
  'delivery.unblock': {
    risk: 'write',
    description: 'Unblock an address that bounced, complained or was stopped, with the reason: mail may go to it again.',
  },
})

export const EMAIL_DELIVERY_VIEW = 'email.delivery.view' satisfies Permission
export const EMAIL_DELIVERY_UNBLOCK = 'email.delivery.unblock' satisfies Permission

export const EMAIL_DELIVERY_PERMISSIONS: readonly Permission[] = Object.freeze([EMAIL_DELIVERY_VIEW, EMAIL_DELIVERY_UNBLOCK])
