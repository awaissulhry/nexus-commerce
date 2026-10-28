import type { Issue } from '../../core/errors'
import type { ItemKind, MaterialStatus } from '../materials/rules'
import type { MasterStatus } from '../sizes/rules'
import type { StyleStatus } from '../styles/rules'
import type { RevisionStatus } from '../styles/revisions'
import { baseFactor, convertibleUnits, decimalOf, decimalText, UNITS, type ItemUnits, type Uom } from '../units/units'

/**
 * A style revision's BOM (plan A1 §2.4 B, §2.5; features PRD-043, PRD-076, PRD-079, PRD-082, PRD-100), pure. One BOM per
 * revision serves every size and colourway of the style (PRD-100); a line is tagged only where it differs:
 *
 *   material    an ACTIVE material of the library when it is chosen (the line keeps it if it is archived later; the
 *               release refuses it then); its unit is one the material converts to its base unit (units module)
 *   quantity    per garment, in the line's unit, above 0; a SIZE-DEPENDENT line (PRD-079, PRD-082: leather area per
 *               size) has a quantity for EVERY size of the style's range instead, 0 where the size does not use it; its
 *               own `qty` is then the base size's (else the first size's), kept by the rules, never typed
 *   wastage     0 to 60 %, added on top of the quantity: waste and, on leather, the hide's yield (PRD-082)
 *   colour      a COLOUR-DEPENDENT line (PRD-043) names the material colour of every ACTIVE colourway in the colour
 *               grid; any other line names one colour for every colourway when the material comes in colours
 *   colourway   a line of one colourway only (PRD-100) names its colour directly, never through the grid
 *
 * What one garment needs is quantity × (1 + wastage ÷ 100), converted to the material's base (stock) unit exactly and
 * rounded once, where the caller says (./requirements). A change is checked by `planLine` (refused at once); what a
 * draft still lacks is listed by `bomIssues` (blockers stop the release, warnings do not).
 */

/** Wastage is a percentage from 0 to this. */
export const MAX_WASTAGE_PCT = '60'
export const MAX_BOM_LINES = 200
/** New lines are numbered 10, 20, 30 … so a line fits between two later. */
export const SEQ_STEP = 10
export const MAX_SEQ = 99_999

export interface SizeQuantity {
  readonly size: string
  /** Per garment of this size, in the line's unit (a plain decimal string). */
  readonly qty: string
}

export interface ColourCell {
  readonly colourwayId: string
  readonly itemColourId: string
}

/** A line as stored (decimals as plain decimal strings). */
export interface BomLineFields {
  readonly seq: number
  readonly itemId: string
  /** Where it goes: front panel, sleeve, lining, armour pocket. */
  readonly placement: string | null
  readonly qty: string
  readonly uom: Uom
  readonly wastagePct: string
  readonly sizeDependent: boolean
  readonly colourDependent: boolean
  /** The one material colour of every colourway (not colour-dependent). */
  readonly itemColourId: string | null
  /** Only in this colourway; null: every colourway. */
  readonly colourwayId: string | null
  /** Bought from this supplier when not the material's default. */
  readonly supplierId: string | null
  readonly note: string | null
  /** A size-dependent line's quantities, in the range's order. */
  readonly sizes: readonly SizeQuantity[]
  /** A colour-dependent line's grid cells, in the style's colourway order. */
  readonly colours: readonly ColourCell[]
}

export interface BomLineData extends BomLineFields {
  readonly id: string
}

/** What the rules read about a line's material. */
export interface BomMaterial {
  readonly id: string
  readonly code: string
  readonly kind: ItemKind
  readonly status: MaterialStatus
  readonly units: ItemUnits
  /** Every colour of the material, archived ones too. */
  readonly colours: readonly { readonly id: string; readonly code: string; readonly status: MasterStatus }[]
}

export interface BomColourway {
  readonly id: string
  readonly code: string
  readonly status: MasterStatus
}

/** What the rules read about the style. */
export interface BomStyle {
  /** The range: size codes in the scale's order. */
  readonly sizes: readonly string[]
  readonly baseSize: string | null
  /** Every colourway of the style, in its order, archived ones too. */
  readonly colourways: readonly BomColourway[]
}

/** A line as typed: on a new line what is left out takes its default; on a change, what is left out stays. */
export interface LineChange {
  readonly itemId?: string | undefined
  readonly placement?: string | null | undefined
  readonly uom?: Uom | undefined
  readonly qty?: string | undefined
  readonly wastagePct?: string | undefined
  readonly sizeDependent?: boolean | undefined
  /** Merged into the line's quantities: a size with a quantity is set, a size with null is cleared. */
  readonly sizes?: readonly { readonly size: string; readonly qty: string | null }[] | undefined
  readonly colourDependent?: boolean | undefined
  readonly itemColourId?: string | null | undefined
  /** Merged into the line's grid: a colourway with a colour is set, a colourway with null is cleared. */
  readonly colours?: readonly { readonly colourwayId: string; readonly itemColourId: string | null }[] | undefined
  readonly colourwayId?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly note?: string | null | undefined
  readonly seq?: number | undefined
}

export type LinePlan = { readonly ok: true; readonly line: BomLineFields } | { readonly ok: false; readonly issues: readonly Issue[] }

const ZERO = decimalOf('0')
const isZero = (value: string): boolean => decimalOf(value).isZero()

/** A quantity as stored: plain decimal text without trailing zeros ("45", "1.8"). */
export const quantityText = (value: string): string => decimalText(value)

/** The line's own quantity when it is size-dependent: the base size's, else the first size's of the range, else 0. */
export function sizeDependentQty(sizes: readonly SizeQuantity[], style: Pick<BomStyle, 'sizes' | 'baseSize'>): string {
  const of = new Map(sizes.map((row) => [row.size, row.qty]))
  if (style.baseSize !== null && of.has(style.baseSize)) return quantityText(of.get(style.baseSize)!)
  const first = style.sizes.find((size) => of.has(size))
  return first === undefined ? '0' : quantityText(of.get(first)!)
}

/** The rows in the range's order; sizes outside the range (left from an older range) last, as they came. */
export function inRangeOrder<Row extends { readonly size: string }>(rows: readonly Row[], range: readonly string[]): Row[] {
  const order = new Map(range.map((size, index) => [size, index]))
  return [...rows].sort((a, b) => (order.get(a.size) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.size) ?? Number.MAX_SAFE_INTEGER))
}

/** The next free place at the end of the BOM: the next multiple of SEQ_STEP after the highest. */
export const nextSeq = (lines: readonly { readonly seq: number }[]): number => (Math.floor(lines.reduce((top, line) => Math.max(top, line.seq), 0) / SEQ_STEP) + 1) * SEQ_STEP

export function wastageProblem(value: string): string | null {
  const wastage = decimalOf(value, 'wastagePct')
  if (wastage.isNegative() || wastage.gt(MAX_WASTAGE_PCT)) return `Wastage is 0 to ${MAX_WASTAGE_PCT} %.`
  return null
}

/** The share of a hide's area the cutting plan expects to use (PRD-082): above 0, at most 100 %. */
export function hideYieldProblem(value: string | null): string | null {
  if (value === null) return null
  const yieldPct = decimalOf(value, 'plannedHideYieldPct')
  if (yieldPct.lte(0) || yieldPct.gt(100)) return 'The planned hide yield is above 0 and at most 100 %.'
  return null
}

const unitProblem = (uom: Uom, material: BomMaterial): string | null =>
  baseFactor(uom, material.units) === null
    ? `${material.code} does not convert ${UNITS[uom].symbol} to its base unit ${UNITS[material.units.baseUom].symbol}: use ${convertibleUnits(material.units).join(', ')}.`
    : null

/**
 * A new line (`current` null) or a change to one, checked against its material and the style: the line as it will be
 * stored, or every problem at once (paths relative to the request body). `material` is the line's material after the
 * change; `seq` the place a new line takes when none is sent.
 */
export function planLine(current: BomLineFields | null, change: LineChange, material: BomMaterial, style: BomStyle, seq: number): LinePlan {
  const issues: Issue[] = []
  const itemId = change.itemId ?? current?.itemId
  if (itemId === undefined) return { ok: false, issues: [{ path: 'itemId', message: 'Choose the material.' }] }
  if (itemId !== material.id) throw new Error(`planLine: the material read (${material.id}) is not the line's (${itemId})`)
  const materialChosen = current === null || current.itemId !== itemId
  if (materialChosen && material.status !== 'ACTIVE') issues.push({ path: 'itemId', message: `${material.code} is archived: choose an active material.` })

  // Unit and wastage.
  const uom = change.uom ?? current?.uom ?? material.units.consumptionUom
  const badUnit = unitProblem(uom, material)
  if (badUnit && (change.uom !== undefined || materialChosen)) issues.push({ path: 'uom', message: badUnit })
  const wastagePct = quantityText(change.wastagePct ?? current?.wastagePct ?? '0')
  const badWastage = wastageProblem(wastagePct)
  if (badWastage) issues.push({ path: 'wastagePct', message: badWastage })

  // Quantity: one for every size, or one per size of the range.
  const sizeDependent = change.sizeDependent ?? current?.sizeDependent ?? false
  let sizes: SizeQuantity[] = []
  let qty: string
  if (sizeDependent) {
    if (change.qty !== undefined) issues.push({ path: 'qty', message: 'A size-dependent line takes its quantity per size: send sizes.' })
    if (current?.sizeDependent) sizes = [...current.sizes]
    else if (current !== null && !isZero(current.qty)) sizes = style.sizes.map((size) => ({ size, qty: current.qty }))
    const of = new Map(sizes.map((row) => [row.size, row.qty]))
    const seen = new Set<string>()
    for (const entry of change.sizes ?? []) {
      const at = `sizes/${entry.size}`
      if (seen.has(entry.size)) {
        issues.push({ path: at, message: `Size ${entry.size} is sent twice.` })
        continue
      }
      seen.add(entry.size)
      if (entry.qty === null) {
        of.delete(entry.size)
        continue
      }
      if (!style.sizes.includes(entry.size)) issues.push({ path: at, message: `Size ${entry.size} is not in the style's range (${style.sizes.join(', ') || 'none yet'}).` })
      else if (decimalOf(entry.qty, at).isNegative()) issues.push({ path: at, message: 'A quantity is 0 (the size does not use the line) or more.' })
      else of.set(entry.size, quantityText(entry.qty))
    }
    sizes = inRangeOrder(
      [...of].map(([size, value]) => ({ size, qty: value })),
      style.sizes,
    )
    qty = sizeDependentQty(sizes, style)
  } else {
    if ((change.sizes ?? []).length > 0) issues.push({ path: 'sizes', message: 'The line is not size-dependent: make it size-dependent to give a quantity per size.' })
    const given = change.qty ?? current?.qty
    if (given === undefined) {
      issues.push({ path: 'qty', message: 'Say how much one garment takes.' })
      qty = '0'
    } else {
      qty = quantityText(given)
      if (!decimalOf(qty, 'qty').gt(ZERO)) issues.push({ path: 'qty', message: 'The quantity is above 0.' })
    }
  }

  // Colourway and colour.
  const colourwayId = change.colourwayId === undefined ? (current?.colourwayId ?? null) : change.colourwayId
  const colourwayOf = new Map(style.colourways.map((colourway) => [colourway.id, colourway]))
  if (colourwayId !== null) {
    const colourway = colourwayOf.get(colourwayId)
    if (!colourway) issues.push({ path: 'colourwayId', message: 'No such colourway of this style.' })
    else if (colourway.status !== 'ACTIVE' && colourwayId !== current?.colourwayId) issues.push({ path: 'colourwayId', message: `Colourway ${colourway.code} is archived.` })
  }
  const colourOf = new Map(material.colours.map((colour) => [colour.id, colour]))
  const colourProblem = (itemColourId: string, chosen: boolean): string | null => {
    const colour = colourOf.get(itemColourId)
    if (!colour) return `Not a colour of ${material.code}.`
    if (chosen && colour.status !== 'ACTIVE') return `Colour ${colour.code} of ${material.code} is archived.`
    return null
  }
  const colourDependent = change.colourDependent ?? current?.colourDependent ?? false
  let itemColourId: string | null = null
  let colours: ColourCell[] = []
  if (colourDependent) {
    if (colourwayId !== null) issues.push({ path: 'colourDependent', message: 'A line of one colourway names its material colour directly (itemColourId), not through the colour grid.' })
    if (material.colours.length === 0) issues.push({ path: 'colourDependent', message: `${material.code} has no colours: it cannot change colour with the colourway.` })
    if (change.itemColourId !== undefined && change.itemColourId !== null) issues.push({ path: 'itemColourId', message: 'A colour-dependent line takes its colour per colourway: send colours.' })
    const start: ColourCell[] =
      current?.colourDependent && !materialChosen
        ? [...current.colours]
        : current !== null && !materialChosen && current.itemColourId !== null
          ? style.colourways.filter((colourway) => colourway.status === 'ACTIVE').map((colourway) => ({ colourwayId: colourway.id, itemColourId: current.itemColourId! }))
          : []
    const before = new Map(start.map((cell) => [cell.colourwayId, cell.itemColourId]))
    const cells = new Map(before)
    const seen = new Set<string>()
    for (const entry of change.colours ?? []) {
      const at = `colours/${entry.colourwayId}`
      if (seen.has(entry.colourwayId)) {
        issues.push({ path: at, message: 'This colourway is sent twice.' })
        continue
      }
      seen.add(entry.colourwayId)
      const colourway = colourwayOf.get(entry.colourwayId)
      if (!colourway) {
        issues.push({ path: at, message: 'No such colourway of this style.' })
        continue
      }
      if (entry.itemColourId === null) {
        cells.delete(entry.colourwayId)
        continue
      }
      const chosen = before.get(entry.colourwayId) !== entry.itemColourId
      if (chosen && colourway.status !== 'ACTIVE') {
        issues.push({ path: at, message: `Colourway ${colourway.code} is archived.` })
        continue
      }
      const problem = colourProblem(entry.itemColourId, chosen)
      if (problem) issues.push({ path: at, message: problem })
      else cells.set(entry.colourwayId, entry.itemColourId)
    }
    const order = new Map(style.colourways.map((colourway, index) => [colourway.id, index]))
    colours = [...cells]
      .map(([cellColourway, cellColour]) => ({ colourwayId: cellColourway, itemColourId: cellColour }))
      .sort((a, b) => (order.get(a.colourwayId) ?? 0) - (order.get(b.colourwayId) ?? 0))
  } else {
    if ((change.colours ?? []).length > 0) issues.push({ path: 'colours', message: 'The line is not colour-dependent: make it colour-dependent to give a colour per colourway.' })
    itemColourId = change.itemColourId !== undefined ? change.itemColourId : materialChosen ? null : (current?.itemColourId ?? null)
    if (itemColourId !== null) {
      const problem = colourProblem(itemColourId, materialChosen || itemColourId !== current?.itemColourId)
      if (problem) issues.push({ path: 'itemColourId', message: problem })
    }
  }

  const keep = <Value>(sent: Value | undefined, stored: Value | undefined, fallback: Value): Value => (sent !== undefined ? sent : stored !== undefined ? stored : fallback)
  const line: BomLineFields = {
    seq: change.seq ?? current?.seq ?? seq,
    itemId,
    placement: keep(change.placement, current?.placement, null),
    qty,
    uom,
    wastagePct,
    sizeDependent,
    colourDependent,
    itemColourId,
    colourwayId,
    supplierId: keep(change.supplierId, current?.supplierId, null),
    note: keep(change.note, current?.note, null),
    sizes,
    colours,
  }
  if (line.seq < 1 || line.seq > MAX_SEQ || !Number.isInteger(line.seq)) issues.push({ path: 'seq', message: `The place is a whole number from 1 to ${MAX_SEQ}.` })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, line }
}

// ---- what a draft still lacks ------------------------------------------------------------------------------------------

/** Blockers (stop the release) and warnings (shown only). */
export const BOM_BLOCKERS = [
  'NO_LINES',
  'NO_SIZE_RANGE',
  'NO_ACTIVE_COLOURWAY',
  'MATERIAL_ARCHIVED',
  'UNIT_NOT_CONVERTIBLE',
  'QUANTITY_NOT_POSITIVE',
  'WASTAGE_OUT_OF_RANGE',
  'SIZE_QUANTITY_MISSING',
  'SIZE_OUTSIDE_RANGE',
  'SIZE_QUANTITIES_ALL_ZERO',
  'COLOUR_MISSING',
  'COLOUR_ARCHIVED',
] as const
export const BOM_WARNINGS = ['LEATHER_WITHOUT_WASTAGE', 'NO_PLANNED_HIDE_YIELD', 'LINE_OF_ARCHIVED_COLOURWAY'] as const
export const BOM_ISSUE_CODES = [...BOM_BLOCKERS, ...BOM_WARNINGS] as const
export type BomIssueCode = (typeof BOM_ISSUE_CODES)[number]

export interface BomIssue {
  readonly code: BomIssueCode
  readonly lineId: string | null
  readonly size: string | null
  readonly colourwayId: string | null
  readonly message: string
}

export interface BomCheck {
  readonly blockers: readonly BomIssue[]
  readonly warnings: readonly BomIssue[]
}

/**
 * What the BOM still lacks before it can be released, and what it points out without refusing: checked against the
 * style's range and colourways and the materials as they are now (a material or colour archived since it was chosen
 * blocks the release; a released BOM is never checked again, it is frozen).
 */
export function bomIssues(lines: readonly BomLineData[], style: BomStyle, materials: ReadonlyMap<string, BomMaterial>, revision: { readonly plannedHideYieldPct: string | null }): BomCheck {
  const blockers: BomIssue[] = []
  const warnings: BomIssue[] = []
  const block = (code: (typeof BOM_BLOCKERS)[number], message: string, at: { lineId?: string; size?: string; colourwayId?: string } = {}) =>
    blockers.push({ code, lineId: at.lineId ?? null, size: at.size ?? null, colourwayId: at.colourwayId ?? null, message })
  const warn = (code: (typeof BOM_WARNINGS)[number], message: string, at: { lineId?: string } = {}) =>
    warnings.push({ code, lineId: at.lineId ?? null, size: null, colourwayId: null, message })

  const active = style.colourways.filter((colourway) => colourway.status === 'ACTIVE')
  const colourwayOf = new Map(style.colourways.map((colourway) => [colourway.id, colourway]))
  if (lines.length === 0) block('NO_LINES', 'The BOM has no line yet.')
  if (style.sizes.length === 0) block('NO_SIZE_RANGE', 'The style has no size range yet.')
  if (active.length === 0) block('NO_ACTIVE_COLOURWAY', 'The style has no active colourway.')

  for (const line of [...lines].sort((a, b) => a.seq - b.seq)) {
    const material = materials.get(line.itemId)
    if (!material) throw new Error(`bomIssues: material ${line.itemId} of line ${line.id} was not read`)
    const name = `Line ${line.seq} (${material.code})`
    const lineId = line.id
    if (material.status !== 'ACTIVE') block('MATERIAL_ARCHIVED', `${name}: the material is archived; choose another one.`, { lineId })
    const badUnit = unitProblem(line.uom, material)
    if (badUnit) block('UNIT_NOT_CONVERTIBLE', `${name}: ${badUnit}`, { lineId })
    if (wastageProblem(line.wastagePct)) block('WASTAGE_OUT_OF_RANGE', `${name}: wastage is 0 to ${MAX_WASTAGE_PCT} %.`, { lineId })

    if (line.sizeDependent) {
      const of = new Map(line.sizes.map((row) => [row.size, row.qty]))
      for (const size of style.sizes) if (!of.has(size)) block('SIZE_QUANTITY_MISSING', `${name}: no quantity for size ${size} (0 if the size does not use it).`, { lineId, size })
      for (const row of line.sizes) if (!style.sizes.includes(row.size)) block('SIZE_OUTSIDE_RANGE', `${name}: size ${row.size} is no longer in the range; clear its quantity.`, { lineId, size: row.size })
      const inRange = line.sizes.filter((row) => style.sizes.includes(row.size))
      if (inRange.length > 0 && inRange.every((row) => isZero(row.qty))) block('SIZE_QUANTITIES_ALL_ZERO', `${name}: no size uses it (every quantity is 0).`, { lineId })
    } else if (!decimalOf(line.qty).gt(ZERO)) {
      block('QUANTITY_NOT_POSITIVE', `${name}: the quantity is above 0.`, { lineId })
    }

    const colourOf = new Map(material.colours.map((colour) => [colour.id, colour]))
    if (line.colourDependent) {
      const cells = new Map(line.colours.map((cell) => [cell.colourwayId, cell.itemColourId]))
      for (const colourway of active) {
        const itemColourId = cells.get(colourway.id)
        if (itemColourId === undefined) block('COLOUR_MISSING', `${name}: no ${material.code} colour for colourway ${colourway.code}.`, { lineId, colourwayId: colourway.id })
        else if (colourOf.get(itemColourId)?.status !== 'ACTIVE') {
          block('COLOUR_ARCHIVED', `${name}: colour ${colourOf.get(itemColourId)?.code ?? '?'} for colourway ${colourway.code} is archived.`, { lineId, colourwayId: colourway.id })
        }
      }
    } else if (line.itemColourId !== null) {
      if (colourOf.get(line.itemColourId)?.status !== 'ACTIVE') block('COLOUR_ARCHIVED', `${name}: colour ${colourOf.get(line.itemColourId)?.code ?? '?'} is archived.`, { lineId })
    } else if (material.colours.some((colour) => colour.status === 'ACTIVE')) {
      block('COLOUR_MISSING', `${name}: ${material.code} comes in colours; choose one, or make the line colour-dependent.`, { lineId })
    }

    if (line.colourwayId !== null && colourwayOf.get(line.colourwayId)?.status !== 'ACTIVE') {
      warn('LINE_OF_ARCHIVED_COLOURWAY', `${name}: it is only for colourway ${colourwayOf.get(line.colourwayId)?.code ?? '?'}, which is archived; no garment uses it.`, { lineId })
    }
    if (material.kind === 'LEATHER' && decimalOf(line.wastagePct).isZero()) {
      warn('LEATHER_WITHOUT_WASTAGE', `${name}: leather with 0 % wastage; add the hide's waste (PRD-082).`, { lineId })
    }
  }
  if (revision.plannedHideYieldPct === null && lines.some((line) => materials.get(line.itemId)?.kind === 'LEATHER')) {
    warn('NO_PLANNED_HIDE_YIELD', "The revision has leather but no planned hide yield: cutting compares the real yield with it.")
  }
  return { blockers, warnings }
}

// ---- the revision's state ----------------------------------------------------------------------------------------------

/** Why the BOM of this revision cannot be changed now (a 409), or null. */
export function editRefusal(revision: { readonly revision: number; readonly status: RevisionStatus }, styleStatus: StyleStatus): string | null {
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: its BOM is frozen. Copy it into a new draft to change it.`
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before changing its BOM.'
  return null
}

/** Why this revision cannot be released now (a 409; the BOM's blockers come on top), or null. */
export function releaseRefusal(revision: { readonly revision: number; readonly status: RevisionStatus }, styleStatus: StyleStatus): string | null {
  if (revision.status !== 'DRAFT') return `Revision ${revision.revision} is ${revision.status.toLowerCase()}: only a draft is released.`
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before releasing a revision.'
  return null
}

/**
 * Why this revision cannot be made OBSOLETE now, or null: a draft is abandoned at any time; the released one is withdrawn
 * only while the style is not active (an active style is sold from it: release its replacement instead).
 */
export function obsoleteRefusal(revision: { readonly revision: number; readonly status: RevisionStatus }, styleStatus: StyleStatus): string | null {
  if (revision.status === 'OBSOLETE') return `Revision ${revision.revision} is obsolete already.`
  if (revision.status === 'RELEASED' && styleStatus === 'ACTIVE') {
    return `Revision ${revision.revision} is the active style's current specification: release the revision that replaces it, or archive the style first.`
  }
  return null
}
