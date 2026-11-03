import { copyPieces, type PieceCopy } from '@nexus/factory-domain/product/pieces/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTools } from '../../../core/command'
import { insertPieces, readGrades, readPieces, withMaterials } from './store'

/**
 * The pattern pieces travel with the BOM (B-W2b-95; B-W2b-85's note): a frozen revision copied into the next draft
 * (product/bom revisions.ts copyRevision) and a style copied with its BOM (product/styles duplicate.ts) copy the source
 * revision's pieces too, AFTER the BOM lines (a piece names its line by id: `lines` maps each source line to the line the
 * copy made of it, by place). What the copy leaves out (a piece whose every size left the range) or clears (a line not
 * copied; a grade retired since or on a line that is no longer leather: the database refuses either written anew) is
 * answered, for the caller's audit row.
 */
export async function copyPiecesInCommand(
  tools: CommandTools,
  from: { readonly revisionId: string },
  to: { readonly styleId: string; readonly revisionId: string },
  lines: ReadonlyMap<string, string>,
  range: readonly string[],
): Promise<Omit<PieceCopy, 'pieces'> & { readonly copied: number }> {
  const { tx } = tools
  const pieces = await readPieces(tx, from.revisionId)
  if (pieces.length === 0) return { copied: 0, leftOut: [], gradesCleared: [], linesCleared: [] }
  const targets = [...new Set(lines.values())]
  const newLines = targets.length === 0 ? [] : await tx.bomLine.findMany({ where: { id: { in: targets } }, select: { id: true, seq: true, itemId: true, placement: true } })
  const facts = new Map((await withMaterials(tx, newLines)).map((line) => [line.id, line]))
  const byOld = new Map([...lines].flatMap(([oldId, newLineId]) => {
    const line = facts.get(newLineId)
    return line ? [[oldId, line] as const] : []
  }))
  const grades = new Map((await readGrades(tx)).map((grade) => [grade.id, grade]))
  const { pieces: copied, ...rest } = copyPieces(pieces, byOld, grades, range, newId)
  await insertPieces(tools, to, copied)
  return { copied: copied.length, ...rest }
}

/** Source line id → the copy's line id, by place (a revision's places are unique and every copy keeps them). */
export function lineMapBySeq(source: readonly { readonly id: string; readonly seq: number }[], copy: readonly { readonly id: string; readonly seq: number }[]): Map<string, string> {
  const bySeq = new Map(copy.map((line) => [line.seq, line.id]))
  return new Map(source.flatMap((line) => (bySeq.has(line.seq) ? [[line.id, bySeq.get(line.seq)!] as const] : [])))
}
