import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { PiecesView } from '@nexus/factory-domain/product/pieces/contracts'
import { pieceIssues, piecesEditRefusal, type PieceData, type PieceFields, type PieceGrade, type PieceLine, type PieceWorld } from '@nexus/factory-domain/product/pieces/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { bumpRevision, findRevision, lockStyleRow, revisionViewOf, STYLE_COLUMNS, type BomStyleRow, type LockedDraft, type RevisionRow } from '../bom/store'
import { requireEditRule } from '../lifecycle/edit-rule'

/**
 * The pattern pieces' rows (factory-db `PatternPiece`, B-W2b-85) and what they name (`BomLine` and its `Item`, `LeatherGrade`):
 * the columns every read names (no relation selects: inside a transaction Prisma would send them at once on its one
 * connection), how they become the domain's pieces and the view, and the locks their writes take.
 *
 * Lock order (the BOM's and the routing's, B-W1-13): the style row first (FOR UPDATE), then the revision row by
 * compare-and-set of its version (the …_product_guards part trigger then takes it FOR SHARE, which this transaction
 * already holds), then the pieces. A revision's BOM, routing and pieces are one versioned record: two writes on one
 * revision wait for each other on the style row and the second fails on the version (409), never a deadlock.
 *
 * Who may: the BOM's permissions (product.bom.view | manage), checked against the style's company by the BOM store's
 * readStyleFor / assertMayWrite. A draft's pieces are removed with DELETE: the runtime role holds it on PatternPiece
 * (ownership/cutting.json), and the guard allows it only while the revision is DRAFT.
 */

export const PIECE_COLUMNS = {
  id: true,
  seq: true,
  name: true,
  quantity: true,
  bomLineId: true,
  minGradeId: true,
  grain: true,
  sizes: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PatternPieceSelect

export interface PieceRecord extends PieceData {
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface LineFacts extends PieceLine {
  readonly itemId: string
  readonly name: string
  readonly placement: string | null
}

export interface GradeFacts extends PieceGrade {
  readonly labelIt: string
  readonly labelEn: string
}

type Client = FactoryClient | CommandTx

// ---- reads --------------------------------------------------------------------------------------------------------------

export async function readPieces(client: Client, revisionId: string): Promise<PieceRecord[]> {
  const rows = await client.patternPiece.findMany({ where: { revisionId }, select: PIECE_COLUMNS, orderBy: { seq: 'asc' } })
  return rows.map((row) => ({ ...row, grain: row.grain as PieceRecord['grain'], sizes: [...row.sizes] }))
}

/** The revision's BOM lines with their material (leather = tracked by HIDE), in place order. */
export async function readLineFacts(client: Client, revisionId: string): Promise<LineFacts[]> {
  const lines = await client.bomLine.findMany({ where: { revisionId }, select: { id: true, seq: true, itemId: true, placement: true }, orderBy: { seq: 'asc' } })
  return withMaterials(client, lines)
}

/** Lines (any revision) with their material's code, name and tracking. */
export async function withMaterials(client: Client, lines: readonly { id: string; seq: number; itemId: string; placement: string | null }[]): Promise<LineFacts[]> {
  const ids = [...new Set(lines.map((line) => line.itemId))]
  const items = ids.length === 0 ? [] : await client.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, tracking: true } })
  const byId = new Map(items.map((item) => [item.id, item]))
  return lines.map((line) => {
    const item = byId.get(line.itemId)
    return { id: line.id, seq: line.seq, itemId: line.itemId, code: item?.code ?? '', name: item?.name ?? '', placement: line.placement, leather: item?.tracking === 'HIDE' }
  })
}

/** Every leather grade of the tenant (in use and retired), in the pickers' order. */
export async function readGrades(client: Client): Promise<GradeFacts[]> {
  return client.leatherGrade.findMany({ select: { id: true, code: true, labelIt: true, labelEn: true, sortOrder: true, active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
}

export interface LoadedPieces {
  readonly style: BomStyleRow
  readonly revision: RevisionRow
  readonly pieces: readonly PieceRecord[]
  readonly lines: readonly LineFacts[]
  readonly grades: readonly GradeFacts[]
  readonly sizeLabels: ReadonlyMap<string, string | null>
}

export async function loadPieces(client: Client, style: BomStyleRow, revision: RevisionRow): Promise<LoadedPieces> {
  const pieces = await readPieces(client, revision.id)
  const lines = await readLineFacts(client, revision.id)
  const grades = await readGrades(client)
  const sizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  return { style, revision, pieces, lines, grades, sizeLabels: new Map(sizes.map((size) => [size.code, size.label])) }
}

/** What a piece is checked against, from what was loaded (the piece itself left out of the names). */
export function worldOf(loaded: Pick<LoadedPieces, 'style' | 'pieces' | 'lines' | 'grades'>, exceptId: string | null = null): PieceWorld {
  return {
    sizes: loaded.style.sizes,
    lines: new Map(loaded.lines.map((line) => [line.id, line])),
    grades: new Map(loaded.grades.map((grade) => [grade.id, grade])),
    others: loaded.pieces.filter((piece) => piece.id !== exceptId),
  }
}

// ---- the view -----------------------------------------------------------------------------------------------------------

/** The pattern pieces of one revision (SCR-271). */
export function piecesViewOf(loaded: LoadedPieces): PiecesView {
  const { style, revision, pieces } = loaded
  const draft = revision.status === 'DRAFT'
  const world = worldOf(loaded)
  // Every grade in use, and the retired ones a piece names (shown, never offered).
  const named = new Set(pieces.map((piece) => piece.minGradeId))
  return {
    revision: revisionViewOf(revision),
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    sizes: style.sizes.map((code) => ({ code, label: loaded.sizeLabels.get(code) ?? code })),
    pieces: pieces.map((piece) => ({
      id: piece.id,
      seq: piece.seq,
      name: piece.name,
      quantity: piece.quantity,
      bomLineId: piece.bomLineId,
      minGradeId: piece.minGradeId,
      grain: piece.grain,
      sizes: [...piece.sizes],
      note: piece.note,
      version: piece.version,
      createdAt: toUtcIso(piece.createdAt),
      updatedAt: toUtcIso(piece.updatedAt),
    })),
    lines: loaded.lines.map((line) => ({ id: line.id, seq: line.seq, itemId: line.itemId, code: line.code, name: line.name, placement: line.placement, leather: line.leather })),
    grades: loaded.grades.filter((grade) => grade.active || named.has(grade.id)).map((grade) => ({ id: grade.id, code: grade.code, labelIt: grade.labelIt, labelEn: grade.labelEn, sortOrder: grade.sortOrder, active: grade.active })),
    issues: draft ? pieceIssues(pieces, world).map((issue) => ({ ...issue })) : [],
    editable: draft && style.status !== 'ARCHIVED',
  }
}

/** The pieces as the command left them (its answer). */
export async function piecesViewInTx(tx: CommandTx, styleId: string, revisionId: string): Promise<PiecesView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return piecesViewOf(await loadPieces(tx, style, await findRevision(tx, styleId, revisionId)))
}

// ---- locks and versions -------------------------------------------------------------------------------------------------

/**
 * The first step of every change to a draft's pieces: the style row locked, the revision checked (a DRAFT of this style,
 * the style not archived: a clear 409 in the pieces' words before the database's own refusal) and its version compared
 * and set.
 */
export async function lockDraft(tools: CommandTools, styleId: string, revisionId: string, expectedVersion: number): Promise<LockedDraft> {
  const { tx, now } = tools
  const style = await lockStyleRow(tx, styleId)
  const row = await findRevision(tx, styleId, revisionId)
  const refusal = piecesEditRefusal(row, style.status)
  if (refusal) throw new InvalidStateError(refusal)
  // B-W2b-221: a write to a draft under the edit rule of the style's lifecycle state.
  await requireEditRule(tx, styleId, 'DRAFT')
  const version = await bumpRevision(tx, revisionId, expectedVersion, now)
  return { style, revisionId, revision: row.revision, version }
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[], what = 'pattern piece'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- writes -------------------------------------------------------------------------------------------------------------

/** A piece's fields as the audit row keeps them. */
export function auditedPiece(piece: PieceFields): Record<string, unknown> {
  return { seq: piece.seq, name: piece.name, quantity: piece.quantity, bomLineId: piece.bomLineId, minGradeId: piece.minGradeId, grain: piece.grain, sizes: [...piece.sizes], note: piece.note }
}

const removed = (count: number, expected: number, what: string): void => {
  // Row-level security without a DELETE policy removes nothing and says nothing: never let that pass as done.
  if (count !== expected) throw new ApiError('internal_error', `The database removed ${count} of ${expected} ${what}.`)
}

/** Inserts new pieces of a draft, as planned. */
export async function insertPieces(tools: CommandTools, target: { readonly styleId: string; readonly revisionId: string }, pieces: readonly PieceData[]): Promise<void> {
  if (pieces.length === 0) return
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.patternPiece.createMany({
    data: pieces.map((piece) => ({
      id: piece.id,
      styleId: target.styleId,
      revisionId: target.revisionId,
      seq: piece.seq,
      name: piece.name,
      quantity: piece.quantity,
      bomLineId: piece.bomLineId,
      minGradeId: piece.minGradeId,
      grain: piece.grain,
      sizes: [...piece.sizes],
      note: piece.note,
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
}

/** Writes a piece's new fields (its place moves only by the order). */
export async function updatePieceRow(tools: CommandTools, pieceId: string, piece: PieceFields): Promise<void> {
  await tools.tx.patternPiece.update({
    where: { id: pieceId },
    data: { name: piece.name, quantity: piece.quantity, bomLineId: piece.bomLineId, minGradeId: piece.minGradeId, grain: piece.grain, sizes: [...piece.sizes], note: piece.note, version: { increment: 1 }, updatedAt: tools.now },
    select: { id: true },
  })
}

/** Removes pieces of a draft. */
export async function deletePieces(tools: CommandTools, pieceIds: readonly string[]): Promise<void> {
  if (pieceIds.length === 0) return
  removed((await tools.tx.patternPiece.deleteMany({ where: { id: { in: [...pieceIds] } } })).count, pieceIds.length, 'pattern pieces')
}

/** Moves pieces to new places: each parked at its negative place first (free: places are above 0), then set. */
export async function movePieces(tools: CommandTools, moves: readonly { readonly id: string; readonly to: number }[]): Promise<void> {
  if (moves.length === 0) return
  const { tx, now } = tools
  const { count } = await tx.patternPiece.updateMany({ where: { id: { in: moves.map((move) => move.id) } }, data: { seq: { multiply: -1 } } })
  if (count !== moves.length) throw new ApiError('internal_error', `The database parked ${count} of ${moves.length} pattern pieces.`)
  for (const move of moves) await tx.patternPiece.update({ where: { id: move.id }, data: { seq: move.to, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
}
