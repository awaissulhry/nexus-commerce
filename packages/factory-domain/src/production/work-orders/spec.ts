import { colourIn, lineNeed } from '../../product/bom/requirements'
import type { BomLineData } from '../../product/bom/rules'
import type { WorkCentreKind } from '../../product/routing/operations'
import { inOrder, type StepData } from '../../product/routing/rules'
import { decimalText, QUANTITY_SCALE, roundTo, type ItemUnits, type RoundTo, type Uom } from '../../product/units/units'

/**
 * The frozen specification's parts (B-W1-38 "B6 frozen spec builder"; features MES-005, PRD-192; plan A1 §2.4 E), pure:
 * what the release writes beside the revision and its label template, so the floor and the ledger read one fixed
 * specification however the style changes later.
 *
 *   operations  ONE per step of the revision's routing, in routing order: its place `seq` = the step's place
 *               (`routingSeq`), its code, name, standard minutes and scan flag copied exactly (the …_production_guards
 *               trigger compares them), at an ACTIVE work centre of the step's kind on the work order's site (the
 *               first by code). A kind the site has no active centre of blocks the release, in words.
 *   materials   ONE per BOM line used by a cell (the line is of the cell's colourway and the size takes some of it):
 *               the line's quantity for the size × (1 + wastage) × the cell's pieces, in the line's unit and in the
 *               material's base unit, each rounded UP once to 4 decimals (an issue is never planned short), with the
 *               material colour the colourway takes.
 *   sizes       a cell's size must be in the frozen BOM: every size-dependent line has a quantity for it (0 is an
 *               answer: the size uses none), and every colour-dependent line names a colour for the cell's
 *               colourway. A size or colourway added to the style after the revision was released is not in it: the
 *               release is held until a revision that has it is released (the BOM's own rule, w1-13).
 */

/** Planned quantities are rounded up once, to the quantity scale. */
export const PLANNED_ROUND: RoundTo = { scale: QUANTITY_SCALE, rounding: 'UP' }

/** A cell as the builder reads it. */
export interface SpecCell {
  readonly id: string
  readonly colourwayId: string
  /** The colourway's code, for messages ("BLK 52"). */
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
}

/** A work centre of the site. */
export interface SiteWorkCentre {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: WorkCentreKind
  readonly status: string
}

export interface PlannedOperation {
  readonly seq: number
  readonly routingSeq: number
  readonly stepId: string
  readonly code: string
  readonly name: string
  readonly standardMinutes: string
  readonly scanRequired: boolean
  readonly workCentreKind: WorkCentreKind
  /** Null when the site has no active work centre of the step's kind (a release blocker). */
  readonly workCentreId: string | null
  readonly workCentreCode: string | null
}

/** A kind of work centre the routing needs that the site has no active centre of, with the steps that need it. */
export interface MissingWorkCentre {
  readonly kind: WorkCentreKind
  readonly steps: readonly { readonly seq: number; readonly code: string; readonly name: string }[]
}

/** The routing mapped to the site's work centres. */
export function planOperations(steps: readonly StepData[], centres: readonly SiteWorkCentre[]): { readonly operations: PlannedOperation[]; readonly missing: MissingWorkCentre[] } {
  const active = [...centres].filter((centre) => centre.status === 'ACTIVE').sort((a, b) => a.code.localeCompare(b.code))
  const missing = new Map<WorkCentreKind, { seq: number; code: string; name: string }[]>()
  const operations = inOrder(steps).map((step) => {
    const centre = active.find((entry) => entry.kind === step.workCentreKind) ?? null
    if (!centre) missing.set(step.workCentreKind, [...(missing.get(step.workCentreKind) ?? []), { seq: step.seq, code: step.code, name: step.name }])
    return {
      seq: step.seq,
      routingSeq: step.seq,
      stepId: step.id,
      code: step.code,
      name: step.name,
      standardMinutes: step.standardMinutes,
      scanRequired: step.scanRequired,
      workCentreKind: step.workCentreKind,
      workCentreId: centre?.id ?? null,
      workCentreCode: centre?.code ?? null,
    }
  })
  return { operations, missing: [...missing].map(([kind, list]) => ({ kind, steps: list })) }
}

export interface PlannedMaterial {
  readonly bomLineId: string
  readonly lineSeq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly cellId: string
  /** In the BOM line's unit, waste included (decimal text, 4 places at most). */
  readonly quantity: string
  readonly uom: Uom
  /** In the material's base unit. */
  readonly baseQuantity: string
  readonly baseUom: Uom
}

export const BOM_GAP_CODES = ['SIZE_NOT_IN_BOM', 'COLOURWAY_NOT_IN_BOM', 'UNIT_NOT_CONVERTIBLE'] as const
export type BomGapCode = (typeof BOM_GAP_CODES)[number]

/** A cell the frozen BOM cannot plan: its size or colourway is not in it, or a line's unit does not convert. */
export interface BomGap {
  readonly code: BomGapCode
  readonly cellId: string
  readonly bomLineId: string
  readonly message: string
}

/**
 * The planned materials of the cells (BOM line × cell) and the cells the frozen BOM cannot plan. `itemCode` names the
 * material in messages.
 */
export function planMaterials(
  lines: readonly BomLineData[],
  cells: readonly SpecCell[],
  unitsOf: (itemId: string) => ItemUnits | undefined,
  itemCode: (itemId: string) => string,
): { readonly materials: PlannedMaterial[]; readonly gaps: BomGap[] } {
  const ordered = [...lines].sort((a, b) => a.seq - b.seq)
  const materials: PlannedMaterial[] = []
  const gaps: BomGap[] = []
  for (const cell of cells) {
    const label = `${cell.colourwayCode} ${cell.size}`
    for (const line of ordered) {
      const what = `line ${line.seq} (${itemCode(line.itemId)})`
      if (line.colourwayId !== null && line.colourwayId !== cell.colourwayId) continue
      const colour = colourIn(line, cell.colourwayId)
      if (colour === undefined) {
        gaps.push({ code: 'COLOURWAY_NOT_IN_BOM', cellId: cell.id, bomLineId: line.id, message: `${label}: the colourway is not in the revision's BOM (${what} names no colour for it).` })
        continue
      }
      if (line.sizeDependent && !line.sizes.some((entry) => entry.size === cell.size)) {
        gaps.push({ code: 'SIZE_NOT_IN_BOM', cellId: cell.id, bomLineId: line.id, message: `${label}: size ${cell.size} is not in the revision's BOM (${what} has no quantity for it).` })
        continue
      }
      const units = unitsOf(line.itemId)
      const need = units ? lineNeed(line, cell.size, units) : null
      if (!units || need === null) {
        gaps.push({ code: 'UNIT_NOT_CONVERTIBLE', cellId: cell.id, bomLineId: line.id, message: `${label}: ${what} is in ${line.uom}, which the material does not convert to its stock unit.` })
        continue
      }
      if (need.gross.isZero()) continue
      materials.push({
        bomLineId: line.id,
        lineSeq: line.seq,
        itemId: line.itemId,
        itemColourId: colour,
        cellId: cell.id,
        quantity: decimalText(roundTo(need.gross.times(cell.quantity), PLANNED_ROUND)),
        uom: line.uom,
        baseQuantity: decimalText(roundTo(need.base.times(cell.quantity), PLANNED_ROUND)),
        baseUom: units.baseUom,
      })
    }
  }
  return { materials, gaps }
}
