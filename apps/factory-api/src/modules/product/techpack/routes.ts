import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../../production/work-orders/traveller'
import { makePdfContract, scanContract, techPackContract, versionPdfContract, versionsContract } from './contract'
import { makeTechPackPdf, techPackVersionPdf, techPackVersions } from './documents'
import { manifest } from './manifest'
import { scanTechPack } from './scan'
import { techPackFor } from './techpack'

/**
 * The tech pack of a style revision (product module, B-W2b-230; features PRD-130 live tech pack, PRD-131 the PDF for workshops
 * and brands, PRD-133 per audience, PRD-134 construction details, PRD-136 labels and packaging, PRD-138 the QR to the current
 * version, PRD-147 the protection and performance spec): the live view by section for an audience (techpack.ts), its PDF as a
 * generated document with a QR on every page (documents.ts, pdf.ts), and the check of a scanned page (scan.ts).
 */
export default defineRoutes('product.techpack', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/tech-pack', { schema: techPackContract }, async (request) => ({
    techPack: await techPackFor(request, request.params.styleId, request.params.revisionId, request.query),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/tech-pack/pdf', { schema: makePdfContract }, async (request, reply) => {
    const { status, pdf } = await makeTechPackPdf(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request))
    return reply.code(status).send({ pdf })
  })

  app.get('/product/styles/:styleId/revisions/:revisionId/tech-pack/versions', { schema: versionsContract }, async (request) => techPackVersions(request, request.params.styleId, request.params.revisionId))

  app.get('/product/styles/:styleId/revisions/:revisionId/tech-pack/versions/:documentId/pdf', { schema: versionPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await techPackVersionPdf(request, request.params.styleId, request.params.revisionId, request.params.documentId)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/product/tech-packs/scan/:code', { schema: scanContract }, async (request) => ({ scan: await scanTechPack(request, request.params.code) }))
})
