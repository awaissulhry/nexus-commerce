import type { FactoryClient } from '@nexus/factory-db'
import { isPartnerKind, partnerKindsOf, type Capability, type PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import { holdsSeat, splitRoleKeys } from '@nexus/factory-domain/auth/partners/rules'
import { partnerTemplateOf } from '@nexus/factory-domain/auth/roles/templates'
import type { CommandTx } from '../../../core/command'
import { liveAssignment } from '../roles/access'

/**
 * The reads of partner organisations and their people (B-W2b-162), in the tenant's OFFICE scope: Role, RoleAssignment,
 * Invitation and PortalSettings have no partner grant (B-W2b-152). The portal's own routes read their party's User rows
 * in the partner scope first (row-level security: their own party only) and the rest here, filtered by those people.
 */

type Reader = FactoryClient | CommandTx

export const PARTY_SELECT = { id: true, code: true, companyId: true, legalName: true, tradeName: true, roles: true, status: true } as const

export interface PartnerParty {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly name: string
  readonly roles: readonly string[]
  readonly status: string
  /** The portals it may have people of (its roles). */
  readonly kinds: readonly PartnerKind[]
}

export const partyView = (row: { id: string; code: string; companyId: string | null; legalName: string; tradeName: string | null; roles: string[]; status: string }): PartnerParty => ({
  id: row.id,
  code: row.code,
  companyId: row.companyId,
  name: row.tradeName ?? row.legalName,
  roles: row.roles,
  status: row.status,
  kinds: partnerKindsOf(row.roles),
})

export async function partyById(client: Reader, partyId: string): Promise<PartnerParty | null> {
  const row = await client.party.findUnique({ where: { id: partyId }, select: PARTY_SELECT })
  return row ? partyView(row) : null
}

export interface PortalSettingsView {
  readonly exists: boolean
  readonly portalOn: boolean
  readonly progressShared: boolean
  readonly maxUsers: number | null
  readonly allowedRoleKeys: readonly string[]
  readonly version: number
}

/** A party's portal settings (id = the party's id, B-W2b-152); no row: everything OFF, no limit. */
export async function settingsOf(client: Reader, partyId: string): Promise<PortalSettingsView> {
  const rows = await client.portalSettings.findMany({ where: { partyId }, select: { portalOn: true, progressShared: true, maxUsers: true, allowedRoleKeys: true, version: true }, take: 1 })
  const row = rows[0]
  return row ? { exists: true, ...row } : { exists: false, portalOn: false, progressShared: false, maxUsers: null, allowedRoleKeys: [], version: 0 }
}

export const PERSON_SELECT = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  status: true,
  audience: true,
  partyId: true,
  partnerKind: true,
  accessUntil: true,
  lastSignInAt: true,
  version: true,
  createdAt: true,
} as const

export interface PartnerPerson {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly locale: string
  readonly status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED'
  readonly partyId: string
  readonly kind: PartnerKind | null
  readonly accessUntil: Date | null
  readonly lastSignInAt: Date | null
  readonly version: number
  /** The main role (live assignment, or the open invitation's for an invited person). */
  readonly roleKey: string | null
  readonly capabilities: readonly Capability[]
  /** An invited person's open invitation. */
  readonly invitation: { readonly id: string; readonly expiresAt: Date; readonly invitedById: string | null } | null
  /** Holds one of the party's seats (maxUsers). */
  readonly seat: boolean
}

type PersonRow = { id: string; email: string; displayName: string; locale: string; status: PartnerPerson['status']; audience: string; partyId: string | null; partnerKind: string | null; accessUntil: Date | null; lastSignInAt: Date | null; version: number }

/** The party's people (any status), with their roles and open invitations, by name. `onlyIds`: these people only. */
export async function peopleOf(client: Reader, partyId: string, now: Date, onlyIds?: readonly string[]): Promise<PartnerPerson[]> {
  const rows = (await client.user.findMany({
    where: { partyId, audience: 'PARTNER', ...(onlyIds ? { id: { in: [...onlyIds] } } : {}) },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 1000,
    select: PERSON_SELECT,
  })) as PersonRow[]
  return withAccess(client, rows, now)
}

/** The people of these rows with their roles and open invitations (rows read in any scope that sees them). */
export async function withAccess(client: Reader, rows: readonly PersonRow[], now: Date): Promise<PartnerPerson[]> {
  const ids = rows.map((row) => row.id)
  if (ids.length === 0) return []
  const [assignments, invitations] = await Promise.all([
    client.roleAssignment.findMany({
      where: { userId: { in: ids }, ...liveAssignment(now), role: { audience: 'PARTNER' } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      select: { userId: true, role: { select: { key: true } } },
    }),
    client.invitation.findMany({
      where: { userId: { in: ids }, audience: 'PARTNER', acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, userId: true, expiresAt: true, invitedById: true, partnerRoleKeys: true },
    }),
  ])
  return rows.map((row) => {
    const invitation = invitations.find((entry) => entry.userId === row.id) ?? null
    const keys = row.status === 'INVITED' ? (invitation?.partnerRoleKeys ?? []) : assignments.filter((entry) => entry.userId === row.id).map((entry) => entry.role.key)
    const split = splitRoleKeys(keys)
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      locale: row.locale,
      status: row.status,
      partyId: row.partyId!,
      kind: isPartnerKind(row.partnerKind) ? row.partnerKind : null,
      accessUntil: row.accessUntil,
      lastSignInAt: row.lastSignInAt,
      version: row.version,
      roleKey: split.roleKey,
      capabilities: split.capabilities,
      invitation: invitation ? { id: invitation.id, expiresAt: invitation.expiresAt, invitedById: invitation.invitedById } : null,
      seat: holdsSeat({ status: row.status, invitationOpen: invitation !== null }),
    }
  })
}

/** One partner person of a party, or null (unknown, an office person, or of another party). */
export async function personOf(client: Reader, partyId: string, userId: string, now: Date): Promise<PartnerPerson | null> {
  const [person] = await peopleOf(client, partyId, now, [userId])
  return person ?? null
}

/** The seats the party's people hold now, leaving one person out (the one a change is for). */
export async function seatsTaken(client: Reader, partyId: string, now: Date, except?: string): Promise<number> {
  return (await peopleOf(client, partyId, now)).filter((person) => person.seat && person.id !== except).length
}

/** The ids of the tenant's PARTNER system roles with these keys (missing ones are left out). */
export async function partnerRoleIds(client: Reader, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await client.role.findMany({ where: { key: { in: [...keys] }, audience: 'PARTNER', system: true }, select: { id: true, key: true } })
  return new Map(rows.map((row) => [row.key, row.id]))
}

/** A person's main role in words: its name, and whether it sees prices. */
export function roleWords(roleKey: string | null): { readonly roleName: string | null; readonly seesPrices: boolean; readonly admin: boolean } {
  const template = roleKey ? partnerTemplateOf(roleKey) : undefined
  return { roleName: template?.name ?? null, seesPrices: template?.grains.includes('price') === true, admin: template?.admin === true }
}

/** Locks the party row for the rest of the command: invitations and role changes of one party run one at a time (seats). */
export async function lockParty(tx: CommandTx, partyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Party" WHERE "id" = ${partyId}::uuid FOR UPDATE`
}
