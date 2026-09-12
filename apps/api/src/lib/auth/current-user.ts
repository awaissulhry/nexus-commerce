import prisma from '../../db.js'
import { workspaceContext, WorkspaceError } from '../workspace-context.js'
import { authenticatedUserId } from './identity-context.js'

/** Legacy singleton compatibility ends at the multi-profile rollout boundary. */
export async function currentProfileUser() {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return prisma.userProfile.findFirst()
  const id = authenticatedUserId() ?? workspaceContext()?.actorUserId
  if (!id) throw new WorkspaceError('unauthenticated', 'Sign in to manage your personal settings.', 401)
  return prisma.userProfile.findUniqueOrThrow({ where: { id } })
}
