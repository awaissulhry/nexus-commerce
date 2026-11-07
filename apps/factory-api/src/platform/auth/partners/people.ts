import { createHash, randomBytes } from 'node:crypto'
import { kindFits, type Capability } from '@nexus/factory-domain/auth/partners/kinds'
import { choiceProblems, PARTNER_PEOPLE, PARTNER_WORDS, roleKeysOf, seatProblem, type AccessChoice } from '@nexus/factory-domain/auth/partners/rules'
import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { StaleVersionError, type CommandTools, type CommandTx } from '../../../core/command'
import { requirePortalTerms } from '../portal/terms'
import { endAllAssignments } from '../roles/assignments'
import { endSessions } from '../sessions/session-store'
import { userStatus } from '../users/status'
import { liveAssignment } from '../roles/access'
import { lockParty, partnerRoleIds, partyById, personOf, seatsTaken, settingsOf, type PartnerPerson } from './store'

/**
 * The commands' work on a partner's people (B-W2b-162; PLT-006, PLT-021, PLT-022, SAL-060, SCM-092), shared by the office's
 * Portal access (office.ts) and the partner admin's colleagues (colleagues.ts). Each runs inside ONE command (audit rows,
 * the event, an Idempotency-Key's receipt) with the party's row locked, so the seats (PortalSettings.maxUsers) count once:
 *
 *   invite    a new partner person (User PARTNER, INVITED, its party, kind and end of access; no password, C3), or one
 *             invited before or deactivated (invited again: the same row, so history keeps one person); earlier open
 *             invitations stop; a new PARTNER invitation (7 days) names the role keys (main + capabilities) and the end of
 *             access; the first sign-in accepts it (B-W2b-159). Refused in words: an office person's or another
 *             organisation's address, someone with access already, a blocked organisation, a kind its roles do not
 *             give, a role or capability outside the limits, no seat left, the portal roles not set up, and the company's
 *             portal terms not published (GATE-PRIVACY, `requirePortalTerms`). The invitation's token is never sent (the
 *             person signs in with an e-mail code): only a random hash fills the column.
 *   change    the main role, the capabilities and the end of access: an invited person's open invitation, or an active or
 *             suspended person's live PARTNER role assignments (ended and given, never edited) and User.accessUntil
 *   status    suspend (sessions end), reactivate, deactivate (sessions end, open invitations stop, every assignment ends);
 *             the user status machine (B-W0)
 *   revoke    an invited person's open invitation stops and the person is DEACTIVATED (invite them again later)
 */

export interface Changer {
  /** The office person, or the partner's admin (their own id). */
  readonly actorId: string
  /** A partner admin from the portal (else the office). */
  readonly byPartner: boolean
}

const placeholderTokenHash = (): string => createHash('sha256').update(randomBytes(32)).digest('hex')

export interface InviteWork {
  readonly partyId: string
  readonly companyId: string
  readonly email: string
  readonly displayName: string
  readonly locale: 'it' | 'en'
  readonly choice: AccessChoice
}

export interface InvitedResult {
  readonly invitation: { readonly id: string; readonly userId: string; readonly email: string; readonly expiresAt: string; readonly roleKeys: string[]; readonly accessUntil: string | null }
  readonly partyName: string
}

export async function inviteInCommand({ tx, now, audit, emit, context }: CommandTools, work: InviteWork, by: Changer): Promise<InvitedResult> {
  if (context.audience !== 'office') throw new Error('A portal invitation is written in the office scope.')
  await lockParty(tx, work.partyId)
  const party = await partyById(tx, work.partyId)
  if (!party) throw new NotFoundError('Organisation not found.')
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') throw new ConflictError(PARTNER_WORDS.blocked)
  if (!kindFits(work.choice.kind, party.roles)) throw new DomainError('conflict', PARTNER_WORDS.kindDoesNotFit(work.choice.kind), [{ path: 'kind', message: PARTNER_WORDS.kindDoesNotFit(work.choice.kind) }])
  const settings = await settingsOf(tx, party.id)
  const issues = choiceProblems(work.choice, settings, now)
  if (issues.length > 0) throw new ValidationError('The access is not valid.', issues)
  // GATE-PRIVACY: no invitation for the portal of a company without its portal terms published (B-W2b-159 terms.ts).
  await requirePortalTerms(tx, work.companyId)
  const roleKeys = roleKeysOf(work.choice.roleKey, work.choice.capabilities)
  if ((await partnerRoleIds(tx, roleKeys)).size !== roleKeys.length) throw new ConflictError(PARTNER_WORDS.rolesNotReady)

  const existing = await tx.user.findUnique({ where: { tenantId_email: { tenantId: context.tenantId, email: work.email } }, select: { id: true, status: true, audience: true, partyId: true, version: true } })
  const refuse = (message: string): never => {
    throw new DomainError('conflict', message, [{ path: 'email', message }])
  }
  if (existing?.audience === 'OFFICE') refuse(PARTNER_WORDS.officeAddress)
  if (existing && existing.partyId !== party.id) refuse(PARTNER_WORDS.otherOrganisation)
  if (existing && (existing.status === 'ACTIVE' || existing.status === 'SUSPENDED')) refuse(PARTNER_WORDS.alreadyIn)
  const seat = seatProblem(settings, await seatsTaken(tx, party.id, now, existing?.id), party.name)
  if (seat) throw new ConflictError(seat)

  const accessUntil = work.choice.accessUntil
  const userId = existing?.id ?? newId()
  if (existing) {
    if (existing.status === 'DEACTIVATED') assertTransition(userStatus, existing.status, 'INVITED', undefined)
    const { count } = await tx.user.updateMany({
      where: { id: userId, version: existing.version },
      data: { version: existing.version + 1, status: 'INVITED', displayName: work.displayName, locale: work.locale, partnerKind: work.choice.kind, accessUntil },
    })
    if (count !== 1) throw new StaleVersionError('User', userId, existing.version + 1, existing.version)
    const revoked = await tx.invitation.updateMany({ where: { userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
    audit({ recordType: 'User', recordId: userId, companyId: work.companyId, before: { status: existing.status }, after: { status: 'INVITED', displayName: work.displayName, kind: work.choice.kind, accessUntil: accessUntil ? toUtcIso(accessUntil) : null, invitationsRevoked: revoked.count, byPartner: by.byPartner } })
  } else {
    await tx.user.create({
      data: { id: userId, email: work.email, displayName: work.displayName, locale: work.locale, status: 'INVITED', audience: 'PARTNER', partyId: party.id, partnerKind: work.choice.kind, accessUntil, createdAt: now, createdById: by.actorId },
      select: { id: true },
    })
    audit({ recordType: 'User', recordId: userId, companyId: work.companyId, after: { email: work.email, displayName: work.displayName, status: 'INVITED', partyId: party.id, kind: work.choice.kind, accessUntil: accessUntil ? toUtcIso(accessUntil) : null, byPartner: by.byPartner } })
  }
  const id = newId()
  const expiresAt = new Date(now.getTime() + PARTNER_PEOPLE.invitationTtlMs)
  await tx.invitation.create({
    data: { id, userId, email: work.email, tokenHash: placeholderTokenHash(), invitedById: by.actorId, createdAt: now, expiresAt, audience: 'PARTNER', partyId: party.id, partnerRoleKeys: roleKeys, accessUntil },
    select: { id: true },
  })
  audit({ recordType: 'Invitation', recordId: id, companyId: work.companyId, after: { userId, partyId: party.id, roleKeys, accessUntil: accessUntil ? toUtcIso(accessUntil) : null, expiresAt: toUtcIso(expiresAt), byPartner: by.byPartner } })
  emit({
    type: 'partner_user.invited',
    subject: userId,
    companyId: party.companyId,
    payload: { userId, partyId: party.id, invitationId: id, kind: work.choice.kind, roleKey: work.choice.roleKey, capabilities: [...work.choice.capabilities], byPartner: by.byPartner },
  })
  return {
    invitation: { id, userId, email: work.email, expiresAt: toUtcIso(expiresAt), roleKeys, accessUntil: accessUntil ? toUtcIso(accessUntil) : null },
    partyName: party.name,
  }
}

export interface ChangeWork {
  readonly partyId: string
  readonly userId: string
  readonly roleKey?: string | undefined
  readonly capabilities?: readonly Capability[] | undefined
  /** undefined: unchanged; null: no end (not for a GUEST). */
  readonly accessUntil?: Date | null | undefined
}

/** The person before the change (read inside the command, with the party locked). */
export async function changeInCommand({ tx, now, audit, emit }: CommandTools, work: ChangeWork, by: Changer, companyId: string | null) {
  await lockParty(tx, work.partyId)
  const person = await personOf(tx, work.partyId, work.userId, now)
  if (!person) throw new NotFoundError('Person not found.')
  if (person.status === 'DEACTIVATED') throw new InvalidStateError('This person was deactivated: invite them again.')
  if (person.kind === null || person.roleKey === null) throw new InvalidStateError('This person holds no portal role: invite them again.')
  const settings = await settingsOf(tx, work.partyId)
  const next: AccessChoice = {
    kind: person.kind,
    roleKey: work.roleKey ?? person.roleKey,
    capabilities: work.capabilities ?? person.capabilities,
    accessUntil: work.accessUntil === undefined ? person.accessUntil : work.accessUntil,
  }
  const roleChanged = next.roleKey !== person.roleKey
  // The allowed roles bind a NEW role: a person keeps one the office took off the list later (their capabilities may change);
  // an end of access is checked when it is given (a stored one that passed does not stop a role change).
  const issues = choiceProblems(next, { ...settings, allowedRoleKeys: roleChanged ? settings.allowedRoleKeys : [] }, now).filter(
    (issue) => work.accessUntil !== undefined || issue.path !== 'accessUntil',
  )
  if (issues.length > 0) throw new ValidationError('The access is not valid.', issues)
  const changes: ('ROLE' | 'ACCESS_UNTIL')[] = []
  const before = roleKeysOf(person.roleKey, person.capabilities)
  const after = roleKeysOf(next.roleKey, next.capabilities)
  if (before.join(',') !== after.join(',')) changes.push('ROLE')
  const accessChanged = (person.accessUntil?.getTime() ?? null) !== (next.accessUntil?.getTime() ?? null)
  if (accessChanged) changes.push('ACCESS_UNTIL')
  if (changes.length === 0) throw new InvalidStateError('Nothing changes: this is the access the person has.')

  if (person.status === 'INVITED') {
    if (!person.invitation) throw new InvalidStateError(PARTNER_WORDS.notInvited)
    await tx.invitation.update({ where: { id: person.invitation.id }, data: { partnerRoleKeys: after, accessUntil: next.accessUntil }, select: { id: true } })
  } else if (changes.includes('ROLE')) {
    const ids = await partnerRoleIds(tx, after)
    if (ids.size !== after.length) throw new ConflictError(PARTNER_WORDS.rolesNotReady)
    await replaceRoles(tx, person, ids, { now, actorId: by.actorId })
  }
  if (accessChanged) await tx.user.update({ where: { id: person.id }, data: { accessUntil: next.accessUntil }, select: { id: true } })
  const iso = (value: Date | null) => (value ? toUtcIso(value) : null)
  audit({
    recordType: 'User',
    recordId: person.id,
    companyId,
    before: { roleKeys: before, accessUntil: iso(person.accessUntil) },
    after: { roleKeys: after, accessUntil: iso(next.accessUntil), byPartner: by.byPartner },
  })
  emit({ type: 'partner_user.changed', subject: person.id, companyId, payload: { userId: person.id, partyId: work.partyId, changes, status: person.status, byPartner: by.byPartner } })
  return { id: person.id, roleKeys: after, accessUntil: iso(next.accessUntil) }
}

/** Ends the person's live PARTNER assignments that are not wanted and gives the missing ones (bound to their party). */
async function replaceRoles(tx: CommandTx, person: PartnerPerson, wanted: ReadonlyMap<string, string>, at: { readonly now: Date; readonly actorId: string }): Promise<void> {
  const live = await tx.roleAssignment.findMany({ where: { userId: person.id, ...liveAssignment(at.now), role: { audience: 'PARTNER' } }, select: { id: true, roleId: true } })
  const roleIds = new Set(wanted.values())
  const ending = live.filter((row) => !roleIds.has(row.roleId)).map((row) => row.id)
  if (ending.length > 0) await tx.roleAssignment.updateMany({ where: { id: { in: ending } }, data: { endedAt: at.now, endedById: at.actorId, version: { increment: 1 } } })
  for (const roleId of roleIds) {
    if (live.some((row) => row.roleId === roleId)) continue
    await tx.roleAssignment.create({
      data: { id: newId(), userId: person.id, roleId, allCompanies: true, companyIds: [], siteIds: [], partyIds: [person.partyId], validFrom: at.now, grantedById: at.actorId, createdAt: at.now, updatedAt: at.now },
      select: { id: true },
    })
  }
}

export type StatusChange = 'suspend' | 'reactivate' | 'deactivate'
export const STATUS_TARGET = { suspend: 'SUSPENDED', reactivate: 'ACTIVE', deactivate: 'DEACTIVATED' } as const
const STATUS_EVENT = { suspend: 'SUSPENDED', reactivate: 'REACTIVATED', deactivate: 'DEACTIVATED' } as const

/** The work of a status command (the record guard moved the status first: the user status machine). */
export async function statusInCommand({ tx, now, audit, emit, record }: CommandTools, work: { readonly partyId: string; readonly userId: string; readonly change: StatusChange; readonly reason?: string | undefined }, by: Changer, companyId: string | null) {
  const to = STATUS_TARGET[work.change]
  let sessionsEnded = 0
  let assignmentsEnded = 0
  let invitationsRevoked = 0
  if (to === 'SUSPENDED' || to === 'DEACTIVATED') sessionsEnded = await endSessions(tx, { userId: work.userId, now, reason: to })
  if (to === 'DEACTIVATED') {
    invitationsRevoked = (await tx.invitation.updateMany({ where: { userId: work.userId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })).count
    assignmentsEnded = await endAllAssignments(tx, work.userId, { now, endedById: by.actorId })
  }
  audit({
    recordType: 'User',
    recordId: work.userId,
    companyId,
    before: { status: record!.from },
    after: { status: record!.to, sessionsEnded, invitationsRevoked, assignmentsEnded, byPartner: by.byPartner },
    ...(work.reason ? { reason: work.reason } : {}),
  })
  emit({ type: 'partner_user.changed', subject: work.userId, companyId, payload: { userId: work.userId, partyId: work.partyId, changes: [STATUS_EVENT[work.change]], status: to, byPartner: by.byPartner } })
  return { id: work.userId, status: to, version: record!.version, sessionsEnded }
}

/** The work of revoking an invited person's open invitation: the person becomes DEACTIVATED (the record guard's move). */
export async function revokeInCommand({ tx, now, audit, emit, record }: CommandTools, work: { readonly partyId: string; readonly userId: string; readonly invitationId: string }, by: Changer, companyId: string | null) {
  const { count } = await tx.invitation.updateMany({ where: { id: work.invitationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } })
  if (count !== 1) throw new InvalidStateError(PARTNER_WORDS.notInvited)
  audit({ recordType: 'Invitation', recordId: work.invitationId, companyId, after: { revokedAt: toUtcIso(now), byPartner: by.byPartner } })
  audit({ recordType: 'User', recordId: work.userId, companyId, before: { status: 'INVITED' }, after: { status: record!.to } })
  emit({ type: 'partner_user.changed', subject: work.userId, companyId, payload: { userId: work.userId, partyId: work.partyId, changes: ['INVITATION_REVOKED'], status: 'DEACTIVATED', byPartner: by.byPartner } })
  return { id: work.userId, status: 'DEACTIVATED' as const, version: record!.version }
}
