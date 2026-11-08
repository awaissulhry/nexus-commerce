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
  // B-W2b-35: a help call from the station and a step of one (design floor.help "offline: the call waits on this tablet").
  'andon.call.send',
  'andon.call.answer',
  // B-W2b-33: the signed-in worker's clock-in, clock-out or break kept offline with the tablet's time (MES-199).
  'people.clock.record',
  // B-W2b-40: operation timing kept offline with the tablet's time (MES-087 start, -088 pause, -089 resume, -091 hand
  // back, -092 pieces so far; a team's members in the payload, MES-094).
  'production.scan.start',
  'production.scan.pause',
  'production.scan.resume',
  'production.scan.handBack',
  'production.scan.partial',
  // B-W2b-47: kept offline with the tablet's time: a report on someone's behalf (MES-099; the override stays online), a step
  // ticked (MES-102), a comment (MES-101: its photo goes up when the network is back, before the note is sent).
  'production.scan.onBehalf',
  'production.checklist.tick',
  'production.floorNote.post',
  // B-W2b-49: a line's handover note written on the floor (design floor.supervisor: the line view works offline).
  'andon.handover.write',
  // B-W2b-96: a machine request's progress from the floor (QHS-180): a technician acknowledges it or is on the way, the
  // station confirms the machine works again (design floor.machine "Works offline").
  'plant.request.progress',
  // B-W2b-99: a roving result or an end-of-line pass or defect recorded in one step (design floor.inline "Works offline").
  'quality.inprocess.record',
  // B-W2b-106: an open inspection recorded offline (QHS-062; design floor.final, floor.incoming, floor.inline "Works offline"):
  // a final inspection's results, measurements, sample count, serial scans, defects or W1 checklist; an incoming inspection's
  // hides and plan checks; an in-process check's plan checks. Opening, signing and cancelling stay online.
  'quality.final.record',
  'quality.incoming.record',
  'quality.inprocess.results',
  // B-W2b-126: a bundle scanned in or out at a repair station (MES-132; design floor.mywork "Works offline"), with the tablet's time.
  'production.repair.scan',
  // B-W2b-125: an incident, a near miss or a hazard reported with the worker's name (design floor.incident "Works offline":
  // "honest that it waits when offline"). One sent WITHOUT a name never goes through the queue (its ledger names the tablet):
  // the module refuses it here, the tablet sends it online.
  'safety.incident.report',
  // B-W2b-116: a lay at the cutting table (design floor.fabriccut "Works offline": "Add a roll to the lay", "Check plies when both
  // ends match"): a roll spread on it with its plies, splices, end loss and end returned, the last one undone, both ends counted.
  'production.lay.roll',
  'production.lay.undo',
  'production.lay.count',
  // B-W2b-117: a trolley to sewing kept offline (MES-048; design floor.fabriccut "Works offline", "Send a trolley to a line:
  // scans → Send"): a bundle scanned onto a trolley or taken off, the trolley sent, the line's scan of its label. Each names the
  // trolley by its label, never by an id the tablet could not know offline.
  'production.trolley.load',
  'production.trolley.unload',
  'production.trolley.send',
  'production.trolley.receive',
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
  // B-W2b-35: every floor role calls (floor.work); the module checks again who may take the step (the station, or a responder).
  'andon.call.send': { kind: 'andon.call.send', permission: 'floor.work', numbers: null, what: 'Call for help from the station' },
  'andon.call.answer': { kind: 'andon.call.answer', permission: 'floor.work', numbers: null, what: 'Answer or close a help call' },
  // B-W2b-33
  'people.clock.record': { kind: 'people.clock.record', permission: 'floor.work', numbers: null, what: 'Clock in, clock out or a break' },
  // B-W2b-40: the scans' permission (timing is part of working a bundle at an operation).
  'production.scan.start': { kind: 'production.scan.start', permission: 'production.scan', numbers: null, what: 'Start a bundle at an operation' },
  'production.scan.pause': { kind: 'production.scan.pause', permission: 'production.scan', numbers: null, what: 'Pause a bundle with a reason' },
  'production.scan.resume': { kind: 'production.scan.resume', permission: 'production.scan', numbers: null, what: 'Resume a paused bundle' },
  'production.scan.handBack': { kind: 'production.scan.handBack', permission: 'production.scan', numbers: null, what: 'Hand back an unfinished bundle' },
  'production.scan.partial': { kind: 'production.scan.partial', permission: 'production.scan', numbers: null, what: 'Report the pieces done so far' },
  // B-W2b-47: the team leader's own right for a report on behalf; steps and notes are part of working a bundle.
  'production.scan.onBehalf': { kind: 'production.scan.onBehalf', permission: 'production.scan.behalf', numbers: null, what: "Report a bundle on someone's behalf" },
  'production.checklist.tick': { kind: 'production.checklist.tick', permission: 'production.scan', numbers: null, what: 'Tick a step of an operation' },
  'production.floorNote.post': { kind: 'production.floorNote.post', permission: 'production.scan', numbers: null, what: 'Post a comment or photo to a work order' },
  // B-W2b-49
  'andon.handover.write': { kind: 'andon.handover.write', permission: 'production.dispatch.handover', numbers: null, what: "Write a line's handover note" },
  // B-W2b-96: every floor role reports (plant.report); the module asks plant.jobs.work again for a technician's step.
  'plant.request.progress': { kind: 'plant.request.progress', permission: 'plant.report', numbers: null, what: "A machine request's progress: acknowledged, on the way, works again" },
  // B-W2b-99: a first piece is signed with the PIN at once, so it stays online; a roving or end-of-line result queues.
  'quality.inprocess.record': { kind: 'quality.inprocess.record', permission: 'quality.inprocess.record', numbers: null, what: 'Record a roving or end-of-line check' },
  // B-W2b-106: each under its module's record permission; the module checks again whose the inspection is.
  'quality.final.record': { kind: 'quality.final.record', permission: 'quality.inspections.record', numbers: null, what: 'Record a final inspection (results, measurements, count, serials, defects)' },
  'quality.incoming.record': { kind: 'quality.incoming.record', permission: 'quality.incoming.record', numbers: null, what: 'Record an incoming inspection (a hide, plan checks)' },
  'quality.inprocess.results': { kind: 'quality.inprocess.results', permission: 'quality.inprocess.record', numbers: null, what: "Record an in-process check's plan checks" },
  // B-W2b-126: the repair station's own right; the module checks again the rework, its bundle and the station.
  'production.repair.scan': { kind: 'production.repair.scan', permission: 'production.repair', numbers: null, what: 'Scan a bundle in or out at a repair station' },
  // B-W2b-125: anyone at the station reports (floor.work, as a help call); the number is taken when the office records it.
  'safety.incident.report': { kind: 'safety.incident.report', permission: 'floor.work', numbers: null, what: 'Report an incident, a near miss or a hazard' },
  // B-W2b-116: the cutting table's own right; the module checks again the lay, its started ticket and the rolls.
  'production.lay.roll': { kind: 'production.lay.roll', permission: 'production.cut', numbers: null, what: 'Spread a roll on a lay' },
  'production.lay.undo': { kind: 'production.lay.undo', permission: 'production.cut', numbers: null, what: 'Undo the last roll of a lay' },
  'production.lay.count': { kind: 'production.lay.count', permission: 'production.cut', numbers: null, what: "Count a lay's plies at both ends" },
  // B-W2b-117: the trolleys' own right; the module checks again the bundle, the trolley and the line as they stand on arrival.
  'production.trolley.load': { kind: 'production.trolley.load', permission: 'production.trolleys', numbers: null, what: 'Scan a bundle onto a trolley to sewing' },
  'production.trolley.unload': { kind: 'production.trolley.unload', permission: 'production.trolleys', numbers: null, what: 'Take a bundle off a trolley' },
  'production.trolley.send': { kind: 'production.trolley.send', permission: 'production.trolleys', numbers: null, what: 'Send a trolley to a sewing line' },
  'production.trolley.receive': { kind: 'production.trolley.receive', permission: 'production.trolleys', numbers: null, what: 'Confirm a trolley at the line' },
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
