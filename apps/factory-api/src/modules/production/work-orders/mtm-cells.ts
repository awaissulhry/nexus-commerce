import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { ReleaseCheck } from '@nexus/factory-domain/production/work-orders/release'
import { styleRefusal } from '../../sales/fittings/store'
import type { CellRow, Header, LineRow, Reader } from './store'

/**
 * A made-to-measure unit on a W1 work order (B-W2b-368, XF1:01; MES-003; W1 refused it with MADE_TO_MEASURE_LATER). A unit is
 * ONE garment for ONE rider, made to the measurement profile revision its order line names:
 *
 *   unitSizes        readOrderLines: a unit's order line has no size rows (the database's size guard); it reads as one piece of
 *                    its base size (the size its pattern is graded from), so W1's open sizes, cell checks and "every size still
 *                    open" make exactly one cell of one piece, once (a second work order finds nothing open)
 *   unitOfRequest    createWorkOrder: a unit is made on its own work order — kind MADE_TO_MEASURE, its one cell naming the line's
 *                    profile revision (the …_production_guards triggers: one cell of one piece with the profile at the release) —
 *                    never beside size-grid lines or another unit, never as a sample; a unit without a base size has no size to
 *                    make
 *   unitRefusal      the unit's style still made to measure and its template's made-to-measure rules on (GATE-MTM, B-W2b-358's
 *                    words): refused in words (409) while off
 *   assertUnitCells  setCells: a MADE_TO_MEASURE draft's cell does not change; a size run or sample takes no unit
 *   readUnitCells,   the release check (THE check: the record's checklist and the release's refusal): the cell's revision is
 *   unitCellsCheck   CONFIRMED by the factory review (SAL-292) and made-to-measure is still on for its template; both are
 *                    problems of W1's CELLS check (paths cells/<id>/measures and cells/<id>/mtm), so no new check code
 */

/** A unit's order line as one piece of its base size (none without a base size); any other line: its own size rows. */
export function unitSizes(line: { readonly kind: string; readonly baseSize: string | null }): { size: string; quantity: number }[] {
  return line.kind === 'MADE_TO_MEASURE' && line.baseSize ? [{ size: line.baseSize, quantity: 1 }] : []
}

const lineWords = (line: Pick<LineRow, 'orderNumber' | 'seq'>): string => `${line.orderNumber} line ${line.seq}`

/**
 * The unit a create names, or null when it names only size-grid lines. 400 in words when a unit is named beside other lines or
 * on a sample work order (a unit is one garment: its own work order).
 */
export function unitOfRequest(lines: ReadonlyMap<string, LineRow>, lineIds: readonly string[], sample: boolean): LineRow | null {
  const units = lineIds.map((id, index) => ({ line: lines.get(id)!, index })).filter((entry) => entry.line.kind === 'MADE_TO_MEASURE')
  if (units.length === 0) return null
  const problems: Issue[] = []
  if (sample) for (const { line, index } of units) problems.push({ path: `body/lines/${index}/salesOrderLineId`, message: `${lineWords(line)} is a made-to-measure unit: a sample work order makes size-grid lines only.` })
  else if (lineIds.length > 1) {
    for (const { line, index } of units) problems.push({ path: `body/lines/${index}/salesOrderLineId`, message: `${lineWords(line)} is a made-to-measure unit: it is made on its own work order (one garment for one rider). Name it alone.` })
  }
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'A made-to-measure unit is made on its own work order.', problems)
  const unit = units[0]!.line
  if (!unit.measurementProfileId) throw new ValidationError(`${lineWords(unit)} names no measurement profile revision.`, [{ path: 'body/lines/0/salesOrderLineId', message: `${lineWords(unit)} names no measurement profile revision.` }])
  if (unit.sizes.length === 0) {
    const message = `${lineWords(unit)} is a made-to-measure unit with no base size: the size its pattern is graded from is set on the unit before it is made.`
    throw new ValidationError(message, [{ path: 'body/lines/0/salesOrderLineId', message }])
  }
  return unit
}

/** Why the unit cannot be made now (GATE-MTM: the style flagged, its template, its rules on; B-W2b-358's words), or null. */
export async function unitRefusal(db: Reader, unit: Pick<LineRow, 'styleId' | 'measurementProfileId'>): Promise<string | null> {
  const profile = unit.measurementProfileId ? await db.measurementProfile.findUnique({ where: { id: unit.measurementProfileId }, select: { garmentType: true } }) : null
  return styleRefusal(db, unit.styleId, profile?.garmentType ?? null)
}

/** 409 in words while made-to-measure is off for the unit (see unitRefusal). */
export async function assertUnitStarted(db: Reader, unit: Pick<LineRow, 'styleId' | 'measurementProfileId' | 'orderNumber' | 'seq'>): Promise<void> {
  const refusal = await unitRefusal(db, unit)
  if (refusal) throw new ConflictError(`${lineWords(unit)}: ${refusal}`)
}

/** The cell's profile column: a unit's revision, else none (a size-grid cell names no profile). */
export const unitCellProfile = (line: Pick<LineRow, 'kind' | 'measurementProfileId'>): { measurementProfileId: string | null } => ({ measurementProfileId: line.kind === 'MADE_TO_MEASURE' ? line.measurementProfileId : null })

/** setCells: a unit's draft keeps its one cell; a size run or a sample takes no unit (400 at the cell, 409 for the unit's draft). */
export function assertUnitCells(workOrder: Pick<Header, 'number' | 'kind'>, lines: ReadonlyMap<string, LineRow>, cells: readonly { readonly salesOrderLineId: string }[]): void {
  if (workOrder.kind === 'MADE_TO_MEASURE') {
    throw new InvalidStateError(`Work order ${workOrder.number} makes one made-to-measure unit: its cell does not change (another unit is its own work order; cancel this one to make the unit again).`)
  }
  const problems: Issue[] = []
  cells.forEach((cell, index) => {
    const line = lines.get(cell.salesOrderLineId)
    if (line?.kind === 'MADE_TO_MEASURE') problems.push({ path: `body/cells/${index}`, message: `${lineWords(line)} is a made-to-measure unit: it is made on its own work order (New work order with that line alone).` })
  })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
}

// ---- the release check ---------------------------------------------------------------------------------------------------

/** A unit's cell as the release check reads it: the revision it is made to, the factory review, made-to-measure on. */
export interface UnitCell {
  readonly cellId: string
  /** "BLK 52". */
  readonly label: string
  readonly riderName: string
  readonly garmentType: string
  readonly revision: number
  readonly review: string
  /** GATE-MTM's words while made-to-measure is off for its template (else null). */
  readonly refusal: string | null
}

/** The cells of a MADE_TO_MEASURE work order with their revisions; null for any other kind (nothing to check). */
export async function readUnitCells(db: Reader, workOrder: Pick<Header, 'kind' | 'styleId'>, cells: readonly CellRow[]): Promise<UnitCell[] | null> {
  if (workOrder.kind !== 'MADE_TO_MEASURE' || cells.length === 0) return null
  const rows = await db.workOrderSize.findMany({ where: { id: { in: cells.map((cell) => cell.id) } }, select: { id: true, measurementProfileId: true } })
  const profileIds = [...new Set(rows.flatMap((row) => (row.measurementProfileId ? [row.measurementProfileId] : [])))]
  const profiles = new Map((await db.measurementProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, riderName: true, garmentType: true, revision: true, reviewStatus: true } })).map((row) => [row.id, row]))
  const out: UnitCell[] = []
  for (const cell of cells) {
    const profile = profiles.get(rows.find((row) => row.id === cell.id)?.measurementProfileId ?? '')
    if (!profile) continue
    out.push({ cellId: cell.id, label: `${cell.colourwayCode} ${cell.size}`, riderName: profile.riderName, garmentType: profile.garmentType, revision: profile.revision, review: profile.reviewStatus, refusal: await styleRefusal(db, workOrder.styleId, profile.garmentType) })
  }
  return out
}

/** W1's CELLS check with the units' own problems (made-to-measure off; measures not confirmed); a size run's check as it is. */
export function unitCellsCheck(base: ReleaseCheck, units: readonly UnitCell[] | null): ReleaseCheck {
  if (!units || units.length === 0) return base
  const problems: Issue[] = []
  for (const unit of units) {
    if (unit.refusal) problems.push({ path: `cells/${unit.cellId}/mtm`, message: `${unit.label} (made to measure for ${unit.riderName}): ${unit.refusal}` })
    if (unit.review !== 'CONFIRMED') {
      problems.push({ path: `cells/${unit.cellId}/measures`, message: `${unit.label}: ${unit.riderName}'s ${unit.garmentType} measures (revision ${unit.revision}) wait for the factory review; the unit is released once they are confirmed (Sales › Made-to-measure).` })
    }
  }
  if (problems.length === 0) {
    if (base.state !== 'OK') return base
    const made = units.map((unit) => `${unit.label} for ${unit.riderName}, ${unit.garmentType} revision ${unit.revision}`).join('; ')
    return { ...base, message: `${base.message} Made to measure (${made}), the measures confirmed by the factory review.` }
  }
  const message = base.state === 'BLOCKED' ? `${base.message} ${problems.map((problem) => problem.message).join(' ')}` : problems.map((problem) => problem.message).join(' ')
  return { code: 'CELLS', state: 'BLOCKED', message, problems: [...(base.state === 'BLOCKED' ? base.problems : []), ...problems] }
}
