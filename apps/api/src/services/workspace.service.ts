import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { BUSINESS_COUNTRIES } from '@nexus/shared/business-profile'
import { expandPermissions, isValidPermission, FEATURES } from '@nexus/shared/permissions'
import { WorkspaceError, withWorkspace, type WorkspaceContext } from '../lib/workspace-context.js'

const membershipSelect = {
  id: true, status: true, version: true, userId: true, createdAt: true,
  user: { select: { status: true } },
  workspace: { select: { id: true, name: true, status: true, version: true } },
  roles: { select: { role: { select: { id: true, key: true, name: true, permissions: true } } } },
} satisfies Prisma.WorkspaceMembershipSelect

type MembershipRow = Prisma.WorkspaceMembershipGetPayload<{ select: typeof membershipSelect }>
function profileSummary(row: MembershipRow) {
  return {
    ...row.workspace, membershipId: row.id, roleNames: row.roles.map(({ role }) => role.name),
    isOwner: row.roles.some(({ role }) => role.key === 'OWNER'),
    canConnectAccounts: row.roles.some(({ role }) => role.key === 'OWNER') || expandPermissions(row.roles.flatMap(({ role }) => role.permissions)).has(FEATURES.channelsConnect),
  }
}

export interface WorkspaceListQuery { q?: unknown; cursor?: unknown; limit?: unknown; status?: unknown; permission?: unknown }

export interface WorkspaceInput {
  name: string
  country: string
  currency: string
  timezone: string
  creationKey: string
}

export function validateWorkspaceInput(input: unknown): WorkspaceInput {
  if (!input || typeof input !== 'object') throw new WorkspaceError('invalid_profile', 'Business details are required.', 400)
  const row = input as Record<string, unknown>
  const string = (key: string) => typeof row[key] === 'string' ? (row[key] as string).trim() : ''
  const name = string('name')
  const country = string('country').toUpperCase()
  const currency = string('currency').toUpperCase()
  const timezone = string('timezone')
  const creationKey = string('creationKey')
  if (name.length < 2 || name.length > 80) throw new WorkspaceError('invalid_name', 'Use between 2 and 80 characters for the profile name.', 400)
  if (!BUSINESS_COUNTRIES.includes(country)) throw new WorkspaceError('invalid_country', 'Choose a country.', 400)
  if (!(Intl as typeof Intl & { supportedValuesOf(key: 'currency'): string[] }).supportedValuesOf('currency').includes(currency)) throw new WorkspaceError('invalid_currency', 'Choose a supported currency.', 400)
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format() }
  catch { throw new WorkspaceError('invalid_timezone', 'Choose a valid timezone.', 400) }
  if (!timezone) throw new WorkspaceError('invalid_timezone', 'Choose a timezone.', 400)
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(creationKey)) throw new WorkspaceError('invalid_creation_key', 'Start a new profile creation request.', 400)
  return { name, country, currency, timezone, creationKey }
}

/** All access is re-read from membership. Global login roles never grant business access. */
export function createWorkspaceService(db: PrismaClient) {
  async function membership(userId: string, workspaceId: string) {
    const row = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } }, select: membershipSelect,
    })
    if (!row || row.status !== 'active' || row.user.status !== 'active' || row.workspace.status !== 'active') {
      throw new WorkspaceError('workspace_unavailable', 'This business profile is unavailable or you no longer have access.')
    }
    const roleKeys = row.roles.map(({ role }) => role.key)
    const permissions = expandPermissions(row.roles.flatMap(({ role }) => role.permissions))
    return {
      ...row, roleKeys, permissions, isOwner: roleKeys.includes('OWNER'),
      context: { workspaceId, actorUserId: userId, membershipId: row.id, membershipVersion: row.version, roleKeys } satisfies WorkspaceContext,
    }
  }

  async function requireOwner(userId: string, workspaceId: string) {
    const access = await membership(userId, workspaceId)
    if (!access.isOwner) throw new WorkspaceError('workspace_owner_required', 'An owner of this business profile must make this change.')
    return access
  }

  async function list(userId: string, take?: number) {
    const rows = await db.workspaceMembership.findMany({
      where: { userId, status: 'active', user: { status: 'active' }, workspace: { status: 'active' } },
      select: membershipSelect, orderBy: { workspace: { createdAt: 'asc' } }, ...(take ? { take } : {}),
    })
    return rows.map(profileSummary)
  }

  async function listPage(userId: string, input: WorkspaceListQuery = {}) {
    const badQuery = () => new WorkspaceError('invalid_profile_query', 'Refresh the profile list and try again.', 400)
    if (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 80)) throw badQuery()
    const q = typeof input.q === 'string' ? input.q.trim() : ''
    const status = input.status ?? 'active'
    const permission = input.permission ?? ''
    if (typeof status !== 'string' || !['active', 'archived'].includes(status) || typeof permission !== 'string' || !['', 'connect', 'owner'].includes(permission)) throw badQuery()
    if (input.limit !== undefined && typeof input.limit !== 'string' && typeof input.limit !== 'number') throw badQuery()
    const limit = input.limit === undefined ? 24 : Number(input.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badQuery()
    const filter = JSON.stringify([q, status, permission])
    let after: { id: string; createdAt: Date } | undefined
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 800) throw badQuery()
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
        if (cursor.filter !== filter || typeof cursor.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(cursor.id) || typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at))) throw badQuery()
        after = { id: cursor.id, createdAt: new Date(cursor.at) }
      } catch { throw badQuery() }
    }
    const where: Prisma.WorkspaceMembershipWhereInput = {
      userId, status: 'active', user: { status: 'active' },
      workspace: { status: String(status), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      ...(status === 'archived' || permission === 'owner' ? { roles: { some: { role: { key: 'OWNER' } } } }
        : permission === 'connect' ? { roles: { some: { role: { OR: [{ key: 'OWNER' }, { permissions: { has: FEATURES.channelsConnect } }] } } } } : {}),
      ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
    }
    const rows = await db.workspaceMembership.findMany({ where, select: membershipSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return { workspaces: page.map(profileSummary), nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ id: last.id, at: last.createdAt.toISOString(), filter })).toString('base64url') : null }
  }

  async function create(userId: string, raw: unknown) {
    const input = validateWorkspaceInput(raw)
    const fingerprint = createHash('sha256').update(JSON.stringify([input.name, input.country, input.currency, input.timezone])).digest('hex')
    const existing = () => db.workspace.findUnique({
      where: { createdByUserId_creationKey: { createdByUserId: userId, creationKey: input.creationKey } },
      select: { id: true, name: true, status: true, creationFingerprint: true },
    })
    const replay = (row: NonNullable<Awaited<ReturnType<typeof existing>>>) => {
      if (row.status !== 'active' || row.creationFingerprint !== fingerprint) {
        throw new WorkspaceError('creation_conflict', 'This creation request was already used. Start a new request.', 409)
      }
      return { id: row.id, name: row.name }
    }
    const prior = await existing()
    if (prior) { await membership(userId, prior.id); return replay(prior) }
    try {
      const workspaceId = randomUUID()
      return await withWorkspace({ workspaceId, actorUserId: userId, membershipId: null, roleKeys: ['OWNER'] }, () => db.$transaction(async tx => {
        const user = await tx.userProfile.findUnique({ where: { id: userId }, select: { status: true } })
        if (user?.status !== 'active') throw new WorkspaceError('unauthenticated', 'Sign in to create a business profile.', 401)
        const owner = await tx.role.findUnique({ where: { key: 'OWNER' }, select: { id: true } })
        if (!owner) throw new WorkspaceError('roles_unavailable', 'Business profiles are temporarily unavailable.', 503)
        const workspace = await tx.workspace.create({
          data: { id: workspaceId, name: input.name, createdByUserId: userId, creationKey: input.creationKey, creationFingerprint: fingerprint },
          select: { id: true, name: true },
        })
        await tx.workspaceMembership.create({ data: { workspaceId, userId, roles: { create: { roleId: owner.id } } } })
        await tx.accountSettings.create({ data: { workspaceId, businessName: input.name, country: input.country, currency: input.currency, timezone: input.timezone } })
        const warehouse = await tx.warehouse.create({ data: { code: `${input.country}-MAIN`, name: 'Main warehouse', country: input.country, isDefault: true, kind: 'PRIMARY' } })
        await tx.stockLocation.create({ data: { code: warehouse.code, name: warehouse.name, type: 'WAREHOUSE', warehouseId: warehouse.id } })
        await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'workspace.created' } })
        return workspace
      }))
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const row = await existing()
      if (!row) throw error
      await membership(userId, row.id)
      return replay(row)
    }
  }

  async function rename(userId: string, workspaceId: string, name: unknown, version: unknown) {
    await requireOwner(userId, workspaceId)
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) throw new WorkspaceError('invalid_name', 'Use between 2 and 80 characters for the profile name.', 400)
    if (!Number.isInteger(version) || Number(version) < 1) throw new WorkspaceError('invalid_version', 'Refresh this profile before saving.', 400)
    return db.$transaction(async tx => {
      const updated = await tx.workspace.updateMany({
        where: { id: workspaceId, status: 'active', version: Number(version), memberships: { some: { userId, status: 'active', user: { status: 'active' }, workspace: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } } },
        data: { name: name.trim(), version: { increment: 1 } },
      })
      if (updated.count !== 1) throw new WorkspaceError('profile_changed', 'This profile changed or your access was removed. Refresh before saving.', 409)
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'workspace.renamed', metadata: { name: name.trim() } } })
      return { id: workspaceId, name: name.trim(), version: Number(version) + 1 }
    })
  }

  async function changeMember(userId: string, workspaceId: string, memberId: string, raw: unknown) {
    if (!raw || typeof raw !== 'object') throw new WorkspaceError('invalid_membership', 'Membership details are required.', 400)
    const input = raw as { roleIds: string[]; status: 'active' | 'revoked'; version: number }
    await requireOwner(userId, workspaceId)
    if (!Number.isInteger(input.version) || input.version < 1 || !Array.isArray(input.roleIds) || input.roleIds.length < 1 || input.roleIds.length > 20 || input.roleIds.some(id => typeof id !== 'string')) throw new WorkspaceError('invalid_membership', 'Choose roles and refresh the member before saving.', 400)
    if (input.status !== 'active' && input.status !== 'revoked') throw new WorkspaceError('invalid_membership', 'Choose a valid membership status.', 400)
    return db.$transaction(async tx => {
      // Serialize membership edits so concurrent requests cannot both remove the last owner.
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const actor = await tx.workspaceMembership.findFirst({ where: { workspaceId, userId, status: 'active', user: { status: 'active' }, workspace: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
      if (!actor) throw new WorkspaceError('workspace_owner_required', 'Owner access has changed. Refresh this profile.')
      const target = await tx.workspaceMembership.findFirst({ where: { id: memberId, workspaceId, version: input.version }, include: { roles: { include: { role: true } } } })
      if (!target) throw new WorkspaceError('membership_changed', 'This membership changed. Refresh before saving.', 409)
      const roles = await tx.role.findMany({ where: { id: { in: [...new Set(input.roleIds)] }, OR: [{ isSystem: true, workspaceId: null }, { workspaceId }] }, select: { id: true, key: true } })
      if (roles.length !== new Set(input.roleIds).size) throw new WorkspaceError('invalid_roles', 'Choose valid business roles.', 400)
      const removesOwner = target.status === 'active' && target.roles.some(({ role }) => role.key === 'OWNER') && (input.status !== 'active' || !roles.some(role => role.key === 'OWNER'))
      if (removesOwner) {
        const owners = await tx.workspaceMembership.count({ where: { workspaceId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
        if (owners <= 1) throw new WorkspaceError('last_owner', 'Add another owner before removing this owner.', 409)
      }
      await tx.workspaceMemberRole.deleteMany({ where: { membershipId: target.id } })
      await tx.workspaceMembership.update({ where: { id: target.id }, data: { status: input.status, version: { increment: 1 }, roles: { create: roles.map(role => ({ roleId: role.id })) } } })
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'membership.updated', targetId: target.id, metadata: { status: input.status, roleIds: roles.map(role => role.id) } } })
      return { ok: true }
    })
  }

  async function listMembers(userId: string, workspaceId: string) {
    await requireOwner(userId, workspaceId)
    const members = await db.workspaceMembership.findMany({
      where: { workspaceId: workspaceId }, orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, version: true, user: { select: { displayName: true, email: true } }, roles: { select: { role: { select: { id: true, name: true, key: true } } } } },
    })
    const roles = await db.role.findMany({ where: { OR: [{ isSystem: true, workspaceId: null }, { workspaceId }] }, select: { id: true, name: true, key: true, permissions: true, isSystem: true, version: true, description: true }, orderBy: { name: 'asc' } })
    const invitations = await db.workspaceInvitation.findMany({ where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, roleIds: true, expiresAt: true }, orderBy: { createdAt: 'desc' } })
    return { members, roles, invitations }
  }

  async function invite(userId: string, workspaceId: string, raw: unknown) {
    await requireOwner(userId, workspaceId)
    const input = raw as { email?: unknown; roleIds?: unknown }
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new WorkspaceError('invalid_email', 'Enter a valid email address.', 400)
    if (!Array.isArray(input.roleIds) || input.roleIds.length < 1 || input.roleIds.length > 20 || input.roleIds.some(id => typeof id !== 'string')) throw new WorkspaceError('invalid_roles', 'Choose at least one business role.', 400)
    const roleIds = [...new Set(input.roleIds as string[])]
    const token = randomBytes(32).toString('base64url')
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const actor = await tx.workspaceMembership.findFirst({ where: { workspaceId, userId, status: 'active', workspace: { status: 'active' }, user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
      if (!actor) throw new WorkspaceError('workspace_owner_required', 'Owner access has changed. Refresh this profile.')
      const roles = await tx.role.count({ where: { id: { in: roleIds }, OR: [{ isSystem: true, workspaceId: null }, { workspaceId }] } })
      if (roles !== roleIds.length) throw new WorkspaceError('invalid_roles', 'Choose valid business roles.', 400)
      const existing = await tx.workspaceMembership.findFirst({ where: { workspaceId, status: 'active', user: { email } } })
      if (existing) throw new WorkspaceError('already_member', 'This person already belongs to the business profile.', 409)
      await tx.workspaceInvitation.updateMany({ where: { workspaceId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
      const invitation = await tx.workspaceInvitation.create({ data: { workspaceId, email, roleIds, tokenHash: createHash('sha256').update(token).digest('hex'), invitedByUserId: userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, select: { id: true, email: true, expiresAt: true } })
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'invitation.created', targetId: invitation.id, metadata: { email, roleIds } } })
      return { invitation, token }
    })
  }

  async function previewInvitation(token: unknown) {
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new WorkspaceError('invalid_invitation', 'This invitation is invalid or has expired.', 404)
    const row = await db.workspaceInvitation.findUnique({ where: { tokenHash: createHash('sha256').update(token).digest('hex') }, include: { workspace: { select: { name: true, status: true } } } })
    if (!row || row.acceptedAt || row.revokedAt || row.expiresAt <= new Date() || row.workspace.status !== 'active') throw new WorkspaceError('invalid_invitation', 'This invitation is invalid or has expired.', 404)
    return row
  }

  async function invitationPreview(token: unknown) {
    const invitation = await previewInvitation(token)
    const roles = await db.role.findMany({ where: { id: { in: invitation.roleIds } }, select: { name: true } })
    const existing = await db.userProfile.findUnique({ where: { email: invitation.email }, select: { id: true } })
    return { email: invitation.email, name: invitation.workspace.name, roleNames: roles.map(role => role.name), expiresAt: invitation.expiresAt, signInRequired: !!existing }
  }

  async function acceptInvitation(userId: string | null, token: unknown, registration?: { displayName: string; passwordHash: string }) {
    const invitation = await previewInvitation(token)
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${invitation.workspaceId} FOR UPDATE`
      const inviter = await tx.workspaceMembership.findFirst({ where: { workspaceId: invitation.workspaceId, userId: invitation.invitedByUserId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
      if (!inviter) throw new WorkspaceError('invalid_invitation', 'Ask a current owner for a new invitation.', 409)
      if (!userId) {
        const exists = await tx.userProfile.findUnique({ where: { email: invitation.email }, select: { id: true } })
        if (exists || !registration) throw new WorkspaceError('sign_in_required', 'Sign in with the invited email address to accept this invitation.', 401)
        const created = await tx.userProfile.create({ data: { email: invitation.email, displayName: registration.displayName, passwordHash: registration.passwordHash, status: 'active' } })
        userId = created.id
      }
      const user = await tx.userProfile.findUnique({ where: { id: userId }, select: { email: true, status: true } })
      if (!user || user.status !== 'active' || user.email.toLowerCase() !== invitation.email) throw new WorkspaceError('invitation_email_mismatch', 'Sign in with the email address this invitation was sent to.')
      const consumed = await tx.workspaceInvitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, workspace: { status: 'active' } }, data: { acceptedAt: new Date() } })
      if (consumed.count !== 1) throw new WorkspaceError('invalid_invitation', 'This invitation is invalid or has expired.', 409)
      const roles = await tx.role.count({ where: { id: { in: invitation.roleIds }, OR: [{ isSystem: true, workspaceId: null }, { workspaceId: invitation.workspaceId }] } })
      if (roles !== invitation.roleIds.length) throw new WorkspaceError('invalid_roles', 'The invitation’s roles have changed. Ask the owner for a new invitation.', 409)
      const existing = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } } })
      if (!existing || existing.status !== 'active') {
        if (existing) await tx.workspaceMemberRole.deleteMany({ where: { membershipId: existing.id } })
        await tx.workspaceMembership.upsert({ where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } }, create: { workspaceId: invitation.workspaceId, userId, roles: { create: invitation.roleIds.map(roleId => ({ roleId })) } }, update: { status: 'active', version: { increment: 1 }, roles: { create: invitation.roleIds.map(roleId => ({ roleId })) } } })
      }
      await tx.workspaceAudit.create({ data: { workspaceId: invitation.workspaceId, actorUserId: userId, action: 'invitation.accepted', targetId: invitation.id } })
      return { workspaceId: invitation.workspaceId, userId }
    })
  }

  async function revokeInvitation(userId: string, workspaceId: string, id: string) {
    await requireOwner(userId, workspaceId)
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const actor = await tx.workspaceMembership.findFirst({ where: { workspaceId, userId, status: 'active', user: { status: 'active' }, workspace: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
      if (!actor) throw new WorkspaceError('workspace_owner_required', 'Owner access has changed. Refresh this profile.')
      const result = await tx.workspaceInvitation.updateMany({ where: { id, workspaceId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
      if (result.count !== 1) throw new WorkspaceError('invitation_changed', 'This invitation changed. Refresh the team.', 409)
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'invitation.revoked', targetId: id } })
    })
    return { ok: true }
  }

  async function archive(userId: string, workspaceId: string, raw: unknown) {
    const access = await requireOwner(userId, workspaceId)
    const input = raw as { name?: unknown; version?: unknown }
    if (input?.name !== access.workspace.name || input.version !== access.workspace.version) throw new WorkspaceError('archive_confirmation', 'Enter the current profile name to archive it.', 409)
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const result = await tx.workspace.updateMany({ where: { id: workspaceId, status: 'active', version: access.workspace.version, memberships: { some: { userId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } } }, data: { status: 'archived', archivedAt: new Date(), version: { increment: 1 } } })
      if (result.count !== 1) throw new WorkspaceError('profile_changed', 'This profile changed. Refresh before archiving.', 409)
      await tx.workspaceInvitation.updateMany({ where: { workspaceId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } })
      await tx.oAuthSession.updateMany({ where: { workspaceId, consumedAt: null }, data: { consumedAt: new Date(), error: 'workspace_archived' } })
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'workspace.archived' } })
      return { ok: true }
    })
  }

  async function saveRole(userId: string, workspaceId: string, raw: unknown, roleId?: string) {
    await requireOwner(userId, workspaceId)
    const input = raw as { name?: unknown; description?: unknown; permissions?: unknown; version?: unknown }
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const description = typeof input?.description === 'string' ? input.description.trim() : ''
    if (name.length < 2 || name.length > 80 || description.length > 500) throw new WorkspaceError('invalid_role', 'Use a role name between 2 and 80 characters and a description under 500 characters.', 400)
    if (!Array.isArray(input.permissions) || input.permissions.length > 500 || input.permissions.some(permission => typeof permission !== 'string' || !isValidPermission(permission))) throw new WorkspaceError('invalid_permissions', 'Choose valid permissions.', 400)
    const permissions = [...new Set(input.permissions as string[])]
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const actor = await tx.workspaceMembership.findFirst({ where: { workspaceId, userId, status: 'active', user: { status: 'active' }, workspace: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } })
      if (!actor) throw new WorkspaceError('workspace_owner_required', 'Owner access has changed. Refresh this profile.')
      let id = roleId
      if (id) {
        if (!Number.isInteger(input.version)) throw new WorkspaceError('invalid_version', 'Refresh this role before saving.', 409)
        const updated = await tx.role.updateMany({ where: { id, workspaceId, isSystem: false, version: Number(input.version) }, data: { name, description, permissions, version: { increment: 1 } } })
        if (updated.count !== 1) throw new WorkspaceError('role_changed', 'This role changed or cannot be edited. Refresh before saving.', 409)
      } else {
        const role = await tx.role.create({ data: { workspaceId, key: `business_${randomUUID()}`, name, description, permissions } })
        id = role.id
      }
      // Membership versions also invalidate work queued under the previous role definition.
      await tx.workspaceMembership.updateMany({ where: { workspaceId, roles: { some: { roleId: id } } }, data: { version: { increment: 1 } } })
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: roleId ? 'role.updated' : 'role.created', targetId: id, metadata: { name, permissions } } })
      return { id }
    })
  }

  async function archived(userId: string) {
    const rows = await db.workspaceMembership.findMany({ where: { userId, status: 'active', user: { status: 'active' }, workspace: { status: 'archived' }, roles: { some: { role: { key: 'OWNER' } } } }, select: membershipSelect, orderBy: { workspace: { archivedAt: 'desc' } } })
    return rows.map(row => ({ ...row.workspace, membershipId: row.id, roleNames: row.roles.map(({ role }) => role.name), isOwner: true }))
  }

  async function restore(userId: string, workspaceId: string, raw: unknown) {
    const input = raw as { name?: unknown; version?: unknown }
    if (!input || typeof input.name !== 'string' || !Number.isInteger(input.version)) throw new WorkspaceError('restore_confirmation', 'Confirm the current profile name before restoring.', 400)
    return db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      const result = await tx.workspace.updateMany({ where: { id: workspaceId, status: 'archived', name: input.name, version: Number(input.version), memberships: { some: { userId, status: 'active', user: { status: 'active' }, roles: { some: { role: { key: 'OWNER' } } } } } }, data: { status: 'active', archivedAt: null, version: { increment: 1 } } })
      if (result.count !== 1) throw new WorkspaceError('profile_changed', 'This profile changed or owner access is unavailable. Refresh before restoring.', 409)
      await tx.workspace.update({ where: { id: workspaceId }, data: { automationResumedAt: new Date() } })
      await tx.workspaceAudit.create({ data: { workspaceId, actorUserId: userId, action: 'workspace.restored' } })
      return { ok: true }
    })
  }

  async function assignAccount(userId: string, workspaceId: string, accountId: string, raw: unknown, commit = false) {
    const input = raw as { destinationId?: unknown; version?: unknown }
    if (!input || typeof input.destinationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.destinationId)
      || (commit && (typeof input.version !== 'string' || !/^[a-f0-9]{32}$/.test(input.version)))) {
      throw new WorkspaceError('invalid_assignment', 'Choose a destination and review the assignment before saving.', 400)
    }
    const access = await requireOwner(userId, workspaceId)
    const destination = input.destinationId
    const version = commit ? input.version as string : null
    const rows = await withWorkspace(access.context, () => db.$queryRaw<Array<{ result: Record<string, unknown> }>>`
      SELECT nexus_assign_channel_account(${accountId}::text, ${destination}::text, ${version}::text) AS result`)
    const result = rows[0]?.result
    if (!result) throw new Error('Account assignment returned no result')
    if (result.error) throw new WorkspaceError(String(result.code), String(result.error), Number(result.status) || 409)
    return result
  }

  return { list, listPage, profileSummary, membership, requireOwner, create, rename, changeMember, listMembers, invite, previewInvitation, invitationPreview, acceptInvitation, revokeInvitation, archive, restore, archived, saveRole, assignAccount }
}
