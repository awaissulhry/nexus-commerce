import { defineMachine } from '../../state/machine'
import { MASTER_STATUSES } from '../sizes/rules'
import { DEFAULT_SKU_PATTERN, skuOf, type SkuPattern } from './sku'

/**
 * The colour x size SKU matrix (feature PRD-005), pure: one SKU (factory-db `Variant`) per colourway and size of the
 * style's range. A cell is OFFERED when its colourway is ACTIVE and its size is in the range; a cell is ON when its SKU
 * is ACTIVE. Order entry, stock and work orders work on the ON cells.
 *
 *   generate   every offered cell without a SKU gets one (by the SKU pattern); nothing else changes, so a cell switched
 *              off by hand stays off. This makes the matrix; until then the style's colourways and range are shaped
 *              freely.
 *   follow     once the matrix exists, a change of what is offered moves exactly the cells whose offer changed: a cell
 *              newly offered gets a SKU, or its archived SKU back (the same SKU: it never changes); a cell no longer
 *              offered is archived, never deleted (PRD-022: its SKU may be on orders, stock and labels). Cells offered
 *              before and after keep their state (switched on or off by hand).
 *   switch     one cell on or off by hand (the API's variant route): only an offered cell is switched on.
 */

/** A SKU: ON (ACTIVE) ↔ OFF (ARCHIVED); never deleted. */
export const skuMachine = defineMachine({ name: 'SKU', states: MASTER_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })

export interface MatrixColourway {
  readonly id: string
  readonly code: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

export interface MatrixVariant {
  readonly id: string
  readonly colourwayId: string
  readonly size: string
  readonly sku: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** What is offered: the style's colourways and its range. */
export interface MatrixOffer {
  readonly colourways: readonly MatrixColourway[]
  readonly sizes: readonly string[]
}

export interface MatrixCell {
  readonly colourwayId: string
  readonly size: string
}

export interface NewVariant extends MatrixCell {
  readonly sku: string
}

/** What a command does to the style's SKUs. */
export interface MatrixPlan {
  readonly create: readonly NewVariant[]
  /** SKU ids to archive (ACTIVE → ARCHIVED). */
  readonly archive: readonly string[]
  /** SKU ids to restore (ARCHIVED → ACTIVE). */
  readonly restore: readonly string[]
}

export const EMPTY_PLAN: MatrixPlan = Object.freeze({ create: [], archive: [], restore: [] })

const keyOf = (cell: MatrixCell): string => `${cell.colourwayId}\u0000${cell.size}`

/** The offered cells, colourway by colourway (in the given order), size by size (in the range's order). */
export function offeredCells(offer: MatrixOffer): MatrixCell[] {
  return offer.colourways.filter((colourway) => colourway.status === 'ACTIVE').flatMap((colourway) => offer.sizes.map((size) => ({ colourwayId: colourway.id, size })))
}

/** True when the cell is offered. */
export function isOffered(offer: MatrixOffer, cell: MatrixCell): boolean {
  return offer.sizes.includes(cell.size) && offer.colourways.some((colourway) => colourway.id === cell.colourwayId && colourway.status === 'ACTIVE')
}

function newVariant(styleCode: string, offer: MatrixOffer, cell: MatrixCell, pattern: SkuPattern): NewVariant {
  const colourway = offer.colourways.find((entry) => entry.id === cell.colourwayId)
  if (!colourway) throw new Error(`The matrix has no colourway ${cell.colourwayId}.`)
  return { ...cell, sku: skuOf({ style: styleCode, colourway: colourway.code, size: cell.size }, pattern) }
}

/** Generating the matrix: a SKU for every offered cell that has none. */
export function generatePlan(styleCode: string, offer: MatrixOffer, variants: readonly MatrixVariant[], pattern: SkuPattern = DEFAULT_SKU_PATTERN): MatrixPlan {
  const made = new Set(variants.map(keyOf))
  const create = offeredCells(offer)
    .filter((cell) => !made.has(keyOf(cell)))
    .map((cell) => newVariant(styleCode, offer, cell, pattern))
  return { create, archive: [], restore: [] }
}

/**
 * Following a change of the offer, once the matrix exists (the style has a SKU): cells newly offered are made or
 * restored, cells no longer offered are archived; nothing happens before the matrix exists.
 */
export function followPlan(styleCode: string, before: MatrixOffer, after: MatrixOffer, variants: readonly MatrixVariant[], pattern: SkuPattern = DEFAULT_SKU_PATTERN): MatrixPlan {
  if (variants.length === 0) return EMPTY_PLAN
  const was = new Set(offeredCells(before).map(keyOf))
  const now = offeredCells(after)
  const nowKeys = new Set(now.map(keyOf))
  const byCell = new Map(variants.map((variant) => [keyOf(variant), variant]))
  const create: NewVariant[] = []
  const restore: string[] = []
  for (const cell of now) {
    if (was.has(keyOf(cell))) continue
    const variant = byCell.get(keyOf(cell))
    if (!variant) create.push(newVariant(styleCode, after, cell, pattern))
    else if (variant.status === 'ARCHIVED') restore.push(variant.id)
  }
  // Only an offered cell is ON: every SKU ON outside the new offer goes off.
  const archive = variants.filter((variant) => variant.status === 'ACTIVE' && !nowKeys.has(keyOf(variant))).map((variant) => variant.id)
  return { create, archive, restore }
}

/** Offered cells without a SKU (the page's "generate the SKUs" hint). */
export function missingCells(offer: MatrixOffer, variants: readonly MatrixVariant[]): MatrixCell[] {
  const made = new Set(variants.map(keyOf))
  return offeredCells(offer).filter((cell) => !made.has(keyOf(cell)))
}

/** SKUs of the plan that clash with each other or with `taken` (the tenant's other SKUs). */
export function skuClashes(plan: MatrixPlan, taken: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const clashes: string[] = []
  for (const variant of plan.create) {
    if (taken.has(variant.sku) || seen.has(variant.sku)) clashes.push(variant.sku)
    seen.add(variant.sku)
  }
  return clashes
}

export const isEmptyPlan = (plan: MatrixPlan): boolean => plan.create.length === 0 && plan.archive.length === 0 && plan.restore.length === 0
