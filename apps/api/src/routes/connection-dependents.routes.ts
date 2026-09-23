/**
 * `GET /api/admin/connection-dependents` — what a connection delete would take with it.
 *
 * **GET reads only.** DELETE below separately rechecks and locks one dead row. The report lets the Owner decide
 * whether deleting a dead connection is a tidy-up or a data loss, with the numbers in front of
 * them rather than an assurance.
 *
 * The Owner asked to delete 11 dead eBay rows. Two measurements said not yet:
 *
 *   - nothing in this API has ever deleted a `ChannelConnection` — every path revokes instead;
 *   - `VariantChannelListing` and `EbayCampaign` are `onDelete: Cascade`, so listings and ad
 *     campaigns are destroyed along with the row, and one of the eleven carries the same eBay
 *     user id as the live account and synced on 2026-08-19.
 *
 * "It says disconnected" is a fact about the token. It says nothing about what points at the row.
 */
import type { FastifyInstance } from 'fastify'
import { connectionDependentsReport, dependentRelations, deleteDeadConnection } from '../services/connection-dependents.service.js'

export default async function connectionDependentsRoutes(app: FastifyInstance) {
  // One explicit ID; never accept a caller's cached "safe" verdict or a channel-wide delete.
  app.delete<{ Params: { id: string } }>('/admin/connection-dependents/:id', async (req, reply) => {
    try {
      return reply.send(await deleteDeadConnection(req.params.id))
    } catch (err) {
      const failure = err as { statusCode?: number; code?: string; dependents?: unknown }
      return reply.code(failure.statusCode ?? 500).send({
        deleted: false, code: failure.code ?? 'connection_delete_failed',
        error: err instanceof Error ? err.message.slice(0, 400) : 'Connection deletion failed.',
        ...(failure.dependents ? { dependents: failure.dependents } : {}),
      })
    }
  })
  /**
   * `?channel=EBAY` narrows to one channel; omitted, it reports every connection in the
   * business profile the request carries.
   */
  app.get('/admin/connection-dependents', async (req, reply) => {
    const query = req.query as { channel?: string; connectionId?: string }
    try {
      return reply.send({
        ok: true,
        note: 'Read-only. Nothing was deleted, and this endpoint cannot delete.',
        /** Derived from the live schema, never a written-down list. */
        relationsChecked: dependentRelations().length,
        destroysOnDelete: dependentRelations().filter((r) => r.destroys).map((r) => r.model),
        connections: await connectionDependentsReport(query),
      })
    } catch (err: unknown) {
      return reply.code(500).send({
        ok: false,
        note: 'Read-only. Nothing was deleted.',
        error: err instanceof Error ? err.message.slice(0, 400) : String(err),
      })
    }
  })
}
