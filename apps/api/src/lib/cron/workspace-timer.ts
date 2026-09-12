import { workspaceContext, requireWorkspace } from '../workspace-context.js'
import { runWorkspaceTick } from './workspace-lease.js'
import { logger } from '../../utils/logger.js'

/** Legacy interval workers use the same ownership and leases as cron schedules. */
export async function runProfileTimer(name: string, work: () => Promise<unknown>, periodMs = 60_000): Promise<void> {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1' || workspaceContext()) { await work(); return }
  const { visitActiveWorkspaces } = await import('../workspace-sweep.js')
  const { redis } = await import('../queue.js')
  const scheduledAt = Date.now()
  try {
    await visitActiveWorkspaces(async () => {
      const id = requireWorkspace().workspaceId
      try { await runWorkspaceTick(redis.connection, `timer:${name}:workspace:${id}`, scheduledAt, async () => { await work() }, periodMs) }
      catch (error) { logger.error('business interval failed', { name, workspaceId: id, error: String(error) }) }
    })
  } catch (error) {
    logger.error('business interval sweep failed; the next scheduled tick will retry', { name, error: String(error) })
  }
}
