import type { FastifyInstance } from 'fastify'
import { InvalidListingIssueQuery, listingIssuesByConnection } from '../services/cx/listing-issues-view.service.js'

/** Existing /cx/connections integrations permission applies. This endpoint never probes a channel. */
export default async function cxListingIssuesRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { take?: string; after?: string; listingId?: string } }>('/cx/connections/:id/listing-issues', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const page = await listingIssuesByConnection(request.params.id, request.query)
      return page ? reply.send(page) : reply.code(404).send({ error: 'Connection not found.' })
    } catch (error) {
      if (error instanceof InvalidListingIssueQuery) return reply.code(400).send({ error: error.message })
      return reply.code(503).send({ code: 'listing_issues_unavailable', error: 'Saved listing issues are temporarily unavailable. Refresh to try again.' })
    }
  })
}
