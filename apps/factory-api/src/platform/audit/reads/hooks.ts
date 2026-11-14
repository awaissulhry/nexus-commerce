import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { newId } from '@nexus/factory-domain/core/ids'
import { databaseNow } from '../security-events/record'
import { READ_ROUTES } from './registry'
import { readLogOn } from './switch'

/**
 * The read log's hook (B-W2b-399; PLT-074; Owner answer W2b-6 question 3 = A), installed on the root by core/app.ts: when a
 * route of reads/registry.ts answers an office person with success, one ReadLog row per record the answer shows is written
 * BEFORE the answer leaves (an `onSend` hook): no sensitive read goes out without its row, and a row that cannot be written
 * turns the answer into an error rather than an unlogged read. Office sessions only (the database keeps an office person's
 * reads; the floor, the portal and links never open these records). Written straight into the ledger in the caller's own
 * scope, not through command(): the row IS the audit of a read, and an audit row per read would put every view into the
 * record's history. The time is the database's own (security-events/record.ts databaseNow). Behind THE SWITCH (switch.ts).
 */

/** The read log rows of one answer. */
async function logReadsOf(request: FastifyRequest, reply: FastifyReply): Promise<number> {
  const context = request.factoryContext
  if (!context || context.audience !== 'office' || reply.statusCode < 200 || reply.statusCode >= 300) return 0
  const route = READ_ROUTES[`${request.method} ${request.routeOptions.url ?? ''}`]
  if (!route || !readLogOn()) return 0
  return request.withClient(async (client) => {
    const targets = await route.targets(request.params as Record<string, string | undefined>, client)
    if (targets.length === 0) return 0
    const at = await databaseNow(client)
    const { count } = await client.readLog.createMany({
      data: targets.map((target) => ({ id: newId(), userId: context.actorId, recordType: target.recordType, recordId: target.recordId, action: route.action, surface: 'OFFICE' as const, at })),
    })
    return count
  })
}

export function installReadLog(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    await logReadsOf(request, reply)
    return payload
  })
}
