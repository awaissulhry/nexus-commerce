import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { closeDayContract, downloadManifestContract, endOfDayContract, getManifestContract, previewSheetContract } from './contract'
import { closeDay, downloadManifestPdf, endOfDay, getManifest, previewSheetPdf } from './day'
import { manifest } from './manifest'

/**
 * The day's close (B-W2b-395; LOG-049): End of day per carrier, the sheet's preview PDF, the close (with its print jobs), one
 * sheet and its PDF. The system closes what is left open after the site's day ended (close-days.ts, a cron).
 */
export default defineRoutes('shipping.manifest', manifest, async (app) => {
  app.get('/shipping/end-of-day', { schema: endOfDayContract }, async (request) => endOfDay(request, request.query))

  app.get('/shipping/end-of-day/preview', { schema: previewSheetContract }, async (request, reply) => {
    const { pdf, fileName } = await previewSheetPdf(request, request.query)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/shipping/end-of-day/close', { schema: closeDayContract }, async (request) => closeDay(processFiles(), request, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/manifests/:manifestId', { schema: getManifestContract }, async (request) => getManifest(request, request.params.manifestId))

  app.get('/shipping/manifests/:manifestId/pdf', { schema: downloadManifestContract }, async (request) => downloadManifestPdf(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.manifestId))
})
