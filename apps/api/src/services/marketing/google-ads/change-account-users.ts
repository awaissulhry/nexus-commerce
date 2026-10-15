/**
 * Google Ads programme 2, G8b (2026-10-15) — who may use the Google Ads account: invite a person, cancel an invitation,
 * change a person's role, remove a person's access. ONE call of CustomerUserAccessInvitationService or
 * CustomerUserAccessService (gateway/google-account-calls.ts); neither has validate_only, so Google cannot check it
 * first. A security change: the preview names the person (masked e-mail address and Google's id) and the role plainly.
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of reference/rpc/v25/<Message>) and the user guides
 * (docs/account-management/managing-users, managing-invitations):
 *   CustomerUserAccessInvitationOperation  create { email_address, access_role } | remove (resource name); an invitation
 *                                          expires 20 days after it is sent (AccessInvitationStatus EXPIRED); PENDING,
 *                                          DECLINED, EXPIRED. customer_user_access lists only CONFIRMED users.
 *   CustomerUserAccessOperation            update { access_role } with update_mask | remove; Google refuses to take the
 *                                          last ADMIN away (CustomerUserAccessError LAST_ADMIN_USER_OF_SERVING_CUSTOMER /
 *                                          LAST_ADMIN_USER_OF_MANAGER).
 *   AccessRole                             ADMIN (owns the account, adds users), STANDARD (changes campaigns, not users),
 *                                          READ_ONLY (sees, cannot edit), EMAIL_ONLY (an e-mail recipient, not a user).
 *   Multi-party approval                   Google may hold a change for a second administrator (the result names a
 *                                          multi_party_auth_review instead of the resource): said in the answer.
 *   Access level                           CustomerUserAccess(Invitation)Service are not allowed at the Explorer access level
 *                                          (docs/api-policy/access-levels): Google then refuses, and the answer says so.
 * Nexus's own rules on top: never the last administrator, never the Google login Nexus signs in with (removing it, or
 * taking ADMIN from it, cuts Nexus — and the person who connected it — off from managing the account), a removal only
 * with confirmRemove.
 *
 * Personal data: a person's e-mail address is shown only MASKED in what the change shows (summary, changes, warnings:
 * "p***@example.com" and Google's user id): a preview is kept with the approval, and the Approvals page shows it to
 * everyone who sees approvals. The full address is in the request's arguments (an invitation needs it) and in the change
 * record undo reads (to invite a removed person again): people who can see Approvals can open both. Asking for or
 * approving the change needs users.manage.
 */
import { ACCESS_ROLES, EMAIL_RE, type AccessRole } from '../../gateway/google-account-calls.js'
import { maskEmail } from '../../orders/buyer-mask.js'
import { changeLines, type GoogleChangeDraft } from './change-draft.js'
import { ACCOUNT_CALL } from './account-client.js'
import type { LiveAccessState } from './live-account-admin.js'

export const USER_ACCESS_ACTIONS = ['invite', 'cancel-invitation', 'change-role', 'remove'] as const
export type UserAccessAction = typeof USER_ACCESS_ACTIONS[number]

export interface UserAccessRequest {
  action: UserAccessAction
  email?: string
  role?: AccessRole
  invitationId?: string
  userId?: string
  confirmRemove?: boolean
}

/** One person's access or invitation, before and after the change. */
export interface UserAccessRecord {
  action: UserAccessAction
  email: string | null
  role: AccessRole | null
  userId: string | null
  invitationId: string | null
  /** Whether the access (or the invitation) is there. */
  present: boolean
  /** Google holds the change for a second administrator (the review's resource name). */
  review?: string | null
}

export const ROLE_WORDS: Record<AccessRole, string> = {
  ADMIN: 'Admin (full access: users, billing and everything else)',
  STANDARD: 'Standard (changes campaigns; cannot manage users)',
  READ_ONLY: 'Read only (sees the account; cannot change it)',
  EMAIL_ONLY: 'Email only (receives e-mails and reports; cannot sign in to the account)',
}

export const NOT_CHECKED_USERS = 'Google cannot check a user change first (CustomerUserAccessService and CustomerUserAccessInvitationService have no '
  + 'validate_only): the preview is built from the live account, and the change is sent only after a person approves it.'

export const ACCESS_LEVEL_NOTE = 'At the Explorer access level Google does not allow user management through the API (developers.google.com/google-ads/api/docs/api-policy/access-levels): '
  + 'if Nexus\'s Google Cloud project is still at Explorer, Google refuses this when it runs and nothing changes (the answer says so).'

const role = (v: unknown): AccessRole | null => ((ACCESS_ROLES as readonly unknown[]).includes(v) ? v as AccessRole : null)
const sameEmail = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
/** A person as a change shows them: the masked e-mail address and Google's id ("p***@example.com (user 61)"). */
const masked = (email: string | null | undefined, id: string, kind: 'user' | 'invitation'): string => {
  const shown = maskEmail(email)
  return shown ? `${shown} (${kind} ${id})` : `${kind} ${id}`
}

function draftOf(
  summary: string, lines: Array<[string, unknown, unknown]>, path: string, body: Record<string, unknown>,
  stands: unknown, before: UserAccessRecord, after: UserAccessRecord, warnings: string[],
): GoogleChangeDraft {
  const { changes } = changeLines(lines)
  return {
    summary, changes, totals: { people: 1 }, warnings: [...warnings, ACCESS_LEVEL_NOTE], spendsMoney: [], skipped: [],
    operations: [{ [ACCOUNT_CALL]: { path, body } }], stands, before, after,
  }
}

export function userAccessDraft(customer: string, request: UserAccessRequest, live: LiveAccessState): GoogleChangeDraft | { refusal: string } {
  const admins = live.users.filter((u) => u.role === 'ADMIN')
  const pending = live.invitations.filter((i) => i.status === 'PENDING')
  const own = (email: string | null) => sameEmail(email, live.nexusLogin)
  const unknownLogin = live.nexusLogin ? [] : ['Nexus does not know which Google login it signs in with (the Google connection has no e-mail recorded): make sure this is not that login.']
  switch (request.action) {
    case 'invite': {
      const email = (request.email ?? '').trim()
      const wanted = role(request.role)
      if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { refusal: 'Give the e-mail address to invite (a valid address).' }
      if (!wanted) return { refusal: 'Give the role: ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY.' }
      const user = live.users.find((u) => sameEmail(u.email, email))
      if (user) return { refusal: `${email} already has access to this account as ${user.role ?? 'an unknown role'} (user ${user.userId}): use change-role to change it.` }
      const invited = pending.find((i) => sameEmail(i.email, email))
      if (invited) return { refusal: `${email} is already invited (invitation ${invited.invitationId}, ${invited.role ?? 'unknown role'}, sent ${invited.sentAt ?? 'earlier'}): cancel it first (cancel-invitation) to invite with another role.` }
      const who = maskEmail(email)!
      const warnings = [`Google e-mails an invitation to ${who}; the person accepts it (it may be accepted with another Google login, and it expires after 20 days). The full address is in the request.`]
      if (wanted === 'ADMIN') warnings.push(`${who} becomes an administrator: they can add and remove users (you too), change billing and everything else in the account.`)
      return draftOf(
        `Invite ${who} to the Google Ads account as ${ROLE_WORDS[wanted]}.`,
        [[`Invitation for ${who}`, '(none)', ROLE_WORDS[wanted]]],
        'customerUserAccessInvitations:mutate', { operation: { create: { emailAddress: email, accessRole: wanted } } },
        { email: email.toLowerCase(), users: live.users.filter((u) => sameEmail(u.email, email)).length, pending: false },
        { action: 'invite', email, role: wanted, userId: null, invitationId: null, present: false },
        { action: 'invite', email, role: wanted, userId: null, invitationId: null, present: true },
        warnings,
      )
    }
    case 'cancel-invitation': {
      const id = (request.invitationId ?? '').trim()
      const invitation = live.invitations.find((i) => i.invitationId === id)
      if (!invitation) return { refusal: `Invitation ${id || '(none given)'} is not in this account (google-ads-live view users lists the invitations).` }
      const who = masked(invitation.email, id, 'invitation')
      if (invitation.status !== 'PENDING') return { refusal: `Invitation ${who} is ${invitation.status ?? 'not pending'}: only a pending invitation is cancelled.` }
      const was = role(invitation.role)
      return draftOf(
        `Cancel the invitation of ${who} (${was ? ROLE_WORDS[was] : invitation.role ?? 'unknown role'}) to the Google Ads account.`,
        [[`Invitation for ${who}`, was ? ROLE_WORDS[was] : invitation.role, '(cancelled)']],
        'customerUserAccessInvitations:mutate', { operation: { remove: `${customer}/customerUserAccessInvitations/${id}` } },
        { invitationId: id, email: invitation.email, role: invitation.role, status: invitation.status },
        { action: 'cancel-invitation', email: invitation.email, role: was, userId: null, invitationId: id, present: true },
        { action: 'cancel-invitation', email: invitation.email, role: was, userId: null, invitationId: id, present: false },
        ['The invitation e-mail stops working: the person can no longer accept it.'],
      )
    }
    case 'change-role':
    case 'remove': {
      const id = (request.userId ?? '').trim()
      const user = live.users.find((u) => u.userId === id)
      if (!user) return { refusal: `User ${id || '(none given)'} has no access to this account (google-ads-live view users lists who has; an invited person who has not accepted is cancelled with cancel-invitation).` }
      const was = role(user.role)
      const who = masked(user.email, id, 'user')
      const lastAdmin = user.role === 'ADMIN' && admins.length <= 1
      if (request.action === 'remove') {
        if (request.confirmRemove !== true) return { refusal: `Removing the access of ${who} needs confirmRemove: true. It cannot be put back: the person can only be invited again (and must accept).` }
        if (lastAdmin) return { refusal: `${who} is the account's only administrator: Google Ads always keeps one (Nexus does not remove the last admin). Make someone else ADMIN first.` }
        if (own(user.email)) return { refusal: `${who} is the Google login Nexus signs in with: removing it cuts Nexus (and you) off from this account. Another administrator removes it in Google Ads if that is really wanted.` }
        return draftOf(
          `Remove the access of ${who} to the Google Ads account (role now: ${was ? ROLE_WORDS[was] : user.role ?? 'unknown'}).`,
          [[`Access of ${who}`, was ? ROLE_WORDS[was] : user.role, '(removed)']],
          'customerUserAccesses:mutate', { operation: { remove: `${customer}/customerUserAccesses/${id}` } },
          { userId: id, email: user.email, role: user.role, admins: admins.map((a) => a.userId).sort() },
          { action: 'remove', email: user.email, role: was, userId: id, invitationId: null, present: true },
          { action: 'remove', email: user.email, role: was, userId: id, invitationId: null, present: false },
          [`${who} can no longer sign in to this Google Ads account. Removing access cannot be put back: undo invites the person again, and they must accept.`, ...unknownLogin],
        )
      }
      const wanted = role(request.role)
      if (!wanted) return { refusal: 'Give the new role: ADMIN, STANDARD, READ_ONLY or EMAIL_ONLY.' }
      if (wanted === user.role) return { refusal: `${who} already has the role ${wanted}: nothing to change.` }
      if (lastAdmin && wanted !== 'ADMIN') return { refusal: `${who} is the account's only administrator: Google Ads always keeps one (Nexus does not take ADMIN from the last admin). Make someone else ADMIN first.` }
      if (user.role === 'ADMIN' && wanted !== 'ADMIN' && own(user.email)) return { refusal: `${who} is the Google login Nexus signs in with: without ADMIN, Nexus (and you) can no longer manage users or billing here. Another administrator changes it in Google Ads if that is really wanted.` }
      const warnings = [...(user.role === 'ADMIN' && wanted !== 'ADMIN' ? unknownLogin : [])]
      if (wanted === 'ADMIN') warnings.push(`${who} becomes an administrator: they can add and remove users (you too), change billing and everything else in the account.`)
      return draftOf(
        `Change the role of ${who} in the Google Ads account from ${was ? ROLE_WORDS[was] : user.role ?? 'unknown'} to ${ROLE_WORDS[wanted]}.`,
        [[`Role of ${who}`, was ? ROLE_WORDS[was] : user.role, ROLE_WORDS[wanted]]],
        'customerUserAccesses:mutate', { operation: { update: { resourceName: `${customer}/customerUserAccesses/${id}`, accessRole: wanted }, updateMask: 'access_role' } },
        { userId: id, email: user.email, role: user.role, admins: admins.map((a) => a.userId).sort() },
        { action: 'change-role', email: user.email, role: was, userId: id, invitationId: null, present: true },
        { action: 'change-role', email: user.email, role: wanted, userId: id, invitationId: null, present: true },
        warnings,
      )
    }
  }
}

/** What is there now, in the shape of the change's `after` (undo's "current"). */
export function userAccessNow(after: UserAccessRecord, live: LiveAccessState): UserAccessRecord {
  if (after.action === 'invite' || after.action === 'cancel-invitation') {
    const invitation = after.invitationId ? live.invitations.find((i) => i.invitationId === after.invitationId && i.status === 'PENDING') : undefined
    return { ...after, present: !!invitation, ...(invitation ? { role: role(invitation.role) } : {}) }
  }
  const user = after.userId ? live.users.find((u) => u.userId === after.userId) : undefined
  return { ...after, present: !!user, ...(user ? { role: role(user.role) } : {}) }
}

/** The request that puts the change back, or why it cannot. */
export function userAccessUndo(before: UserAccessRecord, after: UserAccessRecord): { args: Record<string, unknown> } | { refusal: string } {
  if (after.review) return { refusal: `Google holds this change for a second administrator's approval (${after.review}): approve or reject it in Google Ads; there is nothing to put back yet.` }
  switch (after.action) {
    case 'invite':
      return after.invitationId
        ? { args: { action: 'cancel-invitation', invitationId: after.invitationId } }
        : { refusal: 'This change does not record the invitation Google made: cancel it in Google Ads (Admin › Access and security).' }
    case 'cancel-invitation':
      return before.email && before.role ? { args: { action: 'invite', email: before.email, role: before.role } } : { refusal: 'This change does not record the e-mail address and role it cancelled.' }
    case 'change-role':
      return before.userId && before.role ? { args: { action: 'change-role', userId: before.userId, role: before.role } } : { refusal: 'This change does not record the role it replaced.' }
    case 'remove':
      return before.email && before.role ? { args: { action: 'invite', email: before.email, role: before.role } } : { refusal: 'This change does not record the e-mail address and role it removed.' }
  }
}
