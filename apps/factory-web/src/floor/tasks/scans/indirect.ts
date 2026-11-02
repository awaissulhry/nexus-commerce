import type { PickerReason } from '../reasons/model'

/**
 * No bundle: what are you doing? on SCR-090 (design floor.operation "No bundle: what are you doing?"; MES-156, MES-158): the
 * company's off-standard and indirect codes as tiles, one tap starts, Done ends, and scanning a bundle returns to standard
 * (the API ends the block at the Start or the report). Pure. A floor answer carries no pay rule and no money.
 */

export interface OffStandardTile {
  readonly id: string
  readonly code: string
  readonly kind: 'OFF_STANDARD' | 'INDIRECT'
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
}

export interface OffStandardBlock {
  readonly id: string
  readonly code: OffStandardTile
  readonly startedAt: string
}

export interface OffStandardFloor {
  readonly running: OffStandardBlock | null
  readonly codes: readonly OffStandardTile[]
}

/** A code as the one picker's tiles draw it (the office's icon and colour; the order is the office's). */
export function tileReason(tile: OffStandardTile, index: number): PickerReason {
  return { id: tile.id, list: 'OFF_STANDARD', code: tile.code, labelIt: tile.labelIt, labelEn: tile.labelEn, labelI18n: tile.labelI18n, icon: tile.icon, colour: tile.colour, photo: null, needsDetail: false, sortOrder: index }
}

/** The block the tablet knows after a tile queued offline. */
export const startedBlock = (tile: OffStandardTile, at: Date): OffStandardBlock => ({ id: `local:${tile.id}`, code: tile, startedAt: at.toISOString() })
