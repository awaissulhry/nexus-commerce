import type { BomLine, BomView, CostSheetView } from '../api'
import type { BomDepthView, BomStructureView } from './depth/api'
import { costCellOf, defaultCostCell, type Grains } from '../model'

/**
 * owb-pd5 steps 5.1 + 5.2 (design § 5zc "Materials"; prototype mat.js prodMaterialsTab, bomOf, needQ, lineCost, matCostOf,
 * openNeed) — the Materials tab's rules, pure: the top line, the main material, what decides when to order (the longest waits),
 * the lines the customer sends, what an order needs (browser arithmetic, nothing saved), what the open orders need, the step to
 * the next size, which sizes a fill keeps, the cost of a line (cost grain only) and the CE re-check. The views draw these.
 */

// ---- the facts of a line --------------------------------------------------------------------------------------------------------

/**
 * pd3 (owb-pd-server § Shape pd3) gives a BOM line `leadTimeDays` (the material's wait, else its preferred source's) and `isMain`
 * (the main material). Read here before pd3 lands: absent → null / false (the tab says "—", never 0 days).
 */
type WithPd3 = { readonly leadTimeDays?: number | null; readonly isMain?: boolean }
export const waitOf = (line: BomLine): number | null => (line as BomLine & WithPd3).leadTimeDays ?? null
export const isMainLine = (line: BomLine): boolean => (line as BomLine & WithPd3).isMain === true

export interface LineFacts {
  id: string
  seq: number
  code: string
  name: string
  kind: BomLine['item']['kind']
  /** The structure's section (its own, else its material kind's); null: the structure is not read yet. */
  section: string | null
  /** The customer that sends it; null: the factory buys it (or not read yet). */
  sentBy: string | null
  wait: number | null
  main: boolean
}

export function lineFactsOf(bom: Pick<BomView, 'lines'>, structure: Pick<BomStructureView, 'lines'> | null, depth: Pick<BomDepthView, 'lines'> | null): LineFacts[] {
  return [...bom.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => {
      const own = structure?.lines.find((entry) => entry.id === line.id) ?? null
      const deep = depth?.lines.find((entry) => entry.id === line.id) ?? null
      return {
        id: line.id,
        seq: line.seq,
        code: line.item.code,
        name: line.item.name,
        kind: line.item.kind,
        section: own?.section ?? null,
        sentBy: deep?.customerSupplied?.name ?? (own?.customerSuppliedByPartyId ? '' : null),
        wait: waitOf(line),
        main: isMainLine(line),
      }
    })
}

/** The top line: how many lines, the leather, how many the customer sends, the longest wait, and (cost grain) one piece's material cost. */
export interface MaterialsTop {
  lines: number
  leather: { code: string; name: string } | null
  customerLines: number
  longestWait: number | null
  cost: string | null
}
export function topLineOf(facts: readonly LineFacts[], cost: string | null): MaterialsTop {
  const leather = facts.find((line) => line.main && line.kind === 'LEATHER') ?? facts.find((line) => line.kind === 'LEATHER') ?? null
  const waits = facts.map((line) => line.wait).filter((wait): wait is number => wait !== null)
  return { lines: facts.length, leather: leather ? { code: leather.code, name: leather.name } : null, customerLines: facts.filter((line) => line.sentBy !== null).length, longestWait: waits.length ? Math.max(...waits) : null, cost }
}

/** Before the work starts: the longest waits (the first decides when to order); a line without a known wait is left out. */
export const longestWaits = (facts: readonly LineFacts[], count = 3): LineFacts[] => facts.filter((line) => line.wait !== null && line.sentBy === null).sort((a, b) => b.wait! - a.wait! || a.seq - b.seq).slice(0, count)

/** The lines the customer sends (no purchase, no cost). */
export const customerSent = (facts: readonly LineFacts[]): LineFacts[] => facts.filter((line) => line.sentBy !== null)

/** The main material (the leathers the customer can pick hang on it); null: none marked yet. */
export const mainOf = (facts: readonly LineFacts[]): LineFacts | null => facts.find((line) => line.main) ?? null

// ---- what an order needs ----------------------------------------------------------------------------------------------------------

/** A decimal as the screens keep it: at most 4 decimals, no trailing zeros. */
const decimal = (value: number): string => String(Number(value.toFixed(4)))

/** One line's quantity for one piece in a size, before waste (the size's own, else the line's one quantity); null: unknown. */
export function qtyAt(line: Pick<BomLine, 'qty' | 'sizeDependent' | 'bySize'>, size: string | null): number | null {
  const entry = size ? line.bySize.find((row) => row.size === size) : undefined
  const text = entry ? entry.qty : line.sizeDependent ? null : line.qty
  if (text === null || text === undefined) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** The need of a line: quantity for one piece × (1 + waste %) × pieces. Null when the size has no quantity (never a 0). */
export function needOf(line: Pick<BomLine, 'qty' | 'wastagePct' | 'sizeDependent' | 'bySize'>, size: string | null, pieces: number): string | null {
  const qty = qtyAt(line, size)
  if (qty === null || !Number.isFinite(pieces) || pieces < 0) return null
  const waste = Number(line.wastagePct)
  return decimal(qty * (1 + (Number.isFinite(waste) ? waste : 0) / 100) * pieces)
}

export interface NeedRow {
  lineId: string
  code: string
  name: string
  uom: BomLine['uom']
  need: string | null
  /** The customer sends it: the order needs it from them. */
  sentBy: string | null
}

/** What an order of `pieces` in `size` needs, per material (waste included). The customer's lines are said as theirs. */
export function orderNeedOf(bom: Pick<BomView, 'lines'>, facts: readonly LineFacts[], size: string | null, pieces: number): NeedRow[] {
  return [...bom.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({ lineId: line.id, code: line.item.code, name: line.item.name, uom: line.uom, need: needOf(line, size, pieces), sentBy: facts.find((fact) => fact.id === line.id)?.sentBy ?? null }))
}

/** What the open orders need: their open pieces at the base size (marked as such by the view: sizes are not split here). */
export const openOrdersNeedOf = (bom: Pick<BomView, 'lines' | 'style'>, facts: readonly LineFacts[], openPieces: number): NeedRow[] => orderNeedOf(bom, facts, bom.style.baseSize, openPieces)

/** Pieces typed for "What an order needs": a whole number from 1 to 100 000, else null (held with words). */
export function piecesOf(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= 100_000 ? value : null
}

// ---- more for each size up -------------------------------------------------------------------------------------------------------

/** The step to the next size up of a size-dependent line (the next size's quantity − the base's); null: not size-dependent, or unknown. */
export function stepOf(line: Pick<BomLine, 'sizeDependent' | 'bySize'>, sizes: readonly string[], base: string | null): string | null {
  if (!line.sizeDependent || !base) return null
  const at = sizes.indexOf(base)
  const next = at >= 0 ? sizes[at + 1] : undefined
  if (!next) return null
  const low = qtyAt({ qty: '0', sizeDependent: true, bySize: line.bySize }, base)
  const high = qtyAt({ qty: '0', sizeDependent: true, bySize: line.bySize }, next)
  return low === null || high === null ? null : decimal(high - low)
}

/**
 * The sizes a "more for each size up" fill keeps: every size with a quantity of its own except the base (the fill counts from it).
 * Handed to the DS SizeFill as `overrides`: it keeps them unless the person unticks Keep — a fill never overwrites a typed size.
 */
export const typedSizesOf = (line: Pick<BomLine, 'sizes'>, base: string | null): string[] => line.sizes.filter((entry) => entry.size !== base && entry.qty !== '').map((entry) => entry.size)

// ---- cost (cost grain only) -----------------------------------------------------------------------------------------------------

/**
 * The material cost of one piece and of each line, at the cost sheet's default cell (the base size of the first colourway). Null
 * without the cost grain (the API drops the figures anyway) or without a read sheet: the view then shows no amount at all.
 */
export function costsOf(sheet: CostSheetView | null, grains: Pick<Grains, 'cost'>): { currency: string; piece: string | null; byLine: Record<string, string | null> } | null {
  if (!grains.cost || !sheet) return null
  const cell = costCellOf(sheet, defaultCostCell(sheet))
  if (!cell) return null
  const byLine: Record<string, string | null> = {}
  for (const line of cell.material.lines) byLine[line.lineId] = line.amount ?? null
  return { currency: sheet.currency, piece: cell.material.amount ?? null, byLine }
}

// ---- 5.2: the CE re-check ---------------------------------------------------------------------------------------------------------

/** A line the CE certificate rests on: a protection line (its section or its material kind) or the CE label line. */
export function isCeLine(line: { readonly item: { readonly kind: string; readonly code: string; readonly name: string } }, section: string | null): boolean {
  if (section === 'PROTECTION' || line.item.kind === 'PROTECTOR') return true
  return line.item.kind === 'LABEL' && /\bCE\b/i.test(`${line.item.code} ${line.item.name}`)
}

export interface CeRecheck {
  /** Protection or CE label materials of the released revision the draft no longer has. */
  takenOut: Array<{ code: string; name: string }>
  /** Protection or CE label lines of the draft the customer sends. */
  customerSends: Array<{ code: string; name: string; sentBy: string }>
}

/**
 * "CE: check the certificate again" (design § 5zc): the draft takes a protection or CE label material out against the released
 * revision, or sets one to "the customer sends it". Null: nothing to check (or no draft, or nothing released to compare with for
 * the first case).
 */
export function ceRecheckOf(draft: Pick<BomView, 'lines'>, facts: readonly LineFacts[], released: Pick<BomView, 'lines'> | null): CeRecheck | null {
  const sectionOf = (id: string) => facts.find((fact) => fact.id === id)?.section ?? null
  const kept = new Set(draft.lines.map((line) => line.item.id))
  const takenOut = (released?.lines ?? []).filter((line) => isCeLine(line, null) && !kept.has(line.item.id)).map((line) => ({ code: line.item.code, name: line.item.name }))
  const customerSends = draft.lines.flatMap((line) => {
    const sentBy = facts.find((fact) => fact.id === line.id)?.sentBy ?? null
    return sentBy !== null && isCeLine(line, sectionOf(line.id)) ? [{ code: line.item.code, name: line.item.name, sentBy }] : []
  })
  return takenOut.length || customerSends.length ? { takenOut, customerSends } : null
}
