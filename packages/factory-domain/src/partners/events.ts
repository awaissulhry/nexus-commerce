import { z } from 'zod'
import { CAPABILITIES, PARTNER_KINDS } from '../auth/partners/kinds'
import { defineEvent } from '../events/define'

/**
 * Partner organisations and their people (B-W2b-162; PLT-006, PLT-021, PLT-022). apps/factory-api's platform/auth/partners
 * emits them in the commands that make the change (an office person's, a partner admin's, or the scheduler's). Their own
 * module folder: the code is factory-domain auth/partners.
 *
 *   partner_portal.settings_changed   a party's portal was switched on or off, its limits (people, roles) or its production
 *                                     progress switch (Owner answer C1) changed
 *   partner_user.invited              a person of a party was invited to its portal (or invited again)
 *   partner_user.changed              a portal person's role, capabilities, end of access or status changed, or their
 *                                     open invitation was revoked
 *   partner_user.access_ending        a portal person's access ends within 7 days (once per end of access; PLT-022)
 *
 * Reach the Portal access tabs and Admin › Users of the office (partners.view over the party's company): ids, kinds,
 * keys and states only; never a name or an address.
 */

const live = (fields: readonly string[]) => ({ permission: 'partners.view', fields }) as const

export const PARTNER_USER_CHANGES = ['ROLE', 'ACCESS_UNTIL', 'SUSPENDED', 'REACTIVATED', 'DEACTIVATED', 'INVITATION_REVOKED'] as const
const STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const

export const events = [
  defineEvent({
    type: 'partner_portal.settings_changed',
    context: 'partners',
    description: "A party's portal was switched on or off, or its limits (people, roles) or its production-progress switch changed.",
    payload: z.strictObject({ partyId: z.uuid(), fields: z.array(z.string()), portalOn: z.boolean(), progressShared: z.boolean() }),
    live: live(['partyId', 'fields', 'portalOn']),
  }),
  defineEvent({
    type: 'partner_user.invited',
    context: 'partners',
    description: 'A person of a party was invited to its portal (or invited again), with a role and what they may also do.',
    payload: z.strictObject({
      userId: z.uuid(),
      partyId: z.uuid(),
      invitationId: z.uuid(),
      kind: z.enum(PARTNER_KINDS),
      roleKey: z.string(),
      capabilities: z.array(z.enum(CAPABILITIES)),
      /** Invited by the partner's own admin (else by the office). */
      byPartner: z.boolean(),
    }),
    live: live(['userId', 'partyId']),
  }),
  defineEvent({
    type: 'partner_user.changed',
    context: 'partners',
    description: "A portal person's role, capabilities, end of access or status changed, or their open invitation was revoked.",
    payload: z.strictObject({
      userId: z.uuid(),
      partyId: z.uuid(),
      changes: z.array(z.enum(PARTNER_USER_CHANGES)),
      status: z.enum(STATUSES),
      byPartner: z.boolean(),
    }),
    live: live(['userId', 'partyId', 'status']),
  }),
  defineEvent({
    type: 'partner_user.access_ending',
    context: 'partners',
    description: "A portal person's access ends within 7 days; they were told by e-mail (once per end of access).",
    payload: z.strictObject({ userId: z.uuid(), partyId: z.uuid(), accessUntil: z.iso.datetime() }),
    live: live(['userId', 'partyId']),
  }),
] as const
