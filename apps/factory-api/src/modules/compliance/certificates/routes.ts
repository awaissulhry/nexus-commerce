import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createCertificate, getCertificate, listCertificates, moveCertificate, updateCertificate } from './certificates'
import {
  addCoverageContract,
  announcePdfContract,
  completePdfContract,
  archiveCoverageContract,
  createCertificateContract,
  gateContract,
  getCertificateContract,
  issueCertificateContract,
  listCertificatesContract,
  reinstateCertificateContract,
  suspendCertificateContract,
  updateCertificateContract,
  withdrawCertificateContract,
} from './contract'
import { addCoverage, archiveCoverage } from './coverage'
import { checkGate } from './gate'
import { manifest } from './manifest'
import { announcePdf, completePdf } from './pdf'

/**
 * The EN 17092 certificate register (B-W1-12; QHS-103, QHS-051, PRD-288; Reg. (EU) 2016/425): certificates typed in as
 * drafts, registered with the notified body's PDF, suspended, reinstated and withdrawn; what each covers (styles with
 * their colourways, sizes and made-to-measure units, or items); and the certificate gate that labels, work orders and
 * release ask. The scheduler expires certificates and warns before (expiry.ts, background.ts).
 */
export default defineRoutes('compliance.certificates', manifest, async (app) => {
  app.get('/compliance/certificates', { schema: listCertificatesContract }, async (request) => listCertificates(request, request.query))

  // Before the :certificateId routes, for the reader; Fastify matches the static segment first anyway.
  app.post('/compliance/certificates/gate', { schema: gateContract }, async (request) => checkGate(request, request.body))

  app.get('/compliance/certificates/:certificateId', { schema: getCertificateContract }, async (request) => ({
    certificate: await getCertificate(request, request.params.certificateId),
  }))

  app.post('/compliance/certificates', { schema: createCertificateContract }, async (request, reply) => {
    return reply.code(201).send({ certificate: await createCertificate(request, request.body, idempotencyKeyFrom(request)) })
  })

  app.patch('/compliance/certificates/:certificateId', { schema: updateCertificateContract }, async (request) => ({
    certificate: await updateCertificate(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/certificates/:certificateId/issue', { schema: issueCertificateContract }, async (request) => ({
    certificate: await moveCertificate(request, request.params.certificateId, 'issue', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/certificates/:certificateId/suspend', { schema: suspendCertificateContract }, async (request) => ({
    certificate: await moveCertificate(request, request.params.certificateId, 'suspend', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/certificates/:certificateId/reinstate', { schema: reinstateCertificateContract }, async (request) => ({
    certificate: await moveCertificate(request, request.params.certificateId, 'reinstate', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/certificates/:certificateId/withdraw', { schema: withdrawCertificateContract }, async (request) => ({
    certificate: await moveCertificate(request, request.params.certificateId, 'withdraw', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/compliance/certificates/:certificateId/coverage', { schema: addCoverageContract }, async (request, reply) => {
    return reply.code(201).send(await addCoverage(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)))
  })

  app.post('/compliance/certificates/:certificateId/coverage/:coverageId/archive', { schema: archiveCoverageContract }, async (request) =>
    archiveCoverage(request, request.params.certificateId, request.params.coverageId, request.body, idempotencyKeyFrom(request)),
  )

  // The notified body's PDF: only through these two routes (platform/files/owned.ts).
  app.post('/compliance/certificates/:certificateId/pdf', { schema: announcePdfContract }, async (request, reply) => {
    return reply.code(201).send(await announcePdf(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)))
  })

  app.post('/compliance/certificates/:certificateId/pdf/:fileId/complete', { schema: completePdfContract }, async (request) =>
    completePdf(request, request.params.certificateId, request.params.fileId, idempotencyKeyFrom(request)),
  )
})
