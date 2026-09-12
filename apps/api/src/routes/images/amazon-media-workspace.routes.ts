import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'
import { amazonMediaDestination, copyAmazonMarketGallery, listAmazonMediaDestinations, readAmazonMedia, refreshAmazonMedia, saveAmazonMedia } from '../../services/images/amazon-media-workspace.service.js'
import { approveAmazonMediaRun, createAmazonMediaReview, processAmazonMediaRun, readAmazonMediaRun } from '../../services/images/amazon-media-publish.service.js'
import { exportAmazonSafetyImages } from '../../services/images/amazon-media-safety-export.service.js'

const querySchema = z.object({ market: z.string().min(1), accountId: z.string().min(1), listingId: z.string().min(1).optional() })
const revisionSchema = z.object({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/) })
type Request = { Params: { productId: string; runId?: string }; Querystring: unknown; Body: unknown }
export const amazonMediaWorkspaceRoutes: FastifyPluginAsync = async app => {
  const base = '/products/:productId/images-workspace/amazon'
  for (const [method, suffix] of [['GET', ''], ['GET', '/destinations'], ['PUT', ''], ['POST', '/refresh'], ['POST', '/copy-market'], ['POST', '/safety-export'], ['POST', '/review'], ['GET', '/runs/:runId'], ['POST', '/runs/:runId/publish']] as const) {
    app.route<Request>({ method, url: base + suffix, handler: async (request, reply) => {
      try {
        const query = querySchema.parse(request.query)
        if (suffix === '/destinations') return await listAmazonMediaDestinations({ productId: request.params.productId, ...query })
        const destination = await amazonMediaDestination({ productId: request.params.productId, ...query })
        if (method === 'GET') return await (suffix ? readAmazonMediaRun(destination, request.params.runId!) : readAmazonMedia(destination))
        const { expectedRevision } = revisionSchema.parse(request.body)
        if (suffix === '/safety-export') {
          const result = await exportAmazonSafetyImages(destination, expectedRevision, z.object({ listingIds: z.array(z.string()).min(1).max(200) }).parse(request.body).listingIds)
          return reply.header('Cache-Control', 'no-store').header('Content-Disposition', `attachment; filename="${result.filename}"`).header('X-Image-Count', result.fileCount).type('application/zip').send(result.buffer)
        }
        if (method === 'PUT') return await saveAmazonMedia(destination, expectedRevision, (request.body as { draft?: unknown }).draft)
        if (suffix === '/refresh') return await refreshAmazonMedia(destination, expectedRevision)
        if (suffix === '/copy-market') return await copyAmazonMarketGallery(destination, expectedRevision, z.object({ sourceMarket: z.string().min(1), sourceListingId: z.string().min(1), sourceGalleryId: z.string().min(1), sourceRevision: z.string().min(1), targetGalleryId: z.string().min(1), section: z.enum(['gallery', 'safety', 'all']).optional() }).parse(request.body))
        const run = suffix === '/review'
          ? await createAmazonMediaReview(destination, expectedRevision, z.object({ listingIds: z.array(z.string()).min(1).max(200) }).parse(request.body).listingIds, request.authUser?.id ?? null)
          : await approveAmazonMediaRun(destination, request.params.runId!, expectedRevision)
        // Durable queue record exists first. The periodic worker also discovers
        // queued runs if this process exits before dispatch.
        setImmediate(() => { void processAmazonMediaRun(run.id).catch(error => request.log.error({ err: error, runId: run.id }, 'Amazon media worker failed')) })
        return reply.code(202).send(run)
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'A valid destination and observed revision are required.' })
        request.log.error({ err: error }, 'Amazon media request failed')
        return reply.code(500).send({ error: method === 'GET' ? 'Amazon media could not be loaded. Please retry.' : 'The request result could not be confirmed. Reload the saved gallery and its publication receipt before retrying.' })
      }
    } })
  }
}
