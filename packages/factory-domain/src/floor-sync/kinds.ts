import type { Permission } from '../core/permissions'
import type { ScanIdKind } from '../numbering/kinds'

/**
 * What a floor tablet keeps in its offline queue and what it holds while offline (B-W0-30; PLT-237, PLT-239; design
 * 02-sections-floor "offline", floor.sync, floor.bundles, floor.receive, floor.final; floor-doc-numbers: document numbers
 * are online only).
 *
 * A QUEUED action is saved on the tablet first, as an event with the tablet's own id for it (`clientEventId`), its place
 * in the tablet's queue (`seq`) and the tablet's clock, and sent when the network is there (apps/factory-api
 * platform/floor-sync applies each through its own module command, in the tablet's order, once). A label it prints
 * offline takes its number from the tablet's own number block (`numbers`: numbering/blocks DEVICE blocks), never from a
 * company series.
 *
 * An ONLINE-ONLY action is never queued: it needs a number or a decision only the server gives at that moment (a goods
 * receipt and its lots, an inspection, a release: gapless document numbers; garment serials: their labels print online in
 * W1). While offline its screen holds it, with the reason in words; nothing is kept on the tablet.
 */

export const FLOOR_SYNC_KINDS = [
  'production.scan.report',
  'production.scan.undo',
  'production.scan.ask',
  'production.cut.log',
  'production.cut.remnant',
  'production.bundles.make',
  // B-W2a-73: a machine problem from the station (design floor.machine "offline: queued"; Owner answer H1).
  'plant.report',
  // B-W2b-29: off-standard and indirect time started and ended on the floor (MES-156, MES-158; the tablet's time kept).
  'production.offStandard.start',
  'production.offStandard.end',
  // B-W2b-33: the signed-in worker's clock-in, clock-out or break kept offline with the tablet's time (MES-199).
  'people.clock.record',
] as const
export type FloorSyncKind = (typeof FLOOR_SYNC_KINDS)[number]

export function isFloorSyncKind(value: unknown): value is FloorSyncKind {
  return typeof value === 'string' && (FLOOR_SYNC_KINDS as readonly string[]).includes(value)
}

export interface QueuedAction {
  readonly kind: FloorSyncKind
  /** The permission its module command needs (at the tablet's own site). */
  readonly permission: Permission
  /** A label the tablet prints offline for it takes its number from the tablet's own block of this kind. */
  readonly numbers: ScanIdKind | null
  /** What it is, in words (the office's lists; the tablet has its own words per kind). */
  readonly what: string
}

export const QUEUED_ACTIONS: Readonly<Record<FloorSyncKind, QueuedAction>> = Object.freeze({
  'production.scan.report': { kind: 'production.scan.report', permission: 'production.scan', numbers: null, what: 'Report a bundle at an operation' },
  'production.scan.undo': { kind: 'production.scan.undo', permission: 'production.scan', numbers: null, what: 'Undo a report' },
  'production.scan.ask': { kind: 'production.scan.ask', permission: 'production.scan', numbers: null, what: 'Ask a correction of a report' },
  'production.cut.log': { kind: 'production.cut.log', permission: 'production.cut', numbers: null, what: 'Log a cut on a hide' },
  'production.cut.remnant': { kind: 'production.cut.remnant', permission: 'production.cut', numbers: null, what: "Set a hide's remnant aside" },
  'production.bundles.make': { kind: 'production.bundles.make', permission: 'production.bundles', numbers: 'BUNDLE', what: 'Make a bundle and print its ticket' },
  'plant.report': { kind: 'plant.report', permission: 'plant.report', numbers: null, what: 'Report a machine problem' },
  // B-W2b-29
  'production.offStandard.start': { kind: 'production.offStandard.start', permission: 'floor.work', numbers: null, what: 'Start off-standard or indirect time' },
  'production.offStandard.end': { kind: 'production.offStandard.end', permission: 'floor.work', numbers: null, what: 'End off-standard or indirect time' },
  // B-W2b-33
  'people.clock.record': { kind: 'people.clock.record', permission: 'floor.work', numbers: null, what: 'Clock in, clock out or a break' },
} satisfies Record<FloorSyncKind, QueuedAction>)

export const ONLINE_ONLY_ACTIONS = ['inventory.receive', 'quality.inspection', 'quality.release', 'production.serials.labels'] as const
export type OnlineOnlyAction = (typeof ONLINE_ONLY_ACTIONS)[number]

export interface OnlineOnly {
  readonly action: OnlineOnlyAction
  /** Why it waits for the network, in words. */
  readonly message: string
}

export const ONLINE_ONLY: Readonly<Record<OnlineOnlyAction, OnlineOnly>> = Object.freeze({
  'inventory.receive': { action: 'inventory.receive', message: 'A goods receipt and its lots take their numbers from the office at once: receiving needs the network.' },
  'quality.inspection': { action: 'quality.inspection', message: 'An inspection takes its number from the office at once: it needs the network.' },
  'quality.release': { action: 'quality.release', message: 'A release takes its number from the office and is signed there at once: it needs the network.' },
  'production.serials.labels': { action: 'production.serials.labels', message: 'Garment serials and their labels are given by the office at once: they need the network.' },
} satisfies Record<OnlineOnlyAction, OnlineOnly>)

export function isOnlineOnly(value: unknown): value is OnlineOnlyAction {
  return typeof value === 'string' && (ONLINE_ONLY_ACTIONS as readonly string[]).includes(value)
}

/** How a floor action behaves offline: kept in the queue, held until the network is back, or not a floor action. */
export type OfflineBehaviour = { readonly queues: true; readonly action: QueuedAction } | { readonly queues: false; readonly held: OnlineOnly } | null

export function offlineBehaviourOf(action: string): OfflineBehaviour {
  if (isFloorSyncKind(action)) return { queues: true, action: QUEUED_ACTIONS[action] }
  if (isOnlineOnly(action)) return { queues: false, held: ONLINE_ONLY[action] }
  return null
}
