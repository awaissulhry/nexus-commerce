import { newId } from '@nexus/factory-domain/core/ids'
import { pointOrder } from '@nexus/factory-domain/product/measures/rules'
import type { CommandTools } from '../../../core/command'
import { readLiveSpec, readValues } from './store'

/**
 * A revision's measurement spec and protector placement travel with it (B-W2b-210's note; PRD-063, PRD-074): a frozen
 * revision copied into the next draft (product/bom revisions.ts copyRevision) copies, AFTER its BOM:
 *
 *   the live spec      as a DRAFT spec (a copy is checked and approved again: never its approval), with its base size, its
 *                      grade rule while that is still an active rule of the style's scale, and its cells of the style's
 *                      range now (each keeping its typed or graded mark). A spec whose base size left the range is not
 *                      copied (the database refuses it): said in the answer, for the caller's audit row.
 *   the placements     each pocket's protector, standard, level and note with its place; its sizes kept to the range (a
 *                      placement whose every size left it is left out; an empty list stays "every size").
 *
 * Archived specs stay with their revision.
 */
export interface MeasuresCopy {
  readonly spec: { readonly cells: number; readonly cellsLeftOut: number; readonly ruleCleared: boolean } | null
  readonly specLeftOut: string | null
  readonly placements: number
  readonly placementsLeftOut: readonly number[]
}

export async function copyMeasuresInCommand(tools: CommandTools, from: { readonly revisionId: string }, to: { readonly styleId: string; readonly revisionId: string }, range: readonly string[], scaleId: string): Promise<MeasuresCopy> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const stamp = { createdAt: now, updatedAt: now, createdById }

  let spec: MeasuresCopy['spec'] = null
  let specLeftOut: string | null = null
  const source = await readLiveSpec(tx, from.revisionId)
  if (source && !range.includes(source.baseSize)) specLeftOut = `The measurement spec's base size ${source.baseSize} left the style's range: it was not copied.`
  else if (source) {
    const rule = source.gradeRuleId ? await tx.gradeRule.findUnique({ where: { id: source.gradeRuleId }, select: { sizeScaleId: true, status: true } }) : null
    const ruleKept = rule !== null && rule.status === 'ACTIVE' && rule.sizeScaleId === scaleId
    const id = newId()
    await tx.measurementSpec.create({ data: { id, styleId: to.styleId, revisionId: to.revisionId, baseSize: source.baseSize, status: 'DRAFT', gradeRuleId: ruleKept ? source.gradeRuleId : null, ...stamp }, select: { id: true } })
    const values = await readValues(tx, source.id)
    const kept = values.filter((value) => range.includes(value.size))
    const place = new Map(pointOrder(kept).map((pointId, index) => [pointId, index + 1]))
    if (kept.length > 0) {
      await tx.measurementSpecValue.createMany({
        data: kept.map((value) => ({
          id: newId(),
          revisionId: to.revisionId,
          specId: id,
          pointOfMeasureId: value.pointOfMeasureId,
          size: value.size,
          seq: place.get(value.pointOfMeasureId)!,
          nominal: value.nominal,
          toleranceMinus: value.toleranceMinus,
          tolerancePlus: value.tolerancePlus,
          source: value.source,
          ...stamp,
        })),
      })
    }
    spec = { cells: kept.length, cellsLeftOut: values.length - kept.length, ruleCleared: source.gradeRuleId !== null && !ruleKept }
  }

  const placements = await tx.protectorPlacement.findMany({
    where: { revisionId: from.revisionId },
    select: { seq: true, pocket: true, protectorItemId: true, standard: true, level: true, sizes: true, positionNote: true },
    orderBy: { seq: 'asc' },
  })
  const placementsLeftOut: number[] = []
  const copies = placements.flatMap((placement) => {
    const sizes = placement.sizes.filter((size) => range.includes(size))
    if (placement.sizes.length > 0 && sizes.length === 0) {
      placementsLeftOut.push(placement.seq)
      return []
    }
    return [{ ...placement, sizes, id: newId(), styleId: to.styleId, revisionId: to.revisionId, ...stamp }]
  })
  if (copies.length > 0) await tx.protectorPlacement.createMany({ data: copies })
  return { spec, specLeftOut, placements: copies.length, placementsLeftOut }
}

/** Nothing worth its own audit row. */
export const emptyMeasuresCopy = (copy: MeasuresCopy): boolean => copy.spec === null && copy.specLeftOut === null && copy.placements === 0 && copy.placementsLeftOut.length === 0
