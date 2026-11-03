import { DomainError } from '@nexus/factory-domain/core/errors'
import type { CommandTx } from '../../../core/command'

/**
 * The BOM's writes that would leave a pattern piece wrong (B-W2b-95), called by the BOM store inside its command after
 * its locks (the style row): a line a piece is cut from is not removed (the key refuses it, onDelete Restrict), and a
 * line whose pieces carry a minimum grade does not change to a material that is not leather (the grade is a hide rule).
 * Each says which pieces first, in a 409 with each piece's path. This file imports nothing of the BOM's, so the BOM store
 * may import it.
 */

const named = (pieces: readonly { name: string }[]): string => pieces.map((piece) => `"${piece.name}"`).join(', ')

/** Before a draft's BOM line is removed: no pattern piece names it. */
export async function assertNoPiecesUse(tx: CommandTx, line: { readonly id: string; readonly seq: number }): Promise<void> {
  const pieces = await tx.patternPiece.findMany({ where: { bomLineId: line.id }, select: { id: true, name: true }, orderBy: { seq: 'asc' } })
  if (pieces.length === 0) return
  throw new DomainError(
    'conflict',
    `${pieces.length} pattern piece(s) are cut from line ${line.seq} (${named(pieces)}): tie them to another line or to none in Files & patterns first.`,
    pieces.map((piece) => ({ path: `pieces/${piece.id}/bomLineId`, message: `Pattern piece "${piece.name}" is cut from line ${line.seq}.` })),
  )
}

/** Before a draft's BOM line changes its material: a piece of it with a minimum grade keeps a leather (hide) line. */
export async function assertPiecesFollowMaterial(tx: CommandTx, line: { readonly id: string; readonly seq: number }, itemId: string): Promise<void> {
  const graded = await tx.patternPiece.findMany({ where: { bomLineId: line.id, minGradeId: { not: null } }, select: { id: true, name: true }, orderBy: { seq: 'asc' } })
  if (graded.length === 0) return
  const item = await tx.item.findUnique({ where: { id: itemId }, select: { code: true, tracking: true } })
  if (!item || item.tracking === 'HIDE') return
  throw new DomainError(
    'conflict',
    `${graded.length} pattern piece(s) of line ${line.seq} have a minimum leather grade (${named(graded)}) and ${item.code} is not leather: clear their grades in Files & patterns first.`,
    graded.map((piece) => ({ path: `pieces/${piece.id}/minGradeId`, message: `Pattern piece "${piece.name}" has a minimum grade.` })),
  )
}
