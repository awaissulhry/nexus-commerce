import type { FloorMode, TileKey } from '../model'
import type { ScanRead } from '../scan/scan-model'

/**
 * Where the floor tasks live (SCR-090, 092, 093, 094, 095, 097) and the scan router of Home (design "The floor frame",
 * scanRouter): a label scanned on Home opens the job for this station and person with the label loaded — a bundle at a
 * sewing station opens Operation, a hide at a cutting table opens Cut a hide, a bundle there opens Bundles (to fix its
 * ticket), a work order's label opens Pick & issue at the warehouse and Final inspection at the bench, a garment's serial
 * or a shipment's pack slip opens the packing bench (SCR-098) at a packing station. Anything else
 * opens Scan anything. Pure, so the tests hold it.
 */

export type TaskKey = Extract<TileKey, 'operation' | 'cut' | 'bundles' | 'receive' | 'pick' | 'final' | 'pack' | 'labels' | 'mywork'>

export const TASK_ROUTES: Readonly<Record<TaskKey, string>> = {
  // SCR-089 (B-W2a-74): My work, the station's queue.
  mywork: '/floor/mywork',
  operation: '/floor/operation',
  cut: '/floor/cut',
  bundles: '/floor/bundles',
  receive: '/floor/receive',
  pick: '/floor/pick',
  final: '/floor/final',
  pack: '/floor/pack',
  labels: '/floor/labels',
}

/** The task a tile opens, or null (Scan anything has its own page; the rest are later steps). */
export function taskOfTile(key: TileKey): TaskKey | null {
  return key in TASK_ROUTES ? (key as TaskKey) : null
}

/** The catalogues the floor app loads (the frame's and each task's). */
export const FLOOR_NAMESPACES = ['floor', 'floor-tasks', 'floor-scans', 'floor-issue', 'floor-cutting', 'floor-bundles', 'floor-final', 'floor-receive', 'floor-pack', 'floor-labels', 'floor-mywork', 'floor-reasons', 'reason-kit'] as const

/**
 * The task a code scanned on Home opens at this station, given the tiles the person has (a tile = mode AND permission),
 * or null: Scan anything shows its card.
 */
export function taskForScan(mode: FloorMode | null, read: ScanRead, tiles: readonly { key: TileKey; held: string | null }[]): TaskKey | null {
  const open = (key: TaskKey) => tiles.some((tile) => tile.key === key && tile.held === null)
  const pick = (key: TaskKey): TaskKey | null => (open(key) ? key : null)
  // A work order's traveller carries its office number (a free code): at the warehouse and the bench the task looks it
  // up as a work order number and, when it is none, hands the code on to Scan anything (`store.openScan`).
  const workOrder = (read.kind === 'label' && read.type === 'workOrder') || read.kind === 'free'
  switch (mode) {
    case 'sewing':
      return read.kind === 'label' && read.type === 'bundle' ? pick('operation') : null
    case 'packing':
      // A bundle is still reported at its packing operation; a garment's serial label or a free code (a shipment's
      // pack slip, a batch number) opens the packing bench with it.
      if (read.kind === 'label' && read.type === 'bundle') return pick('operation')
      if ((read.kind === 'label' && read.type === 'serial') || read.kind === 'free') return pick('pack')
      return null
    case 'cutting':
      // A bundle at the cutting table opens Bundles (to fix its ticket); its cutting operation is reported from the tile.
      if (read.kind === 'label' && read.type === 'hide') return pick('cut')
      if (read.kind === 'label' && read.type === 'bundle') return pick('bundles')
      return null
    case 'warehouse':
      return workOrder ? pick('pick') : null
    case 'inspection':
      if (read.kind === 'label' && read.type === 'bundle') return pick('operation')
      return workOrder ? pick('final') : null
    default:
      return null
  }
}
