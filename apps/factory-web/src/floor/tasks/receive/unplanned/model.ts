import type { Material, UnplannedBody } from './api'

/**
 * Goods without a PO on the goods-in tablet (B-W2b-300; SCM-122; design floor.receive › "Goods without a PO": supplier, item,
 * quantity, photo; "Put it in the holding area"), the pure rules of the screen: the draft as the person builds it, one job per
 * step, what holds the send, and the body of the ONE call. Quantities are typed in the material's base unit (the API keeps
 * that unit); a leather line may also say how many hides came. No money anywhere.
 */

export type UnplannedStage = 'supplier' | 'material' | 'quantity' | 'lines' | 'ddt' | 'place' | 'done'

export interface PickedColour {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface DraftLine {
  readonly key: string
  readonly material: Material
  readonly colour: PickedColour | null
  readonly quantity: number | null
  readonly hideCount: number | null
}

export interface Draft {
  readonly supplier: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly lines: readonly DraftLine[]
  /** The line on the quantity step (not in `lines` until added). */
  readonly editing: DraftLine | null
  readonly ddtNumber: string | null
  readonly ddtDate: string | null
  /** The holding place's label scanned (when the site has no suggestion yet, or another place was scanned). */
  readonly placeCode: string | null
}

export const emptyDraft = (): Draft => ({ supplier: null, lines: [], editing: null, ddtNumber: null, ddtDate: null, placeCode: null })

/** The most lines one delivery takes here (the API's limit). */
export const MAX_LINES = 20

/** Why a line cannot be added yet: no colour picked for a material in colours, no quantity above 0. */
export type LineProblem = 'NO_COLOUR' | 'NO_QUANTITY' | null

export function lineProblem(line: DraftLine): LineProblem {
  if (line.material.colours.length > 0 && line.colour === null) return 'NO_COLOUR'
  if (line.quantity === null || !(line.quantity > 0)) return 'NO_QUANTITY'
  return null
}

/** A new line of a material: its only colour picked already. */
export function lineOf(material: Material, key: string): DraftLine {
  return { key, material, colour: material.colours.length === 1 ? material.colours[0]! : null, quantity: null, hideCount: null }
}

/** The line added (or put back in its place when it was edited), the editing cleared. */
export function addLine(draft: Draft): Draft {
  const line = draft.editing
  if (!line || lineProblem(line) !== null) return draft
  const at = draft.lines.findIndex((entry) => entry.key === line.key)
  const lines = at >= 0 ? draft.lines.map((entry, index) => (index === at ? line : entry)) : [...draft.lines, line].slice(0, MAX_LINES)
  return { ...draft, lines, editing: null }
}

export const removeLine = (draft: Draft, key: string): Draft => ({ ...draft, lines: draft.lines.filter((line) => line.key !== key) })

/** Why the goods cannot be taken in now (the screen words each code), or null. */
export type SendHeld = 'OFFLINE' | 'NO_SUPPLIER' | 'NO_LINES' | 'NO_PLACE' | 'BUSY' | null

export function sendHeld(draft: Draft, context: { readonly online: boolean; readonly holding: { readonly id: string } | null; readonly busy: boolean }): SendHeld {
  if (context.busy) return 'BUSY'
  if (!context.online) return 'OFFLINE'
  if (!draft.supplier) return 'NO_SUPPLIER'
  if (draft.lines.length === 0) return 'NO_LINES'
  if (!context.holding && !draft.placeCode) return 'NO_PLACE'
  return null
}

/** A typed number as the API reads it: at most 4 decimals, no exponent. */
export function quantityText(value: number): string {
  return Number(value.toFixed(4)).toString()
}

/** The body of the ONE call: the scanned place wins over the suggestion. */
export function unplannedBody(draft: Draft, holding: { readonly id: string } | null): UnplannedBody {
  return {
    supplierId: draft.supplier!.id,
    ...(draft.placeCode ? { placeCode: draft.placeCode } : { holdingLocationId: holding!.id }),
    supplierDdtNumber: draft.ddtNumber,
    supplierDdtDate: draft.ddtDate,
    lines: draft.lines.map((line) => ({
      itemId: line.material.id,
      itemColourId: line.colour?.id ?? null,
      quantity: quantityText(line.quantity!),
      ...(line.material.tracking === 'HIDE' && line.hideCount ? { hideCount: line.hideCount } : {}),
    })),
  }
}

/** The step a draft opens on: who sent it first, then what came. */
export const firstStage = (draft: Draft): UnplannedStage => (draft.supplier === null ? 'supplier' : draft.lines.length === 0 ? 'material' : 'lines')

/** Suppliers matching what is typed (code or name, either case). */
export function suppliersMatching<T extends { readonly code: string; readonly name: string }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return q === '' ? [...rows] : rows.filter((row) => row.code.toLowerCase().includes(q) || row.name.toLowerCase().includes(q))
}
