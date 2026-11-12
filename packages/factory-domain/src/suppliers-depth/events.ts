import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SUPPLIER_STATUSES } from '../purchasing/suppliers-depth/rules'

/**
 * Suppliers in depth's events (B-W2b-311; the code is factory-domain purchasing/suppliers-depth). A module folder of its
 * own, as compliance-claims (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/purchasing/suppliers-depth (and the parties import's supplier columns) emit it in the command that makes the
 * change; a change of kinds, lead time or origin is `party.updated` with its fields, a change of what a contact receives
 * `party.contacts_changed`.
 *
 *   supplier.status_changed   where a supplier stands with us changed (or its reason was corrected): the supplier list's
 *                             status column and tiles, the record's "Now" panel, a draft PO's send check
 *
 * Live for parties.view (who sees the supplier). Ids, codes and states only: never the reason (office words) or a person.
 */
export const events = [
  defineEvent({
    type: 'supplier.status_changed',
    context: 'suppliers-depth',
    description: 'Where a supplier stands with us changed (prospect, approved, approved with conditions, on hold, blocked, inactive), or the reason of its status was corrected.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), from: z.enum(SUPPLIER_STATUSES).nullable(), status: z.enum(SUPPLIER_STATUSES) }),
    live: { permission: 'parties.view', fields: ['partyId', 'code', 'status'] },
  }),
] as const
