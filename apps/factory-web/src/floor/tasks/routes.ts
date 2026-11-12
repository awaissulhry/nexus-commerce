import type { FloorMode, TileKey } from '../model'
import type { ScanRead } from '../scan/scan-model'

/**
 * Where the floor tasks live (SCR-090, 092, 093, 094, 095, 097) and the scan router of Home (design "The floor frame",
 * scanRouter): a label scanned on Home opens the job for this station and person with the label loaded — a bundle at a
 * sewing station opens Operation, a hide at a cutting table opens Cut a hide, a bundle there opens Bundles (to fix its
 * ticket), a work order's label opens Pick & issue at the warehouse and Final inspection at the bench, a garment's serial
 * or a shipment's pack slip opens the packing bench (SCR-098) at a packing station, a cut ticket's number opens Fabric
 * cutting at a cutting table (B-W2b-F16; elsewhere Scan anything says what it is and where it is used), a trolley's label
 * opens Fabric cutting's receipt at a sewing station — the line confirms the trolley arrived, B-W2b-121's page, which has no
 * tile there (B-W2b-F17; elsewhere Scan anything says what it is), a lot, hide, roll or remnant label opens Move & put away at
 * the warehouse (B-W2b-308). Anything else opens Scan anything. Pure, so the tests hold it.
 */

/** B-W2b-F17: what the line's receipt takes (Fabric cutting's page and its trolley step): the person's own permissions. */
export const TROLLEY_RECEIPT_PERMISSIONS = ['floor.work', 'production.cut', 'production.trolleys'] as const

export type TaskKey = Extract<TileKey, 'operation' | 'cut' | 'bundles' | 'receive' | 'pick' | 'final' | 'pack' | 'labels' | 'mywork' | 'machine' | /* B-W2a-76 */ 'returnsin' | 'kits' | /* B-W2b-67 */ 'clock' | /* B-W2b-70 */ 'help' | 'lineview' | /* B-W2b-68 */ 'myday' | /* B-W2b-137 */ 'incident' | /* B-W2b-145 */ 'training' | /* B-W2b-105 */ 'inline' | /* B-W2b-121 */ 'fabriccut' | /* B-W2b-115 */ 'incoming' | /* B-W2b-232 */ 'instructions' | /* B-W2b-308 */ 'move' | /* B-W2b-310 */ 'count'>

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
  // SCR-179 (B-W2a-73): the machine problem and the technician's job.
  machine: '/floor/machine',
  // SCR-180 / SCR-181 (B-W2a-76): receive a customer return; subcontract kits out and back.
  returnsin: '/floor/returnsin',
  kits: '/floor/kits',
  // SCR-170 (B-W2b-67): clock in and out.
  clock: '/floor/clock',
  // SCR-172 / SCR-168 (B-W2b-70): Call for help; the team leader's Line view.
  help: '/floor/help',
  lineview: '/floor/lineview',
  // SCR-171 (B-W2b-68): My day.
  myday: '/floor/myday',
  // SCR-230 (B-W2b-137): Report an incident.
  incident: '/floor/incident',
  // SCR-231 (B-W2b-145): Training & PPE sign-off.
  training: '/floor/training',
  // SCR-176 (B-W2b-105): In-line inspection.
  inline: '/floor/inline',
  // SCR-182 (B-W2b-121): Fabric cutting.
  fabriccut: '/floor/fabriccut',
  // SCR-175 (B-W2b-115): Incoming inspection.
  incoming: '/floor/incoming',
  // SCR-174 (B-W2b-232): Spec & instructions.
  instructions: '/floor/instructions',
  // SCR-177 (B-W2b-308): Move & put away.
  move: '/floor/move',
  // SCR-178 (B-W2b-310): Count.
  count: '/floor/count',
}

/** The task a tile opens, or null (Scan anything has its own page; the rest are later steps). */
export function taskOfTile(key: TileKey): TaskKey | null {
  return key in TASK_ROUTES ? (key as TaskKey) : null
}

/** The catalogues the floor app loads (the frame's and each task's). */
export const FLOOR_NAMESPACES = ['floor', 'floor-tasks', 'floor-scans', 'floor-issue', 'floor-cutting', 'floor-bundles', 'floor-final', 'floor-receive', 'floor-pack', 'floor-labels', 'floor-mywork', 'floor-reasons', 'reason-kit', 'floor-machine', /* B-W2a-76 */ 'floor-returns-in', 'floor-kits', /* B-W2b-66 */ 'line-board', /* B-W2b-70 */ 'floor-help', 'floor-lineview', /* B-W2b-67 */ 'floor-clock', /* B-W2b-68 */ 'floor-myday', /* B-W2b-137 */ 'floor-incident', /* B-W2b-145 */ 'floor-training', /* B-W2b-105 */ 'floor-inline', /* B-W2b-109 */ 'floor-final-plan', 'floor-myinspections', /* B-W2b-121 */ 'floor-fabriccut', /* B-W2b-115 */ 'floor-incoming', /* B-W2b-232 */ 'floor-instructions', /* B-W2b-259 */ 'floor-labels-depth', /* B-W2b-308 */ 'floor-move', /* B-W2b-310 */ 'floor-count', /* B-W2b-300 */ 'warehouse-receiving-depth'] as const

/**
 * The task a code scanned on Home opens at this station, given the tiles the person has (a tile = mode AND permission),
 * or null: Scan anything shows its card. `permissions` and `noticeBlocksScans`: the person's (B-W2b-F17: the trolley receipt
 * has no tile at a line, so its rule is read here: the permissions it takes, and no notice holding the scans).
 */
export function taskForScan(mode: FloorMode | null, read: ScanRead, tiles: readonly { key: TileKey; held: string | null }[], permissions: readonly string[] = [], noticeBlocksScans = false): TaskKey | null {
  const open = (key: TaskKey) => tiles.some((tile) => tile.key === key && tile.held === null)
  const pick = (key: TaskKey): TaskKey | null => (open(key) ? key : null)
  // A work order's traveller carries its office number (a free code): at the warehouse and the bench the task looks it
  // up as a work order number and, when it is none, hands the code on to Scan anything (`store.openScan`).
  // A cut ticket's number is a free code only Fabric cutting opens (B-W2b-F16).
  const cutTicket = read.kind === 'free' && read.cutTicket === true
  // B-W2b-F17: a trolley's label is a free code only the line's receipt (Fabric cutting at a sewing station) opens.
  const trolley = read.kind === 'free' && read.trolley === true
  const free = read.kind === 'free' && !cutTicket && !trolley
  const workOrder = (read.kind === 'label' && read.type === 'workOrder') || free
  switch (mode) {
    case 'sewing':
      // B-W2b-F17: the trolley's label at the line opens its receipt (no tile at a sewing station: the person's permissions,
      // and no notice holding the scans, as it holds the tiles that take them).
      if (trolley) return TROLLEY_RECEIPT_PERMISSIONS.every((permission) => permissions.includes(permission)) && !noticeBlocksScans ? 'fabriccut' : null
      return read.kind === 'label' && read.type === 'bundle' ? pick('operation') : null
    case 'packing':
      // A bundle is still reported at its packing operation; a garment's serial label or a free code (a shipment's
      // pack slip, a batch number) opens the packing bench with it.
      if (read.kind === 'label' && read.type === 'bundle') return pick('operation')
      if ((read.kind === 'label' && read.type === 'serial') || free) return pick('pack')
      return null
    case 'cutting':
      // A bundle at the cutting table opens Bundles (to fix its ticket); its cutting operation is reported from the tile.
      if (read.kind === 'label' && read.type === 'hide') return pick('cut')
      if (read.kind === 'label' && read.type === 'bundle') return pick('bundles')
      // B-W2b-F16: a cut ticket opens Fabric cutting with it (B-W2b-121's page opens the ticket it is handed).
      if (cutTicket) return pick('fabriccut')
      return null
    case 'warehouse':
      // B-W2b-308: a lot's label, a hide's, a roll's or a remnant's tag opens Move & put away with it (SCM-202, SCM-218).
      if (read.kind === 'label' && (read.type === 'lot' || read.type === 'hide' || read.type === 'roll' || read.type === 'remnant')) return pick('move')
      return workOrder ? pick('pick') : null
    case 'inspection':
      if (read.kind === 'label' && read.type === 'bundle') return pick('operation')
      // B-W2b-115: a lot's label or a hide's tag opens Incoming inspection at the bench (QHS-065).
      if (read.kind === 'label' && (read.type === 'lot' || read.type === 'hide')) return pick('incoming')
      return workOrder ? pick('final') : null
    default:
      return null
  }
}
