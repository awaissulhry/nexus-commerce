import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { appClock } from '../../../platform/portal/tasks/clock'
import { conformityPerStyle } from './conformity'
import { conformityContract, downloadContract, listContract, oneContract } from './contract'
import { openDocument } from './download'
import { listDocuments, oneDocument } from './library'
import { manifest } from './manifest'

/**
 * Customer documents in the portal (B-W2b-178; SAL-086 the library per account, SAL-087 the declaration and certificate
 * valid on the shipping date per style received, SAL-092 fixed versions only, QHS-111 downloads logged; design
 * portal.customer.documents, the order record's Documents tab; the screens are B-W2b-195's, Home's B-W2b-187's):
 *
 *   GET  /portal/customer-documents                     the library: chips by the groups the role sees, newest first
 *   GET  /portal/customer-documents/conformity          per style received: declaration, leaflet, certificate valid then
 *   GET  /portal/customer-documents/:fileId             one document and its versions; a withdrawn one names the newer
 *   POST /portal/customer-documents/:fileId/download    preview or download, logged, presigned 60 s
 *
 * Home's count is ./home.ts (platform/portal/home/sources).
 */
export default defineRoutes('portal-customer-documents', manifest, async (app) => {
  app.get('/portal/customer-documents', { schema: listContract }, async (request) => listDocuments(app, request, request.query, appClock(app).now()))

  app.get('/portal/customer-documents/conformity', { schema: conformityContract }, async (request) => conformityPerStyle(app, request, request.query, appClock(app).now()))

  app.get('/portal/customer-documents/:fileId', { schema: oneContract }, async (request) => oneDocument(app, request, request.params.fileId, appClock(app).now()))

  app.post('/portal/customer-documents/:fileId/download', { schema: downloadContract }, async (request) =>
    openDocument(app, processFiles(), request, request.params.fileId, request.body, idempotencyKeyFrom(request)),
  )
})
