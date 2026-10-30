import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addLineContract,
  compareContract,
  copyRevisionContract,
  exportContract,
  getBomContract,
  obsoleteContract,
  releaseContract,
  removeLineContract,
  setColoursContract,
  setSizesContract,
  updateLineContract,
  updateRevisionContract,
} from './contract'
import { inlineDisposition } from '../../sales/quotes/preview'
import { bomExportFile } from './export'
import { addLine, removeLine, setColours, setSizes, updateLine, updateRevision } from './lines'
import { manifest } from './manifest'
import { compareRevisions, copyRevision, obsoleteRevision, releaseRevision } from './revisions'
import { bomViewOf, loadBom, readRevisionFor } from './store'

/**
 * One BOM per style revision (product module, B-W1-13; A2 SCR-042, SCR-046; features PRD-043, PRD-076, PRD-079,
 * PRD-082, PRD-100): its lines with the quantity per size and the colour grid, hide wastage, what one garment of each
 * size needs in each colourway; a frozen revision copied into a new draft, two revisions compared, release and
 * obsolete. The revision's DRAFT shell is the styles routes'; its routing is B-W1-14's. W2a (B-W2a-09, PRD-090): the BOM
 * as a file (./export) and its import (./importer, `product.bom` on the imports routes).
 */
export default defineRoutes('product.bom', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/bom', { schema: getBomContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { bom: bomViewOf(await request.withClient((client) => loadBom(client, style, revision))) }
  })

  app.patch('/product/styles/:styleId/revisions/:revisionId', { schema: updateRevisionContract }, async (request) => ({
    bom: await updateRevision(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/bom/lines', { schema: addLineContract }, async (request, reply) =>
    reply.code(201).send({ bom: await addLine(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId', { schema: updateLineContract }, async (request) => ({
    bom: await updateLine(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.delete('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId', { schema: removeLineContract }, async (request) => ({
    bom: await removeLine(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/sizes', { schema: setSizesContract }, async (request) => ({
    bom: await setSizes(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/colours', { schema: setColoursContract }, async (request) => ({
    bom: await setColours(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/copy', { schema: copyRevisionContract }, async (request, reply) =>
    reply.code(201).send({ bom: await copyRevision(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.get('/product/styles/:styleId/revisions/:revisionId/bom/export', { schema: exportContract }, async (request, reply) => {
    const { format, numberFormat, language } = request.query
    const file = await bomExportFile(request, request.params.styleId, request.params.revisionId, format, numberFormat, language)
    return reply.type(file.contentType).header('content-disposition', inlineDisposition(file.fileName)).header('cache-control', 'no-store').send(file.body)
  })

  app.get('/product/styles/:styleId/bom/compare', { schema: compareContract }, async (request) => ({
    diff: await compareRevisions(request, request.params.styleId, request.query),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/release', { schema: releaseContract }, async (request) => ({
    bom: await releaseRevision(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/obsolete', { schema: obsoleteContract }, async (request) => ({
    bom: await obsoleteRevision(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))
})
