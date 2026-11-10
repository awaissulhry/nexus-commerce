import type { GradedPoint, GradedSpec } from '@nexus/factory-domain/quality/final/plan'
import { bandOf, toleranceWords } from '@nexus/factory-domain/product/measures/rules'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { LabelHeader } from '../../production/serials/store'
import type { Reader } from './store'

/**
 * The final inspection's size check reads the graded spec (B-W2b-224, follow-up SZ1:01 of B-W2b-97): the APPROVED
 * measurement spec of the work order's style revision (product/measures), per point of measure and size — nominal with
 * its tolerance under and over, in the point's unit. A size chart check of the plan (no nominal of its own) and a point
 * measured outside the plan take it instead of a typed nominal and tolerance; a plan check with its own nominal still
 * binds (the database's rule). A draft spec is not read: only what a person approved is measured against.
 *
 * InspectionMeasurement keeps one tolerance, so a cell's band (nominal − minus … nominal + plus) is kept as its centre ±
 * half its width: the same band, the same pass or fail; a symmetric tolerance keeps its nominal. Made-to-measure units are
 * checked against the rider's profile, never this. No money, no person.
 */

export interface SizeSpecFacts {
  readonly spec: GradedSpec | null
  readonly specId: string | null
  /** Why there is none, or what there is, in words. */
  readonly words: string
}

export async function sizeSpecFor(db: Reader, header: Pick<LabelHeader, 'styleRevisionId'>): Promise<SizeSpecFacts> {
  if (!header.styleRevisionId) return { spec: null, specId: null, words: 'The work order names no style revision: the size chart is typed.' }
  const revision = await db.styleRevision.findUnique({ where: { id: header.styleRevisionId }, select: { revision: true } })
  const spec = await db.measurementSpec.findFirst({ where: { revisionId: header.styleRevisionId, status: 'APPROVED' }, select: { id: true } })
  if (!revision || !spec) return { spec: null, specId: null, words: `Revision ${revision?.revision ?? '?'} has no approved measurement spec: the size chart is typed.` }
  const values = await db.measurementSpecValue.findMany({
    where: { specId: spec.id },
    select: { pointOfMeasureId: true, size: true, seq: true, nominal: true, toleranceMinus: true, tolerancePlus: true },
    orderBy: [{ seq: 'asc' }, { size: 'asc' }],
  })
  const ids = [...new Set(values.map((value) => value.pointOfMeasureId))]
  const points = new Map((ids.length === 0 ? [] : await db.pointOfMeasure.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })).map((row) => [row.id, row]))
  const graded: GradedPoint[] = values.flatMap((value) => {
    const point = points.get(value.pointOfMeasureId)
    if (!point) return []
    const nominal = value.nominal.toString()
    const minus = value.toleranceMinus.toString()
    const plus = value.tolerancePlus.toString()
    const band = bandOf(nominal, minus, plus)
    return [{ code: point.code, name: point.name, size: value.size, nominal: band.nominal, tolerance: band.tolerance, uom: point.uom as Uom, words: toleranceWords(nominal, minus, plus, point.uom) }]
  })
  return { spec: { revision: revision.revision, points: graded }, specId: spec.id, words: `The approved measurement spec of revision ${revision.revision}: ${ids.length} point(s) of measure.` }
}
