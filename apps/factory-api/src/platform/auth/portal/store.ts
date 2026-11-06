import type { FactoryClient, PortalSignInCodePurpose } from '@nexus/factory-db'
import type { PartnerRole } from '@nexus/factory-domain/auth/portal/access'
import { PORTAL_CODE } from '@nexus/factory-domain/auth/portal/codes'
import { portalAbsoluteExpiryAt, portalIdleExpiryAt } from '@nexus/factory-domain/auth/portal/session'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { portalTermsInForce } from './terms'
import { liveAssignment } from '../roles/access'

/**
 * The portal's reads and rows (B-W2b-159), in the tenant's OFFICE scope: the code, settings, roles, notices and
 * acknowledgements are office tables (factory_partner_runtime reads only its own party's User and Session rows, B-W2b-152).
 * The portal authenticator reads its session in the partner scope first, then these facts here.
 */

type Reader = FactoryClient | CommandTx

export interface PortalCompany {
  readonly id: string
  readonly code: string
  /** As partners know it: the trade name, else the legal name. */
  readonly name: string
}

const COMPANY = { id: true, code: true, legalName: true, tradeName: true } as const
const companyView = (row: { id: string; code: string; legalName: string; tradeName: string | null }): PortalCompany => ({ id: row.id, code: row.code, name: row.tradeName ?? row.legalName })

/** The company whose portal a request names (its code), else the tenant's only active company; null: none, or ambiguous. */
export async function portalCompany(client: Reader, code: string | undefined): Promise<PortalCompany | null> {
  if (code !== undefined) {
    const row = await client.company.findFirst({ where: { code, status: 'ACTIVE' }, select: COMPANY })
    return row ? companyView(row) : null
  }
  const rows = await client.company.findMany({ where: { status: 'ACTIVE' }, select: COMPANY, take: 2 })
  return rows.length === 1 ? companyView(rows[0]!) : null
}

export const companyById = async (client: Reader, id: string): Promise<PortalCompany | null> => {
  const row = await client.company.findUnique({ where: { id }, select: COMPANY })
  return row ? companyView(row) : null
}

/** Whom a refused partner contacts: the company with its default conversation address, else its name. */
export async function contactOf(client: Reader, company: PortalCompany): Promise<string> {
  const identity = await client.emailIdentity.findFirst({
    where: { companyId: company.id, kind: 'CONVERSATION', status: 'ACTIVE', isDefault: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { fromAddress: true },
  })
  return identity ? `${company.name} (${identity.fromAddress})` : company.name
}

export const PARTNER_USER = {
  id: true,
  email: true,
  displayName: true,
  locale: true,
  status: true,
  audience: true,
  partyId: true,
  partnerKind: true,
  accessUntil: true,
} as const

export interface PartnerPerson {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly locale: string
  readonly status: string
  readonly partyId: string
  readonly partnerKind: string | null
  readonly accessUntil: Date | null
}

/** A partner person of the tenant by address (office scope), or null (unknown, an office person, or no party). */
export async function partnerByEmail(client: Reader, tenantId: string, email: string): Promise<PartnerPerson | null> {
  const row = await client.user.findUnique({ where: { tenantId_email: { tenantId, email } }, select: PARTNER_USER })
  return row && row.audience === 'PARTNER' && row.partyId !== null ? { ...row, partyId: row.partyId } : null
}

export async function partnerById(client: Reader, userId: string): Promise<PartnerPerson | null> {
  const row = await client.user.findUnique({ where: { id: userId }, select: PARTNER_USER })
  return row && row.audience === 'PARTNER' && row.partyId !== null ? { ...row, partyId: row.partyId } : null
}

export interface PartnerParty {
  readonly id: string
  readonly status: string
  readonly companyId: string | null
  readonly name: string
}

export async function partyOf(client: Reader, partyId: string): Promise<PartnerParty | null> {
  const row = await client.party.findUnique({ where: { id: partyId }, select: { id: true, status: true, companyId: true, legalName: true, tradeName: true } })
  return row ? { id: row.id, status: row.status, companyId: row.companyId, name: row.tradeName ?? row.legalName } : null
}

/** A party is a partner of the company whose portal it is: tenant-wide, or of that company. */
export const partyOfCompany = (party: PartnerParty, companyId: string): boolean => party.companyId === null || party.companyId === companyId

/** PortalSettings.portalOn of a party (no row: OFF). */
export async function portalOn(client: Reader, partyId: string): Promise<boolean> {
  const rows = await client.portalSettings.findMany({ where: { partyId }, select: { portalOn: true }, take: 1 })
  return rows[0]?.portalOn === true
}

/** An INVITED partner person's open PARTNER invitation (not accepted, not revoked, not expired), newest first. */
export async function openInvitation(client: Reader, userId: string, now: Date) {
  return client.invitation.findFirst({
    where: { userId, audience: 'PARTNER', acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, partyId: true, partnerRoleKeys: true, accessUntil: true },
  })
}

export interface TermsState {
  readonly noticeId: string
  readonly label: string
  readonly acknowledged: boolean
}

/** The company's PORTAL_TERMS notice in force and whether the person acknowledged that version; null: none in force. */
export async function termsState(client: Reader, companyId: string, userId: string): Promise<TermsState | null> {
  const inForce = await portalTermsInForce(client, companyId)
  if (!inForce) return null
  const ack = await client.partnerNoticeAck.findFirst({ where: { companyId, noticeId: inForce.id, userId }, select: { id: true } })
  return { noticeId: inForce.id, label: inForce.label, acknowledged: ack !== null }
}

/** The person's live PARTNER role assignments with their roles. */
export async function partnerRoles(client: Reader, userId: string, now: Date): Promise<PartnerRole[]> {
  const rows = await client.roleAssignment.findMany({
    where: { userId, ...liveAssignment(now), role: { audience: 'PARTNER' } },
    orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    select: { allCompanies: true, companyIds: true, role: { select: { permissions: true, grains: true } } },
  })
  return rows.map((row) => ({ permissions: row.role.permissions, grains: row.role.grains, allCompanies: row.allCompanies, companyIds: row.companyIds }))
}

// --- codes ------------------------------------------------------------------------------------------------------------------

export const CODE_SELECT = { id: true, userId: true, purpose: true, codeHash: true, linkTokenHash: true, createdAt: true, expiresAt: true, tries: true, usedAt: true, revokedAt: true } as const

/** The person's newest code of a purpose that is not replaced (live, used, tried out or expired), or null. */
export async function newestCode(client: Reader, userId: string, purpose: PortalSignInCodePurpose) {
  return client.portalSignInCode.findFirst({ where: { userId, purpose, revokedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: CODE_SELECT })
}

/** A code locked for this transaction (one check at a time per code: parallel guesses queue and see each other's tries). */
export async function lockedCode(tx: CommandTx, codeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "PortalSignInCode" WHERE "id" = ${codeId}::uuid FOR UPDATE`
  return tx.portalSignInCode.findUnique({ where: { id: codeId }, select: CODE_SELECT })
}

/**
 * A new code row from its hashes (a command's work): the person's row is locked, the live code of the purpose (expired or
 * not: the one-live partial index counts it) is replaced, the new one lives 15 minutes. The code itself never enters.
 */
export async function issueCode(
  tx: CommandTx,
  input: { readonly userId: string; readonly purpose: PortalSignInCodePurpose; readonly codeHash: string; readonly linkTokenHash: string | null; readonly now: Date; readonly ipHash: string | null },
): Promise<{ readonly id: string; readonly expiresAt: string; readonly replaced: number }> {
  await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${input.userId}::uuid FOR UPDATE`
  const { count: replaced } = await tx.portalSignInCode.updateMany({
    where: { userId: input.userId, purpose: input.purpose, usedAt: null, revokedAt: null, tries: { lt: PORTAL_CODE.maxTries } },
    data: { revokedAt: input.now },
  })
  const id = newId()
  const expiresAt = new Date(input.now.getTime() + PORTAL_CODE.ttlMs)
  await tx.portalSignInCode.create({
    data: { id, userId: input.userId, purpose: input.purpose, codeHash: input.codeHash, linkTokenHash: input.linkTokenHash, createdAt: input.now, expiresAt, ipHash: input.ipHash },
    select: { id: true },
  })
  return { id, expiresAt: toUtcIso(expiresAt), replaced }
}

// --- sessions ---------------------------------------------------------------------------------------------------------------

export interface StoredPortalSession {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly idleExpiresAt: string
  readonly absoluteExpiresAt: string
}

/** A new PARTNER session from its token's hash (a command's work, office scope): 30 minutes idle, 12 hours at most. */
export async function createPortalSession(
  tx: CommandTx,
  input: { readonly userId: string; readonly partyId: string; readonly companyId: string; readonly tokenHash: string; readonly now: Date; readonly ipHash: string | null; readonly userAgent: string | undefined },
): Promise<StoredPortalSession> {
  const id = newId()
  const absoluteExpiresAt = portalAbsoluteExpiryAt(input.now)
  const idleExpiresAt = portalIdleExpiryAt(input.now, absoluteExpiresAt)
  await tx.session.create({
    data: {
      id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      companyId: input.companyId,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt,
      absoluteExpiresAt,
      ipHash: input.ipHash,
      userAgent: input.userAgent?.slice(0, 256) ?? null,
      audience: 'PARTNER',
      partyId: input.partyId,
    },
    select: { id: true },
  })
  return { id, companyId: input.companyId, partyId: input.partyId, idleExpiresAt: toUtcIso(idleExpiresAt), absoluteExpiresAt: toUtcIso(absoluteExpiresAt) }
}
