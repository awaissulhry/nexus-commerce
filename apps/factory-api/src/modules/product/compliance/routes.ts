import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  completeDocumentFileContract,
  downloadDocumentFileContract,
  getDocumentContract,
  listDocumentsContract,
  styleComplianceContract,
  uploadDocumentContract,
} from './contract'
import { completeDocumentFile, downloadDocumentFile, getDocument, listDocuments, uploadDocument } from './documents'
import { manifest } from './manifest'
import { styleCompliance } from './read'

/**
 * The style's Compliance tab (product module, B-W1-20; A2 SCR-045; features PRD-270, PRD-288, QHS-103, LOG-020;
 * Reg. (EU) 2016/425): the PPE classification, the certificate coverage per colourway × size, the signed EU Declaration
 * of Conformity and user information leaflet per revision and language (uploaded through the files platform), and what
 * blocks production, labels and shipping. The DoC generator is W2b; the certificates are compliance/certificates.
 */
export default defineRoutes('product.compliance', manifest, async (app) => {
  app.get('/product/styles/:styleId/compliance', { schema: styleComplianceContract }, async (request) => ({
    compliance: await styleCompliance(request, request.params.styleId, request.query),
  }))

  app.get('/product/styles/:styleId/compliance/documents', { schema: listDocumentsContract }, async (request) => ({
    documents: await listDocuments(request, request.params.styleId, request.query),
  }))

  app.get('/product/styles/:styleId/compliance/documents/:documentId', { schema: getDocumentContract }, async (request) => ({
    document: await getDocument(request, request.params.styleId, request.params.documentId),
  }))

  app.post('/product/styles/:styleId/compliance/documents', { schema: uploadDocumentContract }, async (request, reply) =>
    reply.code(201).send(await uploadDocument(request, request.params.styleId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/product/styles/:styleId/compliance/documents/:documentId/files/:fileId/complete', { schema: completeDocumentFileContract }, async (request) =>
    completeDocumentFile(request, request.params.styleId, request.params.documentId, request.params.fileId, idempotencyKeyFrom(request)),
  )

  app.get('/product/styles/:styleId/compliance/documents/:documentId/files/:fileId/download', { schema: downloadDocumentFileContract }, async (request) => ({
    download: await downloadDocumentFile(request, request.params.styleId, request.params.documentId, request.params.fileId),
  }))
})
