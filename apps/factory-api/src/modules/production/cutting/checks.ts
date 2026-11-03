import { gradeOfHide, type GradeFacts } from '@nexus/factory-domain/inventory/hides/usable'
import { shadeLotKey, shadeLotsOf, type ShadeFacts, type ShadeRule } from '@nexus/factory-domain/inventory/reservations/shade'
import { gradeVerdict } from '@nexus/factory-domain/product/pieces/rules'
import {
  garmentShadeWarning,
  gradeWarning,
  kindsOf,
  orderShadeWarning,
  piecesOfCut,
  standingWarnings,
  thicknessCheck,
  thicknessWarning,
  wrongHideWarning,
  type CutWarning,
  type CutWarningKind,
  type GradeRef,
  type HideIdentity,
  type PieceRef,
  type PlannedLine,
  type ReservedLeather,
  type ShadedPiece,
  type ShadeLotRef,
  type ThicknessCheck,
} from '@nexus/factory-domain/production/cutting/checks'
import { cellLabel, partOf } from '@nexus/factory-domain/production/cutting/rules'
import { heldShades, shadeFactsOf, shadeRuleFor } from '../../inventory/reservations/shade'
import { orderLinesOf } from '../../inventory/reservations/store'
import { liveOf, readCells, readEntries, readPieces, type CutHeader, type HideRow, type ItemRow, type LotRow, type Reader } from './store'

/**
 * The cutting table's leather checks as the API reads them (B-W2b-103; the rules: factory-domain production/cutting/checks).
 * `readCheckFacts` reads, as the caller (row-level security keeps a floor device to its own site), what the checks of one
 * hide for one work order look at: the site's shade rule and the shade lots the work order holds and has reserved
 * (inventory/reservations/shade, B-W2b-100's one reader), the work order's own leather reservations of the article (ACTIVE,
 * and whether the hide is one of them in any state but RELEASED), the grades (inventory/hides gradeOfHide: the record, else
 * the W1 text), the article's thickness range, the pattern pieces of the work order's revision (B-W2b-95) with the BOM lines
 * of the hide's material per cell, and the warnings a lead already passed for this hide and work order (its live entries'
 * `overrides`). Inside the cut command it runs BEFORE the scan issues the hide: the issue consumes the hide's reservation.
 * `evaluateChecks` turns them into warnings for one cut (the pieces it logs, the thickness typed) or, without a cut, for the
 * card (every piece of the hide's material in the work order).
 */

export interface CellFacts {
  readonly id: string
  readonly size: string
  readonly label: string
  /** The parts of the hide's material in the cell (partOf the BOM line's place, else the material's code). */
  readonly parts: readonly string[]
}

export interface CheckFacts {
  readonly workOrder: { readonly id: string; readonly number: string }
  readonly hideCode: string
  readonly itemCode: string
  readonly rule: ShadeRule
  readonly hideShade: ShadeFacts
  /** What the work order holds (issued less returned above 0) and has reserved of the leather (B-W2b-100's heldShades). */
  readonly held: readonly ShadeFacts[]
  readonly identity: HideIdentity
  /** The work order's own ACTIVE leather reservations of the article (hides by name, areas). */
  readonly reserved: readonly ReservedLeather[]
  /** The hide is reserved for the work order by name (ACTIVE or already ISSUED to it). */
  readonly reservedForIt: boolean
  readonly hideGrade: GradeRef | null
  /** The grade came from the W1 text (no record named). */
  readonly gradeByText: boolean
  readonly thickness: { readonly minMm: string | null; readonly maxMm: string | null; readonly recordedMm: string | null }
  readonly pieces: readonly PieceRef[]
  readonly planned: readonly PlannedLine[]
  readonly cells: ReadonlyMap<string, CellFacts>
  /** The kinds a lead passed for this hide and work order (the live entries' overrides). */
  readonly passed: readonly CutWarningKind[]
}

const mm = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : value.toString())

/** The tenant's grades, as gradeOfHide reads them. */
async function readGrades(db: Reader): Promise<GradeFacts[]> {
  const rows = await db.leatherGrade.findMany({ select: { id: true, code: true, labelIt: true, labelEn: true, usableShare: true, sortOrder: true, active: true } })
  return rows.map((row) => ({ ...row, usableShare: row.usableShare.toString() }))
}

const gradeRef = (grade: GradeFacts | null | undefined): GradeRef | null => (grade ? { id: grade.id, code: grade.code, sortOrder: grade.sortOrder } : null)

/** Every fact the checks of this hide for this work order read (see the header). */
export async function readCheckFacts(db: Reader, input: { readonly workOrder: CutHeader; readonly hide: HideRow; readonly lot: LotRow; readonly item: ItemRow }): Promise<CheckFacts> {
  const { workOrder, hide, lot, item } = input
  const rule = await shadeRuleFor(db, workOrder.siteId)
  const hideShade = (await shadeFactsOf(db, [hide.id])).get(hide.id)!
  const held = await heldShades(db, { siteId: workOrder.siteId, workOrderId: workOrder.id, salesOrderLineId: null, itemId: hide.itemId, itemColourId: lot.itemColourId })
  const grades = await readGrades(db)
  const graded = gradeOfHide(hide, grades)

  // The work order's own leather reservations of the article: made for it, or for an order line one of its cells makes.
  const lines = [...(await orderLinesOf(db, workOrder.id))]
  const rows = await db.reservation.findMany({
    where: { itemId: hide.itemId, kind: { in: ['HIDE', 'AREA'] }, status: { in: ['ACTIVE', 'ISSUED'] }, OR: [{ workOrderId: workOrder.id }, ...(lines.length > 0 ? [{ salesOrderLineId: { in: lines } }] : [])] },
    select: { kind: true, status: true, hideId: true, lotId: true, itemColourId: true },
  })
  const reservedIds = [...new Set(rows.flatMap((row) => (row.hideId ? [row.hideId] : [])))]
  const reservedHides = new Map((reservedIds.length > 0 ? await db.hide.findMany({ where: { id: { in: reservedIds } }, select: { id: true, code: true, grade: true, gradeId: true } }) : []).map((row) => [row.id, row]))
  const lotIds = [...new Set(rows.flatMap((row) => (row.lotId ? [row.lotId] : [])))]
  const lotCodes = new Map((lotIds.length > 0 ? await db.lot.findMany({ where: { id: { in: lotIds } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code]))
  const reserved: ReservedLeather[] = rows
    .filter((row) => row.status === 'ACTIVE' && (row.kind === 'HIDE' || row.kind === 'AREA'))
    .map((row) => {
      const named = row.hideId ? reservedHides.get(row.hideId) : undefined
      return {
        kind: row.kind as 'HIDE' | 'AREA',
        hideId: row.hideId,
        hideCode: named?.code ?? null,
        lotId: row.lotId,
        lotCode: row.lotId ? (lotCodes.get(row.lotId) ?? null) : null,
        itemColourId: row.itemColourId,
        grade: named ? (gradeOfHide(named, grades).grade?.code ?? named.grade) : null,
      }
    })
  const reservedForIt = rows.some((row) => row.kind === 'HIDE' && row.hideId === hide.id)

  // The pattern pieces of the work order's revision and the BOM lines of the hide's material per cell.
  const gradeById = new Map(grades.map((grade) => [grade.id, grade]))
  const pieceRows = workOrder.styleRevisionId ? await db.patternPiece.findMany({ where: { revisionId: workOrder.styleRevisionId }, select: { name: true, bomLineId: true, minGradeId: true, sizes: true }, orderBy: { seq: 'asc' } }) : []
  const pieces: PieceRef[] = pieceRows.map((row) => ({ name: row.name, bomLineId: row.bomLineId, minGrade: row.minGradeId ? gradeRef(gradeById.get(row.minGradeId)) : null, sizes: row.sizes }))
  const materials = await db.workOrderMaterial.findMany({ where: { workOrderId: workOrder.id, itemId: hide.itemId, itemColourId: lot.itemColourId }, select: { workOrderSizeId: true, bomLineId: true } })
  const bomLineIds = [...new Set(materials.map((row) => row.bomLineId))]
  const placements = new Map((bomLineIds.length > 0 ? await db.bomLine.findMany({ where: { id: { in: bomLineIds } }, select: { id: true, placement: true } }) : []).map((row) => [row.id, row.placement]))
  const planned: PlannedLine[] = materials.map((row) => ({ cellId: row.workOrderSizeId, bomLineId: row.bomLineId, part: partOf(placements.get(row.bomLineId), item.code) }))
  const cells = new Map<string, CellFacts>()
  for (const cell of await readCells(db, workOrder.id, workOrder.styleId)) {
    const parts = [...new Set(planned.filter((row) => row.cellId === cell.id).map((row) => row.part))].sort()
    cells.set(cell.id, { id: cell.id, size: cell.size, label: cellLabel(cell.colourwayCode, cell.size), parts })
  }

  // What a lead passed for this hide and work order: the overrides of its live entries.
  const passedRows = await db.cutLog.findMany({ where: { workOrderId: workOrder.id, hideId: hide.id, reversalOfId: null, reversals: { none: {} }, NOT: { overrides: { isEmpty: true } } }, select: { overrides: true } })
  const passed = kindsOf(passedRows.flatMap((row) => row.overrides.map((kind) => ({ kind: kind as CutWarningKind }))))

  return {
    workOrder: { id: workOrder.id, number: workOrder.number },
    hideCode: hide.code,
    itemCode: item.code,
    rule,
    hideShade,
    held,
    identity: { id: hide.id, code: hide.code, lotId: hide.lotId, lotCode: lot.code, itemColourId: lot.itemColourId, grade: graded.grade?.code ?? hide.grade },
    reserved,
    reservedForIt,
    hideGrade: gradeRef(graded.grade),
    gradeByText: graded.byText,
    thickness: { minMm: mm(item.thicknessMinMm), maxMm: mm(item.thicknessMaxMm), recordedMm: mm(hide.thicknessMm) },
    pieces,
    planned,
    cells,
    passed,
  }
}

/** GARMENT: the work order's live pieces with the shade facts of their entry's hide, oldest entry first. */
export async function readShadedPieces(db: Reader, workOrderId: string): Promise<ShadedPiece[]> {
  const live = liveOf(await readEntries(db, workOrderId))
  const hideOf = new Map(live.map((entry) => [entry.id, entry.hideId]))
  const shades = await shadeFactsOf(db, [...new Set(live.map((entry) => entry.hideId))])
  return (await readPieces(db, live.map((entry) => entry.id))).flatMap((piece) => {
    const shade = shades.get(hideOf.get(piece.cutLogId) ?? '')
    return shade ? [{ cellId: piece.cellId, part: piece.part, pieces: piece.pieces, shade }] : []
  })
}

/** What one cut logs, as the checks read it: whole sets per cell, single parts by name, the thickness typed at the table. */
export interface CheckedCut {
  readonly sets: readonly string[]
  readonly singleParts: readonly { readonly cellId: string; readonly part: string }[]
  readonly measuredMm: string | null
  /** GARMENT only: the live pieces with their hides' shade facts (readShadedPieces). */
  readonly shaded: readonly ShadedPiece[]
}

export interface CheckResult {
  readonly warnings: CutWarning[]
  /** The kinds no lead passed yet for this hide and work order. */
  readonly standing: CutWarningKind[]
  readonly standingWarnings: CutWarning[]
  readonly passed: readonly CutWarningKind[]
  /** The card's facts (design floor.hidecut "Check the hide"). */
  readonly shade: { readonly rule: ShadeRule; readonly cutFrom: ShadeLotRef[]; readonly hide: ShadeLotRef & { readonly outOfShade: boolean }; readonly same: boolean | null }
  readonly thickness: ThicknessCheck
  readonly grade: { readonly hide: string | null; readonly byText: boolean; readonly pieces: { readonly name: string; readonly minGrade: string | null; readonly verdict: 'OK' | 'BELOW' | 'UNKNOWN' }[] }
  readonly reserved: { readonly forIt: boolean; readonly hides: string[]; readonly lots: string[] }
}

/**
 * The warnings of a cut (`cut`), or of the card before one (null: every piece of the hide's material in the work order, no
 * GARMENT check: no part is chosen yet), and the facts the card shows.
 */
export function evaluateChecks(facts: CheckFacts, cut: CheckedCut | null): CheckResult {
  const others = facts.held.filter((other) => other.hideId !== facts.hideShade.hideId)
  const cutFrom = shadeLotsOf(others).map((lot) => ({ lotCode: lot.first.lotCode, shadeLabel: lot.first.shadeLabel?.trim() || null }))
  const chosen = cut
    ? [
        ...cut.sets.map((cellId) => ({ cellId, size: facts.cells.get(cellId)?.size ?? '', parts: facts.cells.get(cellId)?.parts ?? [] })),
        ...cut.singleParts.map((row) => ({ cellId: row.cellId, size: facts.cells.get(row.cellId)?.size ?? '', parts: [row.part] })),
      ]
    : [...facts.cells.values()].filter((cell) => cell.parts.length > 0).map((cell) => ({ cellId: cell.id, size: cell.size, parts: cell.parts }))
  const pieces = piecesOfCut(facts.pieces, facts.planned, chosen)
  const thickness = thicknessCheck({ ...facts.thickness, measuredMm: cut?.measuredMm ?? null })
  const warnings = [
    orderShadeWarning(facts.rule, facts.workOrder.number, facts.held, facts.hideShade),
    cut ? garmentShadeWarning(facts.rule, facts.cells, cut.shaded, cut.singleParts, facts.hideShade) : null,
    facts.reservedForIt ? null : wrongHideWarning(facts.workOrder.number, facts.reserved, facts.identity),
    thicknessWarning(thickness, facts.hideCode, facts.itemCode),
    gradeWarning(facts.hideCode, facts.hideGrade, pieces),
  ].filter((warning): warning is CutWarning => warning !== null)
  const standing = standingWarnings(warnings, facts.passed)
  return {
    warnings,
    standing: kindsOf(standing),
    standingWarnings: standing,
    passed: facts.passed,
    shade: {
      rule: facts.rule,
      cutFrom,
      hide: { lotCode: facts.hideShade.lotCode, shadeLabel: facts.hideShade.shadeLabel?.trim() || null, outOfShade: facts.hideShade.outOfShade },
      same: others.length === 0 ? null : others.some((other) => shadeLotKey(other) === shadeLotKey(facts.hideShade)),
    },
    thickness,
    grade: { hide: facts.hideGrade?.code ?? null, byText: facts.gradeByText, pieces: pieces.map((piece) => ({ name: piece.name, minGrade: piece.minGrade?.code ?? null, verdict: gradeVerdict(facts.hideGrade, piece.minGrade) })) },
    reserved: {
      forIt: facts.reservedForIt,
      hides: [...new Set(facts.reserved.flatMap((row) => (row.kind === 'HIDE' && row.hideCode ? [row.hideCode] : [])))].sort(),
      lots: [...new Set(facts.reserved.flatMap((row) => (row.lotCode ? [row.lotCode] : [])))].sort(),
    },
  }
}
