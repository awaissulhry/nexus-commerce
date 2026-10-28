import { defineRoutes } from '../../core/manifest'
import { serverClock } from '../../core/time'
import { attachmentDisposition } from '../files/rules'
import { sampleContract } from './contract'
import { samplePdf } from './documents'
import { manifest } from './manifest'

/**
 * Company documents (platform part; plan A1 §3.9, GAP-008): the letterhead preview of each fixed layout (quote,
 * purchase order, DDT, invoice copy) in Italian or English, with the company's legal data (c.c. art. 2250) and a
 * "sample" banner, so the Office can check a company's documents before the first one is issued.
 */
export default defineRoutes('documents', manifest, async (app) => {
  app.get('/documents/sample', { schema: sampleContract }, async (request, reply) => {
    const { pdf, fileName } = await samplePdf(request, request.query, serverClock)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
})
