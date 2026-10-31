import type { ScanRead } from '../../scan/scan-model'
import { decimalsOf, lineName, num, type PickLine, type PickList } from './model'

/**
 * Return unused (B-W2a-75; design floor.pick sec "return": back to stock, a cut hide comes back as a remnant with its
 * area; SCM-216; the API is B-W1-39's POST /inventory/picking/work-orders/:id/return), as rules without a screen: what
 * the work order holds that may come back (its pick list's `atWorkOrder`: issued less returned, less what was cut), what
 * a scanned code is among them, the pad's bounds (never more than may come back), whether a hide comes back whole or as a
 * remnant, the request's body, and the remnant's new tag (the HIDE label with its area, printed on the station's
 * printer, else the site's only one, else the one picked). Quantities are the API's decimal strings in the item's base
 * unit; shown and compared here, never valued (no money on the floor). Pure, so the tests hold them.
 */

export type ReturnKind = 'hide' | 'lot' | 'material'

export interface ReturnRow {
  /** The line and the hide or lot: one row per thing the work order holds. */
  readonly key: string
  readonly lineKey: string
  readonly kind: ReturnKind
  /** What is scanned to pick it: the hide's tag, the lot's code, or the material's code. */
  readonly code: string
  /** "Pelle bovina · Nero". */
  readonly name: string
  readonly itemCode: string
  readonly itemName: string
  readonly colour: string | null
  readonly lotCode: string | null
  readonly uom: string
  /** At the work order (issued less returned). */
  readonly held: number
  /** Cut from it already (a hide's area used by the cut). */
  readonly cut: number
  /** What may come back: held less cut. */
  readonly returnable: number
  /** The stock as the request names it (exactly one of a hide, a lot, a material). */
  readonly stock: { readonly hideId: string } | { readonly lotId: string } | { readonly itemId: string; readonly itemColourId: string | null }
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toUpperCase() === b.trim().toUpperCase()

/** What the work order holds that may come back, per line in the pick list's order (hides, then lots, then the material). */
export function returnRows(list: Pick<PickList, 'lines'>): ReturnRow[] {
  const rows: ReturnRow[] = []
  for (const line of list.lines) {
    for (const held of line.atWorkOrder) {
      const returnable = num(held.returnable)
      if (returnable <= 0) continue
      const kind: ReturnKind = held.hideId ? 'hide' : held.lotId ? 'lot' : 'material'
      rows.push({
        key: `${line.key}|${held.hideId ?? held.lotId ?? '-'}`,
        lineKey: line.key,
        kind,
        code: (kind === 'hide' ? held.hideCode : kind === 'lot' ? held.lotCode : line.itemCode) ?? line.itemCode,
        name: lineName(line),
        itemCode: line.itemCode,
        itemName: line.itemName,
        colour: line.colourName ?? line.colourCode,
        lotCode: held.lotCode,
        uom: line.baseUom,
        held: num(held.quantity),
        cut: num(held.cut),
        returnable,
        stock: held.hideId ? { hideId: held.hideId } : held.lotId ? { lotId: held.lotId } : { itemId: line.itemId, itemColourId: line.itemColourId },
      })
    }
  }
  return rows
}

/** The row a code read on the return step names (a hide's tag, a lot's code, a material's code), or null. */
export function returnOfScan(rows: readonly ReturnRow[], read: ScanRead): ReturnRow | null {
  return rows.find((row) => same(row.code, read.code)) ?? rows.find((row) => row.kind !== 'material' && same(row.lotCode, read.code) && rows.filter((other) => same(other.lotCode, read.code)).length === 1) ?? null
}

export interface ReturnBounds {
  readonly min: number
  readonly max: number
  readonly decimals: number
  /** All that may come back (the default). */
  readonly suggested: number
}

/** A hide's remnant is measured (two decimals of its area unit); lots and materials as their unit counts. */
export function returnBounds(row: Pick<ReturnRow, 'kind' | 'uom' | 'returnable'>): ReturnBounds {
  const decimals = row.kind === 'hide' ? 2 : decimalsOf(row.uom)
  const step = 1 / 10 ** decimals
  const max = Math.max(0, Number(row.returnable.toFixed(decimals)))
  return { min: max > 0 ? step : 0, max, decimals, suggested: max }
}

/** How it comes back: a hide nothing was cut from, all of it, comes back whole; any other hide as a remnant. */
export function comesBackAs(row: Pick<ReturnRow, 'kind' | 'cut' | 'held'>, value: number): 'whole' | 'remnant' | 'part' {
  if (row.kind !== 'hide') return 'part'
  return row.cut <= 0 && value >= row.held ? 'whole' : 'remnant'
}

/** The return's body (B-W1-39 returnContract): the stock by id, the measured quantity in the base unit, where it goes. */
export function returnBody(row: Pick<ReturnRow, 'stock'>, value: number, decimals: number, toLocationId: string, occurredAt: string) {
  return { ...row.stock, quantity: value.toFixed(Math.max(0, Math.min(4, decimals))), toLocationId, occurredAt }
}

// ---- the remnant's new tag ---------------------------------------------------------------------------------------------

export type TagPrinter =
  | { readonly kind: 'station' | 'site'; readonly id: string; readonly name: string }
  | { readonly kind: 'choose'; readonly printers: readonly { readonly id: string; readonly name: string }[] }
  | { readonly kind: 'none' }

/** Where the tag prints: the device's station's printer, else the site's only label printer, else the one picked. */
export function tagPrinterOf(printers: readonly { readonly id: string; readonly name: string }[], stationPrinterId: string | null): TagPrinter {
  const station = stationPrinterId ? printers.find((printer) => printer.id === stationPrinterId) : undefined
  if (station) return { kind: 'station', id: station.id, name: station.name }
  if (printers.length === 1) return { kind: 'site', id: printers[0]!.id, name: printers[0]!.name }
  return printers.length > 1 ? { kind: 'choose', printers } : { kind: 'none' }
}

/** The HIDE label of a remnant (factory-domain labels: article, colour, area, lot; the area in the label's words). */
export function remnantLabel(row: Pick<ReturnRow, 'code' | 'itemCode' | 'itemName' | 'colour' | 'lotCode'>, area: string, language: 'it' | 'en') {
  return {
    kind: 'HIDE' as const,
    language,
    scanId: row.code,
    title: `${row.itemCode} · ${row.itemName}`.slice(0, 200),
    fields: { article: row.itemCode, colour: row.colour, area, lot: row.lotCode },
  }
}

/** The lines the return changed are read again; until then the row's line keeps its numbers (the pick list re-reads). */
export const lineOf = (list: Pick<PickList, 'lines'>, row: Pick<ReturnRow, 'lineKey'>): PickLine | null => list.lines.find((line) => line.key === row.lineKey) ?? null
