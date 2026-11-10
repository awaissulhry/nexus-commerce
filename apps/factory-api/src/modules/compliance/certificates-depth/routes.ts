import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createBody, editBody, getBody, listBodies } from './bodies'
import { checkBoughtIn } from './bought-in'
import {
  boughtInContract,
  createBodyContract,
  editBodyContract,
  getBodyContract,
  getDepthContract,
  listBodiesContract,
  setBaseContract,
  setBodyContract,
  setLevelsContract,
  setSupplierContract,
} from './contract'
import { getDepth, setBase, setLevels, setNotifiedBody, setSupplier } from './depth'
import { manifest } from './manifest'

/**
 * Certificates in depth (B-W2b-255): the notified body directory with its NANDO entries (PRD-286), a certificate's depth
 * — the five-year check (PRD-282), its body from the directory with the scope check, its performance levels (PRD-290),
 * its own-brand base (PRD-287), its bought-in parts' suppliers (QHS-106) — and the incoming check of a bought-in part.
 * The screens are Compliance › Certificates (SCR-050, SCR-051) and the Notified bodies pop-up (SCR-291).
 */
export default defineRoutes('compliance.certificatesDepth', manifest, async (app) => {
  app.get('/compliance/notified-bodies', { schema: listBodiesContract }, async (request) => listBodies(request, request.query))
  app.get('/compliance/notified-bodies/:bodyId', { schema: getBodyContract }, async (request) => getBody(request, request.params.bodyId))
  app.post('/compliance/notified-bodies', { schema: createBodyContract }, async (request, reply) => reply.code(201).send(await createBody(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/compliance/notified-bodies/:bodyId', { schema: editBodyContract }, async (request) => editBody(request, request.params.bodyId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/certificates/:certificateId/depth', { schema: getDepthContract }, async (request) => getDepth(request, request.params.certificateId))
  app.put('/compliance/certificates/:certificateId/notified-body', { schema: setBodyContract }, async (request) => setNotifiedBody(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/certificates/:certificateId/levels', { schema: setLevelsContract }, async (request) => setLevels(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/certificates/:certificateId/base', { schema: setBaseContract }, async (request) => setBase(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/certificates/:certificateId/coverage/:coverageId/supplier', { schema: setSupplierContract }, async (request) =>
    setSupplier(request, request.params.certificateId, request.params.coverageId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/compliance/bought-in', { schema: boughtInContract }, async (request) => checkBoughtIn(request, request.query))
})
