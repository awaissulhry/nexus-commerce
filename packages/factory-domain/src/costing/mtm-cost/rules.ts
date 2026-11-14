import { Decimal } from 'decimal.js'
import type { BomLineData } from '../../product/bom/rules'
import { WORK_CENTRE_KINDS, type WorkCentreKind } from '../../product/routing/operations'
import type { Components, ComponentStep } from '../sheet-components/components'
import { six } from '../sheet-components/rules'
import { splitBySize } from '../sheet-components/split'

/**
 * One made-to-measure unit's cost (B-W2b-423; FIN-017), pure: one garment for one rider, made from a base size of the style's
 * range (B-W2b-248's base size: the typed one, else the one the measures point to) and costed as
 *
 *   base size        the base size's components (B-W2b-418, the garment without options)
 *   extra material   the BOM lines marked to scale with a point of measure (B-W2b-248 mtmScalePointId/Factor) at the unit's
 *                    quantity instead of the base size's (`consumptionOf`: base × (1 + factor × (measure ÷ base measure −
 *                    1))): the extra leather area and the materials that follow it, with their yield, freight and overhead
 *   alteration       the minutes the pattern maker and the floor add for this unit, per kind of work centre, at its labour
 *                    rate and overhead (no column keeps them: the person says them, as B-W2b-418's garments per carton)
 *   special parts    the unit's chosen options, each at its own cost (costing/option-cost, FIN-018)
 *
 * Off per measurement template like everything made to measure (GATE-MTM: the style flagged, its template's rules on): while
 * off the unit is refused in words, never costed as if it were started. A missing input is said in words, never 0.
 */

/** Why a unit is not costed (409 `refusal/<CODE>`; the API says the words, the web its own). */
export const MTM_COST_REFUSALS = ['MTM_NOT_STARTED', 'NO_REVISION', 'NO_BASE_SIZE'] as const
export type MtmCostRefusal = (typeof MTM_COST_REFUSALS)[number]

/** At most this many alteration entries. */
export const MAX_ALTERATIONS = 10

export interface Alteration {
  readonly workCentreKind: WorkCentreKind
  readonly minutes: string
}

/** One line of B-W2b-248's consumption (only the fields costing reads). */
export interface ScaledRow {
  readonly lineId: string
  readonly baseQty: string | null
  readonly unitQty: string | null
  readonly scaled: unknown
}

/** The lines with the unit's quantity in the base size where a line is scaled (the other sizes are not costed for a unit). */
export function scaledLines(lines: readonly BomLineData[], rows: readonly ScaledRow[], baseSize: string): { readonly lines: BomLineData[]; readonly scaled: number } {
  const byLine = new Map(rows.filter((row) => row.scaled !== null && row.unitQty !== null && row.baseQty !== null && row.unitQty !== row.baseQty).map((row) => [row.lineId, row.unitQty!]))
  let scaled = 0
  const out = lines.map((line) => {
    const qty = byLine.get(line.id)
    if (qty === undefined) return line
    scaled += 1
    if (!line.sizeDependent) return { ...line, qty }
    return { ...line, sizes: line.sizes.map((row) => (row.size === baseSize ? { ...row, qty } : row)) }
  })
  return { lines: out, scaled }
}

/** The alteration minutes as routing steps of the unit (never written: they only feed the computation). */
export function alterationSteps(alterations: readonly Alteration[]): ComponentStep[] {
  return alterations.map((entry, index) => ({ id: `alteration:${index}`, seq: 95000 + index, operationId: `alteration:${entry.workCentreKind}`, code: 'ALTERATION', name: `Alteration (${entry.workCentreKind.toLowerCase()})`, workCentreKind: entry.workCentreKind, standardMinutes: entry.minutes }))
}

export function alterationProblems(alterations: readonly Alteration[]): { readonly path: string; readonly message: string }[] {
  const issues: { path: string; message: string }[] = []
  if (alterations.length > MAX_ALTERATIONS) issues.push({ path: 'alterations', message: `At most ${MAX_ALTERATIONS} entries.` })
  alterations.forEach((entry, index) => {
    if (!WORK_CENTRE_KINDS.includes(entry.workCentreKind)) issues.push({ path: `alterations/${index}/workCentreKind`, message: 'A kind of work centre.' })
    if (!/^\d{1,5}(\.\d{1,3})?$/.test(entry.minutes) || !new Decimal(entry.minutes).gt(0)) issues.push({ path: `alterations/${index}/minutes`, message: 'Minutes above 0, with at most 3 decimals.' })
  })
  return issues
}

const totalAt = (components: Components, sizes: readonly string[], size: string): { known: Decimal; complete: boolean; missing: string[] } => {
  const split = splitBySize(components.lines, sizes, components.missing).find((entry) => entry.size === size)
  const missing = components.missing.filter((entry) => entry.size === null || entry.size === size).map((entry) => entry.message)
  return { known: new Decimal(split?.knownTotal ?? '0'), complete: split?.complete ?? false, missing }
}

export interface MtmCost {
  readonly baseSize: string
  readonly base: string | null
  readonly extraMaterial: string | null
  readonly alteration: string | null
  readonly options: string | null
  readonly total: string | null
  readonly complete: boolean
  readonly missing: readonly string[]
}

/**
 * The unit's figures at its base size: the base garment, the scaled one, the scaled one with the alteration steps, and the
 * chosen options' own cost (null: one of them is not known; undefined: none chosen).
 */
export function mtmCostOf(input: { readonly sizes: readonly string[]; readonly baseSize: string; readonly base: Components; readonly scaled: Components; readonly altered: Components; readonly options: string | null | undefined; readonly optionMissing: readonly string[] }): MtmCost {
  const { sizes, baseSize } = input
  const base = totalAt(input.base, sizes, baseSize)
  const scaled = totalAt(input.scaled, sizes, baseSize)
  const altered = totalAt(input.altered, sizes, baseSize)
  const missing = [...new Set([...base.missing, ...scaled.missing, ...altered.missing, ...input.optionMissing])]
  const known = base.complete && scaled.complete && altered.complete
  const options = input.options === undefined ? '0' : input.options
  const figures = {
    base: base.complete ? six(base.known) : null,
    extraMaterial: base.complete && scaled.complete ? six(scaled.known.minus(base.known)) : null,
    alteration: scaled.complete && altered.complete ? six(altered.known.minus(scaled.known)) : null,
    options,
  }
  const total = known && options !== null ? six(altered.known.plus(options)) : null
  return { baseSize, ...figures, total, complete: total !== null, missing }
}
