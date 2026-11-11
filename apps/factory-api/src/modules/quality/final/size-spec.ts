import type { GradedPoint, GradedSpec } from '@nexus/factory-domain/quality/final/plan'
import { toleranceWords } from '@nexus/factory-domain/product/measures/rules'
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
 * B-W2b-283 (FU1:05; InspectionMeasurement.toleranceMinus / tolerancePlus, schema wave 34/44): a cell whose sides differ
 * keeps the spec's own nominal and its band (nominal − minus … nominal + plus), with `tolerance` the larger side, as the
 * database asks of such a row (it writes `pass` from the band); a symmetric cell is nominal ± tolerance as before. No more
 * centre ± half: the inspector sees the spec's nominal. Made-to-measure units are checked against the rider's profile, never
 * this. No money, no person.
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
    return [{ code: point.code, name: point.name, size: value.size, ...gradedBand(value.nominal, value.toleranceMinus, value.tolerancePlus), uom: point.uom as Uom, words: toleranceWords(nominal, minus, plus, point.uom) }]
  })
  return { spec: { revision: revision.revision, points: graded }, specId: spec.id, words: `The approved measurement spec of revision ${revision.revision}: ${ids.length} point(s) of measure.` }
}

/** A decimal as the database answers it (Prisma's Decimal). */
interface DecimalLike {
  toFixed(digits: number): string
  comparedTo(other: string): number
}

/**
 * A spec cell as the size check writes it (3 decimals): symmetric, nominal ± tolerance; else the spec's nominal, the larger
 * side as `tolerance` and the band (the database refuses any other tolerance on a row with a band).
 */
export function gradedBand(nominal: DecimalLike, minus: DecimalLike, plus: DecimalLike): Pick<GradedPoint, 'nominal' | 'tolerance' | 'band'> {
  const [low, high] = [minus.toFixed(3), plus.toFixed(3)]
  if (low === high) return { nominal: nominal.toFixed(3), tolerance: low, band: null }
  return { nominal: nominal.toFixed(3), tolerance: minus.comparedTo(high) >= 0 ? low : high, band: { minus: low, plus: high } }
}
