import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { addPieceBody, changePiecesBody, piecesView, removePieceQuery, removePiecesBody, reorderPiecesBody, updatePieceBody } from '@nexus/factory-domain/product/pieces/contracts'

/** The pattern pieces' routes' contracts (SCR-271): the bodies and answers are factory-domain's product/pieces/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const piece = input({ styleId: id(), revisionId: id(), pieceId: id() })
const one = { 200: output({ pieces: piecesView }) }

export const getPiecesContract = defineContract({ params: revision, response: one })
export const addPieceContract = defineContract({ params: revision, body: addPieceBody, response: { 201: output({ pieces: piecesView }) } })
export const updatePieceContract = defineContract({ params: piece, body: updatePieceBody, response: one })
export const removePieceContract = defineContract({ params: piece, querystring: removePieceQuery, response: one })
export const reorderPiecesContract = defineContract({ params: revision, body: reorderPiecesBody, response: one })
export const removePiecesContract = defineContract({ params: revision, body: removePiecesBody, response: one })
export const changePiecesContract = defineContract({ params: revision, body: changePiecesBody, response: one })
