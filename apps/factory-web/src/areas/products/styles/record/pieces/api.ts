import { z } from 'zod'
import { piecesView, type PiecesView } from '@nexus/factory-domain/product/pieces/contracts'
import type { PatternGrain } from '@nexus/factory-domain/product/pieces/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The calls of the Pattern pieces section (B-W2b-95; SCR-271, Style › Files & patterns), each answer checked against the
 * API's own contract (factory-domain product/pieces/contracts). Every write sends the REVISION's version (a revision's BOM,
 * routing and pieces are one versioned record) and an idempotency key; a 409 reads the record again.
 */

export type { PiecesView }
export type Piece = PiecesView['pieces'][number]
export type PieceLineRow = PiecesView['lines'][number]
export type PieceGradeRow = PiecesView['grades'][number]

/** The fields a piece write may send (only what changed). */
export interface PiecePatch {
  name?: string
  quantity?: number
  bomLineId?: string | null
  minGradeId?: string | null
  grain?: PatternGrain
  sizes?: string[]
  note?: string | null
}

export type RevisionRef = { id: string; version: number }

const one = z.object({ pieces: piecesView })
const enc = encodeURIComponent
const base = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}/pieces`
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export function getPieces(api: ApiClient, styleId: string, revisionId: string): Promise<PiecesView> {
  return api.get(base(styleId, revisionId), { schema: one }).then((answer) => answer.pieces)
}

export function addPiece(api: ApiClient, styleId: string, revision: RevisionRef, piece: PiecePatch & { name: string }): Promise<PiecesView> {
  return api.post(base(styleId, revision.id), { body: { ...piece, version: revision.version }, schema: one, ...key() }).then((answer) => answer.pieces)
}

export function updatePiece(api: ApiClient, styleId: string, revision: RevisionRef, pieceId: string, patch: PiecePatch): Promise<PiecesView> {
  return api.request('PATCH', `${base(styleId, revision.id)}/${enc(pieceId)}`, { body: { ...patch, version: revision.version }, schema: one, ...key() }).then((answer) => answer.pieces)
}

export function removePiece(api: ApiClient, styleId: string, revision: RevisionRef, pieceId: string): Promise<PiecesView> {
  return api.request('DELETE', `${base(styleId, revision.id)}/${enc(pieceId)}`, { query: { version: revision.version }, schema: one, ...key() }).then((answer) => answer.pieces)
}

export function reorderPieces(api: ApiClient, styleId: string, revision: RevisionRef, pieceIds: readonly string[]): Promise<PiecesView> {
  return api.request('PUT', `${base(styleId, revision.id)}/order`, { body: { version: revision.version, pieceIds }, schema: one, ...key() }).then((answer) => answer.pieces)
}

export function removePieces(api: ApiClient, styleId: string, revision: RevisionRef, pieceIds: readonly string[]): Promise<PiecesView> {
  return api.post(`${base(styleId, revision.id)}/remove`, { body: { version: revision.version, pieceIds }, schema: one, ...key() }).then((answer) => answer.pieces)
}

export function changePieces(api: ApiClient, styleId: string, revision: RevisionRef, pieceIds: readonly string[], change: Pick<PiecePatch, 'minGradeId' | 'grain' | 'quantity'>): Promise<PiecesView> {
  return api.post(`${base(styleId, revision.id)}/change`, { body: { version: revision.version, pieceIds, ...change }, schema: one, ...key() }).then((answer) => answer.pieces)
}
