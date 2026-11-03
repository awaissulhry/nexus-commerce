import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { AddPieceBody, ChangePiecesBody, PiecesView, RemovePiecesBody, ReorderPiecesBody, UpdatePieceBody } from '@nexus/factory-domain/product/pieces/contracts'
import { MAX_PIECE_SEQ, MAX_PIECES, nextPieceSeq, pieceChanges, pieceOrderProblems, pieceRenumbering, planPiece, type PieceFields } from '@nexus/factory-domain/product/pieces/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, contextOf, findRevision, readRevisionFor, STYLE_COLUMNS, type LockedDraft } from '../bom/store'
import {
  auditedPiece,
  deletePieces,
  insertPieces,
  invalid,
  isUniqueViolation,
  loadPieces,
  lockDraft,
  movePieces,
  piecesViewInTx,
  prefixed,
  readPieces,
  updatePieceRow,
  worldOf,
  type LoadedPieces,
  type PieceRecord,
} from './store'

/**
 * A draft revision's pattern pieces (B-W2b-95; PRD-219, MES-055): a piece added at the end, a piece's fields changed (a
 * cell of the list, autosaved), a piece removed, the pieces reordered, and the list's selection (several removed, or one
 * field set on several). Every write sends the revision's version: it locks the style row, checks the revision is a draft
 * (409 otherwise, before the database's own refusal), compares and sets the revision's version, then writes the pieces; it
 * records an audit row per piece and one on the revision, and `style.pieces_changed`. The BOM's permissions decide who
 * may (product.bom.manage over the style's company; a style of every company only by a role over every company).
 */

function recordChange(tools: CommandTools, draft: LockedDraft, pieceIds: readonly string[], change: Record<string, unknown>): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { pieces: change, version: draft.version } })
  tools.emit({
    type: 'style.pieces_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, pieceIds: [...pieceIds] },
  })
}

const clashed = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new DomainError('conflict', 'Another change took this name or place in the pattern pieces at the same time: load them again.')
  throw error
}

/** Everything the checks read, inside the command (after the locks). */
async function loadInTx(tools: CommandTools, draft: LockedDraft, styleId: string): Promise<LoadedPieces> {
  const { tx } = tools
  const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
  return loadPieces(tx, style, await findRevision(tx, styleId, draft.revisionId))
}

function pieceOf(pieces: readonly PieceRecord[], pieceId: string): PieceRecord {
  const piece = isUuid(pieceId) ? pieces.find((entry) => entry.id === pieceId) : undefined
  if (!piece) throw new NotFoundError('Pattern piece not found.')
  return piece
}

function piecesOf(pieces: readonly PieceRecord[], pieceIds: readonly string[]): PieceRecord[] {
  const unknown = pieceIds.filter((id) => !pieces.some((piece) => piece.id === id))
  if (unknown.length > 0) throw new NotFoundError(`${unknown.length} pattern piece(s) are not of this revision.`)
  if (new Set(pieceIds).size !== pieceIds.length) throw invalid([{ path: 'body/pieceIds', message: 'Each piece once.' }])
  return pieceIds.map((id) => pieces.find((piece) => piece.id === id)!)
}

/** product.pieces.add: a piece at the end of the draft's list. */
export async function addPiece(caller: CommandCaller, styleId: string, revisionId: string, body: AddPieceBody, idempotencyKey?: string): Promise<PiecesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const { version, ...change } = body

  const { result } = await command(caller, { name: 'product.pieces.add', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const loaded = await loadInTx(tools, draft, styleId)
    if (loaded.pieces.length >= MAX_PIECES) throw new ValidationError('The pattern piece list is full.', [{ path: 'body', message: `A revision has at most ${MAX_PIECES} pattern pieces.` }])
    const seq = nextPieceSeq(loaded.pieces)
    if (seq > MAX_PIECE_SEQ) throw new ValidationError('The pattern piece list is full.', [{ path: 'body', message: 'Reorder the pieces first: their places ran out.' }])
    const plan = planPiece(null, change, worldOf(loaded), seq)
    if (!plan.ok) throw invalid(prefixed(plan.issues))
    const id = newId()
    await insertPieces(tools, { styleId, revisionId }, [{ id, ...plan.piece }])
    tools.audit({ recordType: 'PatternPiece', recordId: id, companyId: draft.style.companyId, after: { revisionId, ...auditedPiece(plan.piece) } })
    recordChange(tools, draft, [id], { added: id, seq, name: plan.piece.name })
    return piecesViewInTx(tools.tx, styleId, revisionId)
  }).catch(clashed)
  return result
}

/** product.pieces.update: the fields sent (a cell of the list). */
export async function updatePiece(caller: CommandCaller, styleId: string, revisionId: string, pieceId: string, body: UpdatePieceBody, idempotencyKey?: string): Promise<PiecesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const { version, ...change } = body

  const { result } = await command(caller, { name: 'product.pieces.update', idempotencyKey, input: { styleId, revisionId, pieceId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const loaded = await loadInTx(tools, draft, styleId)
    const current = pieceOf(loaded.pieces, pieceId)
    const plan = planPiece(current, change, worldOf(loaded, pieceId), current.seq)
    if (!plan.ok) throw invalid(prefixed(plan.issues))
    const changed = pieceChanges(current, plan.piece)
    if (changed.length > 0) await updatePieceRow(tools, pieceId, plan.piece)
    const before = auditedPiece(current)
    const after = auditedPiece(plan.piece)
    tools.audit({
      recordType: 'PatternPiece',
      recordId: pieceId,
      companyId: draft.style.companyId,
      before: Object.fromEntries(changed.map((field) => [field, before[field]])),
      after: Object.fromEntries(changed.map((field) => [field, after[field]])),
    })
    recordChange(tools, draft, [pieceId], { changed: pieceId, fields: changed })
    return piecesViewInTx(tools.tx, styleId, revisionId)
  }).catch(clashed)
  return result
}

/** product.pieces.remove: the piece out of the draft (the others keep their places). */
export async function removePiece(caller: CommandCaller, styleId: string, revisionId: string, pieceId: string, version: number, idempotencyKey?: string): Promise<PiecesView> {
  return removeMany(caller, 'product.pieces.remove', styleId, revisionId, [pieceId], version, idempotencyKey)
}

/** product.pieces.removeMany: the selected pieces out of the draft in one write. */
export async function removePieces(caller: CommandCaller, styleId: string, revisionId: string, body: RemovePiecesBody, idempotencyKey?: string): Promise<PiecesView> {
  return removeMany(caller, 'product.pieces.removeMany', styleId, revisionId, body.pieceIds, body.version, idempotencyKey)
}

async function removeMany(
  caller: CommandCaller,
  name: 'product.pieces.remove' | 'product.pieces.removeMany',
  styleId: string,
  revisionId: string,
  pieceIds: readonly string[],
  version: number,
  idempotencyKey: string | undefined,
): Promise<PiecesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name, idempotencyKey, input: { styleId, revisionId, pieceIds, version } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const current = await readPieces(tools.tx, revisionId)
    const gone = name === 'product.pieces.remove' ? [pieceOf(current, pieceIds[0]!)] : piecesOf(current, pieceIds)
    await deletePieces(
      tools,
      gone.map((piece) => piece.id),
    )
    for (const piece of gone) tools.audit({ recordType: 'PatternPiece', recordId: piece.id, companyId: draft.style.companyId, before: { revisionId, ...auditedPiece(piece) }, after: { removed: true } })
    recordChange(tools, draft, gone.map((piece) => piece.id), { removed: gone.map((piece) => ({ id: piece.id, seq: piece.seq, name: piece.name })) })
    return piecesViewInTx(tools.tx, styleId, revisionId)
  })
  return result
}

/** product.pieces.reorder: every piece in the new order, numbered 10, 20, 30 … */
export async function reorderPieces(caller: CommandCaller, styleId: string, revisionId: string, body: ReorderPiecesBody, idempotencyKey?: string): Promise<PiecesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.pieces.reorder', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const pieces = await readPieces(tools.tx, revisionId)
    const problems = pieceOrderProblems(
      pieces.map((piece) => piece.id),
      body.pieceIds,
    )
    if (problems.length > 0) throw invalid(prefixed(problems), 'order')
    const moves = pieceRenumbering(pieces, body.pieceIds)
    await movePieces(tools, moves)
    for (const move of moves) tools.audit({ recordType: 'PatternPiece', recordId: move.id, companyId: draft.style.companyId, before: { seq: move.from }, after: { seq: move.to } })
    recordChange(tools, draft, body.pieceIds, { reordered: body.pieceIds, moved: moves.length })
    return piecesViewInTx(tools.tx, styleId, revisionId)
  }).catch(clashed)
  return result
}

/**
 * product.pieces.changeMany: one change (the minimum grade, the grain or the pieces per garment) to the selected pieces,
 * in one write: all or none; each refused piece is named (`body/pieces/<id>/<field>`).
 */
export async function changePieces(caller: CommandCaller, styleId: string, revisionId: string, body: ChangePiecesBody, idempotencyKey?: string): Promise<PiecesView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const { version, pieceIds, ...change } = body
  if (Object.keys(change).length === 0) throw invalid([{ path: 'body', message: 'Name what changes: the minimum grade, the grain or the pieces per garment.' }], 'change')

  const { result } = await command(caller, { name: 'product.pieces.changeMany', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const loaded = await loadInTx(tools, draft, styleId)
    const chosen = piecesOf(loaded.pieces, pieceIds)
    const issues: Issue[] = []
    const planned: { current: PieceRecord; piece: PieceFields }[] = []
    for (const current of chosen) {
      const plan = planPiece(current, change, worldOf(loaded, current.id), current.seq)
      if (plan.ok) planned.push({ current, piece: plan.piece })
      else issues.push(...plan.issues.map((issue) => ({ path: `body/pieces/${current.id}/${issue.path}`, message: `${current.name}: ${issue.message}` })))
    }
    if (issues.length > 0) throw invalid(issues, 'change')
    const changedIds: string[] = []
    for (const { current, piece } of planned) {
      const changed = pieceChanges(current, piece)
      if (changed.length === 0) continue
      changedIds.push(current.id)
      await updatePieceRow(tools, current.id, piece)
      const before = auditedPiece(current)
      const after = auditedPiece(piece)
      tools.audit({
        recordType: 'PatternPiece',
        recordId: current.id,
        companyId: draft.style.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field]])),
        after: Object.fromEntries(changed.map((field) => [field, after[field]])),
      })
    }
    recordChange(tools, draft, changedIds, { changedMany: changedIds, fields: Object.keys(change) })
    return piecesViewInTx(tools.tx, styleId, revisionId)
  })
  return result
}
