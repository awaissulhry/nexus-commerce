import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { readRevisionFor } from '../bom/store'
import { addPieceContract, changePiecesContract, getPiecesContract, removePieceContract, removePiecesContract, reorderPiecesContract, updatePieceContract } from './contract'
import { manifest } from './manifest'
import { addPiece, changePieces, removePiece, removePieces, reorderPieces, updatePiece } from './pieces'
import { loadPieces, piecesViewOf } from './store'

/**
 * A style revision's pattern pieces (product module, B-W2b-95; design products.styles › Style › Files & patterns ›
 * Pattern pieces; features PRD-219, MES-055): the pieces a garment is cut from, how many of each, the BOM line each is cut
 * from, the lowest leather grade each may be cut from, the grain and the sizes. Edited only while the revision is a
 * DRAFT; they freeze with its release, travel with a copied revision and a copied style (the BOM's copy), and the cutting
 * table reads them by name (B-W2b-103).
 */
export default defineRoutes('product.pieces', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/pieces', { schema: getPiecesContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { pieces: piecesViewOf(await request.withClient((client) => loadPieces(client, style, revision))) }
  })

  app.post('/product/styles/:styleId/revisions/:revisionId/pieces', { schema: addPieceContract }, async (request, reply) =>
    reply.code(201).send({ pieces: await addPiece(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/styles/:styleId/revisions/:revisionId/pieces/:pieceId', { schema: updatePieceContract }, async (request) => ({
    pieces: await updatePiece(request, request.params.styleId, request.params.revisionId, request.params.pieceId, request.body, idempotencyKeyFrom(request)),
  }))

  app.delete('/product/styles/:styleId/revisions/:revisionId/pieces/:pieceId', { schema: removePieceContract }, async (request) => ({
    pieces: await removePiece(request, request.params.styleId, request.params.revisionId, request.params.pieceId, request.query.version, idempotencyKeyFrom(request)),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/pieces/order', { schema: reorderPiecesContract }, async (request) => ({
    pieces: await reorderPieces(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/pieces/remove', { schema: removePiecesContract }, async (request) => ({
    pieces: await removePieces(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/pieces/change', { schema: changePiecesContract }, async (request) => ({
    pieces: await changePieces(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))
})
