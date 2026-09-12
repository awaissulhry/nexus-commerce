import 'server-only'
import { createHash } from 'node:crypto'
import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { Pool } from 'pg'
import { expandPermissions } from '@nexus/shared/permissions'
import { registerWorkspaceResolver } from '@nexus/database/workspace-adapter'
import { WorkspaceError, type WorkspaceContext } from '@nexus/database/workspace-context'
import { navPagePermission, settingsNavPermission } from '../auth/nav-permissions'
import { getBackendUrl } from '../backend-url'
import { prisma } from '@nexus/database'
import { isIdentityPath } from './paths'

// Control reads only: sessions, users and memberships. Business data always uses scopedPrisma.
const control = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 30_000, idleTimeoutMillis: 10_000 })
control.on('error', () => { console.warn('[profiles] An idle authentication connection was closed.') })
async function controlRead<T extends import('pg').QueryResultRow>(sql: string, values: unknown[]) {
  try { return await control.query<T>(sql, values) }
  catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code !== 'ECONNRESET' && code !== 'EPIPE' && !code.startsWith('08')) throw error
    return control.query<T>(sql, values)
  }
}
export const currentWebUser = cache(async () => {
  const jar = await cookies()
  const token = jar.get('__Host-nexus_session')?.value ?? jar.get('nexus_session')?.value
  if (!token) throw new WorkspaceError('unauthenticated', 'Sign in to continue.', 401)
  const hash = createHash('sha256').update(token).digest('hex')
  const result = await controlRead<{ id: string; email: string; mfaRequired: boolean; mfaSatisfied: boolean; twoFactorEnabledAt: Date | null }>(`
    SELECT u.id, u.email, u."mfaRequired", u."twoFactorEnabledAt", s."mfaSatisfied"
    FROM "UserSession" s JOIN "UserProfile" u ON u.id = s."userId"
    WHERE s."sessionTokenHash" = $1 AND s."revokedAt" IS NULL AND u.status = 'active'
      AND (s."idleExpiry" IS NULL OR s."idleExpiry" > NOW())
      AND (s."absoluteExpiry" IS NULL OR s."absoluteExpiry" > NOW())`, [hash])
  const user = result.rows[0]
  if (!user) throw new WorkspaceError('unauthenticated', 'Sign in to continue.', 401)
  return user
})

export async function currentWebProfile() {
  if (process.env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return prisma.userProfile.findFirst()
  const user = await currentWebUser()
  return prisma.userProfile.findUniqueOrThrow({ where: { id: user.id } })
}

type WebWorkspace = WorkspaceContext & { permissions: Set<string>; isOwner: boolean }
const webWorkspace = cache(async (): Promise<WebWorkspace | undefined> => {
  const incoming = await headers()
  const workspaceId = incoming.get('x-nexus-page-workspace') ?? incoming.get('x-nexus-workspace-id')
  if (!workspaceId) return undefined // identity-only pages never query business tables
  const user = await currentWebUser()
  if ((user.mfaRequired || user.twoFactorEnabledAt) && !user.mfaSatisfied) throw new WorkspaceError('mfa_required', 'Complete two-factor authentication.', 403)
  const result = await controlRead<{ id: string; roleKeys: string[]; permissions: string[] }>(`
    SELECT m.id, COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS "roleKeys",
      COALESCE(array_agg(DISTINCT p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions
    FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id = m."workspaceId"
    LEFT JOIN "WorkspaceMemberRole" mr ON mr."membershipId" = m.id
    LEFT JOIN "Role" r ON r.id = mr."roleId"
    LEFT JOIN LATERAL unnest(r.permissions) p(permission) ON TRUE
    WHERE m."workspaceId" = $1 AND m."userId" = $2 AND m.status = 'active' AND w.status = 'active'
    GROUP BY m.id`, [workspaceId, user.id])
  const member = result.rows[0]
  if (!member) throw new WorkspaceError('workspace_unavailable', 'This business profile is unavailable or you no longer have access.')
  const path = incoming.get('x-nexus-page-path') ?? ''
  const permissions = expandPermissions(member.permissions)
  const owner = member.roleKeys.includes('OWNER')
  const needed = settingsNavPermission(path) ?? navPagePermission(path)
  if (!owner && needed && !permissions.has(needed)) throw new WorkspaceError('forbidden', 'You do not have permission to open this page.')
  return { workspaceId, actorUserId: user.id, membershipId: member.id, roleKeys: member.roleKeys, permissions, isOwner: owner }
})

export async function requireWebPermission(permission: string) {
  if (process.env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return
  const access = await webWorkspace()
  if (!access || (!access.isOwner && !access.permissions.has(permission))) throw new WorkspaceError('forbidden', 'You do not have permission to make this change.')
}

export async function requireWebPage() {
  if (process.env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return
  const incoming = await headers()
  const path = incoming.get('x-nexus-page-path') ?? '/'
  if (isIdentityPath(path) && path !== '/profiles' && !path.startsWith('/settings/')) return
  try { await currentWebUser() }
  catch (error) {
    if (!(error instanceof WorkspaceError) || error.statusCode !== 401) throw error
    redirect(`/login?next=${encodeURIComponent(path)}`)
  }
  try { await webWorkspace() }
  catch (error) {
    if (!(error instanceof WorkspaceError)) throw error
    if (error.code === 'workspace_unavailable') redirect('/profiles?unavailable=1')
    redirect('/403')
  }
}

export function installWebWorkspaceRuntime() {
  if (process.env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return
  // Both applications must enforce the same rollout state; never allow unscoped SSR data.
  process.env.NEXUS_WORKSPACES_ENABLED = '1'
  registerWorkspaceResolver(webWorkspace)
  const runtime = globalThis as typeof globalThis & { nexusWorkspaceFetchInstalled?: boolean }
  if (runtime.nexusWorkspaceFetchInstalled) return
  runtime.nexusWorkspaceFetchInstalled = true
  const original = globalThis.fetch
  const backendOrigin = new URL(getBackendUrl()).origin
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== backendOrigin || !url.pathname.startsWith('/api/')) return original(input, init)
    const incoming = await headers()
    const outgoing = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!outgoing.has('cookie') && incoming.has('cookie')) outgoing.set('cookie', incoming.get('cookie')!)
    if (incoming.has('origin') && !outgoing.has('origin')) outgoing.set('origin', incoming.get('origin')!)
    const jar = await cookies()
    if (!outgoing.has('x-nexus-csrf') && jar.get('nexus_csrf')?.value) outgoing.set('x-nexus-csrf', jar.get('nexus_csrf')!.value)
    const id = incoming.get('x-nexus-page-workspace') ?? incoming.get('x-nexus-workspace-id')
    if (id && !outgoing.has('x-nexus-workspace-id')) outgoing.set('x-nexus-workspace-id', id)
    return original(input, { ...init, headers: outgoing, cache: 'no-store', next: { revalidate: 0 } } as RequestInit)
  }
}
