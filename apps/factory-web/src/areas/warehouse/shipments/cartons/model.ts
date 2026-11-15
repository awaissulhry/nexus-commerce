import { words, type Read, type Words } from '../queue/shared/depth'
import type { Bench, Carton, CartonContent } from './api'

/**
 * A shipment's cartons, pure (SCR-594; design warehouse.shipments sh-cartons "carton 'n of N' · package type (carton master)
 * · contents by size · net / gross kg · L × W × H cm · tracking no. · label status", "Add carton; row → docked carton drawer
 * (contents, serials, weight)", pop:sh-carton "Carton 2 of 3: contents by size, serials, weights, dimensions, label";
 * sh-lines "serials"). What a row says, what holds each button, the drawer's place in the list.
 */

/** What the record lends the card: its parcels' tracking numbers, what the person may do, its own dialogs. */
export interface CartonsContext {
  readonly status: Bench['shipment']['status']
  readonly parcels: readonly { readonly id: string; readonly trackingNumber: string | null }[]
  readonly canPack: boolean
  readonly busy: boolean
}

export interface CartonsModel {
  readonly bench: Read<Bench>
  readonly context: CartonsContext
  /** The carton open in the docked drawer. */
  readonly openId: string | null
}

export interface CartonsActions {
  onRetry?: () => void
  onOpen?: (cartonId: string | null) => void
  onStep?: (step: -1 | 1) => void
  onAdd?: () => void
  onWeigh?: (cartonId: string) => void
  onRemove?: (cartonId: string) => void
  onPackingList?: () => void
}

/** "Carton 2 of 3" once closed (numbered), else "Carton 2 (open)". */
export function cartonName(carton: Pick<Carton, 'seq' | 'closed' | 'cartonNumber' | 'cartonCount'>): Words {
  if (carton.closed && carton.cartonNumber !== null && carton.cartonCount !== null) return words('cartons.nOfN', { n: carton.cartonNumber, count: carton.cartonCount })
  return words('cartons.open', { n: carton.seq })
}

/** The contents by style and colour, the sizes as "50×2, 52×1". */
export function contentsBySize(contents: readonly CartonContent[]): { key: string; style: string; sizes: string; serials: number }[] {
  const groups = new Map<string, { style: string; sizes: Map<string, number>; serials: number }>()
  for (const line of contents) {
    const key = `${line.styleCode}|${line.colourwayCode}`
    const group = groups.get(key) ?? { style: `${line.styleCode} · ${line.colourwayName}`, sizes: new Map<string, number>(), serials: 0 }
    group.sizes.set(line.size, (group.sizes.get(line.size) ?? 0) + line.quantity)
    group.serials += line.serials.length
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => ({ key, style: group.style, sizes: [...group.sizes.entries()].map(([size, quantity]) => `${size}×${quantity}`).join(', '), serials: group.serials }))
}

/** The carton's marks: printed and current, printed but out of date (renumbered), not printed, or not yet (open). */
export function marksState(carton: Pick<Carton, 'closed' | 'marksCurrent' | 'marksPrintedAt'>): 'current' | 'stale' | 'notPrinted' | 'open' {
  if (!carton.closed) return 'open'
  if (carton.marksCurrent) return 'current'
  return carton.marksPrintedAt ? 'stale' : 'notPrinted'
}
export const MARKS_TONE = { current: 'success', stale: 'warning', notPrinted: 'warning', open: 'neutral' } as const

/** The carton's tracking number (its parcel's label), from the record. */
export const trackingOf = (context: CartonsContext, cartonId: string): string | null => context.parcels.find((parcel) => parcel.id === cartonId)?.trackingNumber ?? null

/** Why "Add carton" is held (W1's empty parcel; packing happens at the station). */
export function addHeld(context: CartonsContext): Words | null {
  if (!context.canPack) return words('cartons.held.noPack')
  if (context.status !== 'DRAFT') return words('cartons.held.notDraft')
  if (context.busy) return words('cartons.held.busy')
  return null
}

/** Why "Weigh and measure" is held for a carton. */
export function weighHeld(context: CartonsContext, carton: Carton): Words | null {
  if (!context.canPack) return words('cartons.held.noPack')
  if (context.status !== 'DRAFT' && context.status !== 'PACKED') return words('cartons.held.left')
  if (carton.labelled || trackingOf(context, carton.id)) return words('cartons.held.labelled')
  if (context.busy) return words('cartons.held.busy')
  return null
}

/** Why "Remove" is held for a carton (only an empty one of a DRAFT). */
export function removeHeld(context: CartonsContext, carton: Carton): Words | null {
  if (!context.canPack) return words('cartons.held.noPack')
  if (context.status !== 'DRAFT') return words('cartons.held.notDraft')
  if (carton.garments > 0) return words('cartons.held.notEmpty')
  if (carton.labelled) return words('cartons.held.labelled')
  if (context.busy) return words('cartons.held.busy')
  return null
}

/** The drawer's place: index from 1, and the carton before / after. */
export function stepOf(bench: Bench, openId: string | null, step: -1 | 1): string | null {
  const index = bench.cartons.findIndex((carton) => carton.id === openId)
  if (index < 0) return null
  return bench.cartons[index + step]?.id ?? null
}

/** Ordered against packed, all sizes of the shipment (the "Packed by size" table). */
export function packedTotals(bench: Bench): { ordered: number; packed: number } {
  return bench.grid.reduce((sum, row) => row.sizes.reduce((inner, size) => ({ ordered: inner.ordered + size.ordered, packed: inner.packed + size.packed }), sum), { ordered: 0, packed: 0 })
}

/** Every serial of the shipment with its carton (the lines' serials, W2b). */
export function serialsOf(bench: Bench): { serial: string; style: string; size: string; carton: Words; packedAt: string | null }[] {
  return bench.cartons.flatMap((carton) => carton.contents.flatMap((line) => line.serials.map((serial) => ({ serial: serial.serial, style: `${line.styleCode} · ${line.colourwayName}`, size: line.size, carton: cartonName(carton), packedAt: serial.packedAt }))))
}

/** A decimal string of kilograms, short ("4,2"), or null. */
export function kilos(value: string | null, locale: string): string | null {
  if (value === null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString(locale, { maximumFractionDigits: 3 }) : null
}

/** "60 × 40 × 40" when all three sizes are known. */
export function dimensions(carton: Pick<Carton, 'lengthCm' | 'widthCm' | 'heightCm'>, locale: string): string | null {
  if (!carton.lengthCm || !carton.widthCm || !carton.heightCm) return null
  return [carton.lengthCm, carton.widthCm, carton.heightCm].map((value) => Number(value).toLocaleString(locale, { maximumFractionDigits: 1 })).join(' × ')
}
