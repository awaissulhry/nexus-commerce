import prisma from '../db.js'
import { workspaceContext, withWorkspace } from './workspace-context.js'

/** Bounded iteration for process-wide services. Request-triggered work retains its profile. */
export async function visitActiveWorkspaces(work: () => Promise<void>) {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1' || workspaceContext()) { await work(); return }
  let after: string | undefined
  do {
    const rows = await prisma.workspace.findMany({ where: { status: 'active' }, select: { id: true }, orderBy: { id: 'asc' }, take: 50, ...(after ? { cursor: { id: after }, skip: 1 } : {}) })
    for (const row of rows) await withWorkspace({ workspaceId: row.id, actorUserId: null, membershipId: null, roleKeys: [] }, work)
    after = rows.length === 50 ? rows[rows.length - 1].id : undefined
  } while (after)
}
