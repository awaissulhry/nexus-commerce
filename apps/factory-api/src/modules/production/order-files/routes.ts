import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { openOrderFileContract, orderFilesContract } from './contract'
import { manifest } from './manifest'
import { openOrderFile } from './open'
import { orderFilesView, readOrderFiles } from './read'

/**
 * B-PR-44 (production plan L16, N1; F-PR-25 "Order files (n)" and "Order thread" on the work order band): the files of the orders
 * a work order makes, grouped by order (./read.ts), and the walled opening of one (./open.ts). Nobody re-types a measurement:
 * the order's own files and the made-to-measure worksheet are the source.
 */
export default defineRoutes('production.order-files', manifest, async (app) => {
  app.get('/production/work-orders/:workOrderId/order-files', { schema: orderFilesContract }, async (request) => orderFilesView(await readOrderFiles(request, request.params.workOrderId)))

  app.post('/production/work-orders/:workOrderId/order-files/:fileId/open', { schema: openOrderFileContract }, async (request) =>
    openOrderFile(request, request.params.workOrderId, request.params.fileId, request.body, idempotencyKeyFrom(request)),
  )
})
