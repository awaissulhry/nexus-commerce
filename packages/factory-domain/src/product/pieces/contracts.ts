import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { bomRevisionView } from '../bom/contracts'
import { STYLE_STATUSES } from '../styles/rules'
import { MAX_PIECE_NAME, MAX_PIECE_NOTE, MAX_PIECE_QUANTITY, MAX_PIECES, PATTERN_GRAINS, PIECE_ISSUE_CODES } from './rules'

/**
 * The pattern pieces' contracts (B-W2b-95; design products.styles › Style › Files & patterns › Pattern pieces, SCR-271):
 * what apps/factory-api's modules/product/pieces accepts and answers, and what the web's typed client reads. No money.
 * Every write sends the REVISION's `version` (COL-078): a revision's BOM, routing and pieces are one versioned record.
 */

const version = () => z.number().int().min(1)
const name = () => z.string().trim().min(1).max(MAX_PIECE_NAME)
const quantity = () => z.number().int().min(1).max(MAX_PIECE_QUANTITY)
const sizes = () => z.array(z.string().trim().min(1).max(20)).max(60)
const note = () => z.string().max(MAX_PIECE_NOTE).nullable()

/** A new piece at the end of the draft's list: its name; the rest has defaults (1 per garment, any grain, every size). */
export const addPieceBody = input({
  version: version(),
  name: name(),
  quantity: quantity().default(1),
  bomLineId: id().nullable().default(null),
  minGradeId: id().nullable().default(null),
  grain: z.enum(PATTERN_GRAINS).default('ANY'),
  /** Codes of the style's range; empty: every size. */
  sizes: sizes().default([]),
  note: note().default(null),
})
export type AddPieceBody = z.output<typeof addPieceBody>

/** A change to a piece: only what it names (null clears the line, the grade or the note). */
export const updatePieceBody = input({
  version: version(),
  name: name().optional(),
  quantity: quantity().optional(),
  bomLineId: id().nullable().optional(),
  minGradeId: id().nullable().optional(),
  grain: z.enum(PATTERN_GRAINS).optional(),
  sizes: sizes().optional(),
  note: note().optional(),
})
export type UpdatePieceBody = z.output<typeof updatePieceBody>

/** A piece out of the draft: the revision's version in the query. */
export const removePieceQuery = input({ version: z.coerce.number().int().min(1) })
export type RemovePieceQuery = z.output<typeof removePieceQuery>

/** The new order: every piece of the revision once; they are numbered 10, 20, 30 … in it. */
export const reorderPiecesBody = input({ version: version(), pieceIds: z.array(id()).min(1).max(MAX_PIECES) })
export type ReorderPiecesBody = z.output<typeof reorderPiecesBody>

/** The list's selection: several pieces out of the draft in one write. */
export const removePiecesBody = input({ version: version(), pieceIds: z.array(id()).min(1).max(MAX_PIECES) })
export type RemovePiecesBody = z.output<typeof removePiecesBody>

/** The list's selection: one change to several pieces in one write (all or none: a refused piece is named). */
export const changePiecesBody = input({
  version: version(),
  pieceIds: z.array(id()).min(1).max(MAX_PIECES),
  minGradeId: id().nullable().optional(),
  grain: z.enum(PATTERN_GRAINS).optional(),
  quantity: quantity().optional(),
})
export type ChangePiecesBody = z.output<typeof changePiecesBody>

export const pieceView = output({
  id: id(),
  seq: z.number().int(),
  name: z.string(),
  quantity: z.number().int(),
  bomLineId: id().nullable(),
  minGradeId: id().nullable(),
  grain: z.enum(PATTERN_GRAINS),
  /** Codes of the style's range in its order; empty: every size. */
  sizes: z.array(z.string()),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type PieceView = z.infer<typeof pieceView>

/** A line of the revision's BOM a piece may be cut from (its material; leather when tracked by HIDE). */
export const pieceLineView = output({
  id: id(),
  seq: z.number().int(),
  itemId: id(),
  code: z.string(),
  name: z.string(),
  placement: z.string().nullable(),
  leather: z.boolean(),
})
export type PieceLineView = z.infer<typeof pieceLineView>

/** A leather grade (tenant-wide): in use ones are offered; a retired one a piece names stays shown. */
export const pieceGradeView = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
})
export type PieceGradeView = z.infer<typeof pieceGradeView>

export const pieceIssueView = output({ code: z.enum(PIECE_ISSUE_CODES), pieceId: id().nullable(), lineId: id().nullable(), message: z.string() })

/** The pattern pieces of one revision (SCR-271): the pieces in order, the lines and grades they may name, what the list points out. */
export const piecesView = output({
  revision: bomRevisionView,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.enum(STYLE_STATUSES) }),
  /** The style's range, in the scale's order. */
  sizes: z.array(output({ code: z.string(), label: z.string() })),
  pieces: z.array(pieceView),
  lines: z.array(pieceLineView),
  grades: z.array(pieceGradeView),
  /** A draft's only (a frozen list is not checked again). */
  issues: z.array(pieceIssueView),
  /** A DRAFT revision of a style that is not archived: its pieces may be changed. */
  editable: z.boolean(),
})
export type PiecesView = z.infer<typeof piecesView>
