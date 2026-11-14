import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Mail in depth (B-W2b-394; COL-021, COL-027; design home.mail "Team inboxes", "Copy capture address", admin.connections
 * "Capture address"). Area `email`, beside email in's own.
 *
 *   email.inboxes.manage   set up a company's team inboxes (orders@, quotes@: the name, the address before the @, the members,
 *                          switched off) and its capture address for forwarded mail (make one, replace a leaked one, the team
 *                          inbox its unmatched mail lands in, turn it off). Checked with can() against the company.
 *
 * Working a team inbox's mail (take it, give it to a member, close, snooze, ask for a follow-up, move it) is email.triage over
 * the mail's company, for the inbox's members (or a holder of email.inboxes.manage); reading the capture address to copy it is
 * email.send over the company (whoever writes mail may forward it).
 */
export const MAIL_DEPTH_DEFINITIONS = definePermissions('email', {
  'inboxes.manage': {
    risk: 'write',
    description: 'Set up the team inboxes (orders@, quotes@: name, address, members, switched off) and the capture address staff forward mail to.',
  },
})

export const EMAIL_INBOXES_MANAGE = 'email.inboxes.manage' satisfies Permission

export const MAIL_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([EMAIL_INBOXES_MANAGE])

/** The role templates that get it (owner: every()): the administrators. */
export const MAIL_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({ admin: [EMAIL_INBOXES_MANAGE] })
