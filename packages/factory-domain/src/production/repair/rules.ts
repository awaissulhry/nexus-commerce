import type { ReworkStatus } from '../rework/rules'
import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133; design floor.mywork "repair queue", production.scrap
 * "Downgrade to second quality"), pure. The API (apps/factory-api modules/production/repair) reads the facts inside its
 * commands; the …_cutting_room_w2b_guards triggers on ReworkOrder and GarmentDowngrade stay the last word for every login.
 *
 *   the queue     the open rework of the site (OPEN or IN_PROGRESS, not scanned out): WAITING until a repair station scans
 *                 its bundle in, IN_REPAIR until it is scanned out. A tablet's own rows first: those it scanned in, then
 *                 those sent back to an operation of its station's work centre; then the rest of the site.
 *   scan in       at a station of the site, once: the time and the station together; an OPEN rework starts with it
 *                 (IN_PROGRESS). The scanned code must be the rework's bundle (confirm by scan, MES-188).
 *   scan out      once, after the scan in, and it finishes the rework (DONE) with the garments that came out good and those
 *                 scrapped, together its garments. Repair minutes = out − in, per rework: never per person, and kept apart
 *                 from piece pay (no earnings entry, no operation scan).
 *   a tablet's    a scan kept offline carries the tablet's clock: believed when it is at most AHEAD_MS ahead and BEHIND_MS
 *   time          behind the server, else the server's time; a scan out never before its scan in.
 *   downgrade     scrapped garments (a scan's scrap, a finished rework's scrap) go to second quality instead of scrap, with
 *                 a reason (ESPR: no destruction of unsold apparel for large companies): at most what the source scrapped
 *                 less what was downgraded from it already; whole garments only (a cut piece is not a garment); never while
 *                 the scan's scrap waits for its approval or was refused (B-W2b-53); a protective garment (PPE) only when
 *                 the person confirms the fault does not touch its protection. The garments are stocked as the cell's SKU
 *                 (outside finished-goods stock, so they never ship as first quality) or a second-quality item.
 *   withdraw      a wrong downgrade is withdrawn with the reason, once (its stock comes out again); never changed.
 */

// ---- the queue -----------------------------------------------------------------------------------------------------------------

export const REPAIR_STATES = ['WAITING', 'IN_REPAIR'] as const
export type RepairState = (typeof REPAIR_STATES)[number]

export interface RepairFacts {
  readonly status: ReworkStatus
  readonly repairInAt: Date | null
  readonly repairOutAt: Date | null
}

/** Where a rework stands at the repair station; null: not in the queue (finished, cancelled or scanned out). */
export function repairStateOf(rework: RepairFacts): RepairState | null {
  if (rework.status !== 'OPEN' && rework.status !== 'IN_PROGRESS') return null
  if (rework.repairOutAt) return null
  return rework.repairInAt ? 'IN_REPAIR' : 'WAITING'
}

/** Whole minutes between the scan in and the scan out (or `now` while in repair); null before the scan in. */
export function repairMinutes(repairInAt: Date | null, repairOutAt: Date | null, now?: Date): number | null {
  if (!repairInAt) return null
  const end = repairOutAt ?? now
  if (!end) return null
  return Math.max(0, Math.round((end.getTime() - repairInAt.getTime()) / 60_000))
}

export interface QueueRowFacts {
  readonly state: RepairState
  /** Scanned in at this tablet's station, or sent back to an operation of its station's work centre. */
  readonly here: boolean
  /** The work order is held: it waits at the end of its group. */
  readonly held: boolean
  readonly dueDate: string | null
  /** When it was sent back (the rework's creation) or scanned in. */
  readonly since: string
  readonly id: string
}

const rankOf = (row: QueueRowFacts) => (row.here ? (row.state === 'IN_REPAIR' ? 0 : 1) : row.state === 'WAITING' ? 2 : 3)

/** The queue's order: this station's repairs, then its waiting bundles, then the site's; held last; due date; oldest first. */
export function compareRepairRows(a: QueueRowFacts, b: QueueRowFacts): number {
  return (
    rankOf(a) - rankOf(b) ||
    Number(a.held) - Number(b.held) ||
    (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') ||
    a.since.localeCompare(b.since) ||
    a.id.localeCompare(b.id)
  )
}

/** My work's repair tile: this station's bundles in repair and waiting (hidden at zero). */
export function repairCountHere(rows: readonly Pick<QueueRowFacts, 'here'>[]): number {
  return rows.filter((row) => row.here).length
}

// ---- scans in and out ----------------------------------------------------------------------------------------------------------

export const REPAIR_STEPS = ['IN', 'OUT'] as const
export type RepairStep = (typeof REPAIR_STEPS)[number]

export const REPAIR_LIMITS = Object.freeze({
  /** A tablet clock at most this far ahead of the server is believed. */
  aheadMs: 2 * 60_000,
  /** A queued scan at most this old is believed (a shift and a half). */
  behindMs: 12 * 60 * 60_000,
  /** The queue's rows at most. */
  rows: 200,
})

/** When a scan happened: the tablet's time of a queued scan when believable, else the server's; never before `notBefore`. */
export function repairTimeOf(deviceTime: Date | null | undefined, now: Date, notBefore?: Date | null): Date {
  let at = now
  if (deviceTime) {
    const ahead = deviceTime.getTime() - now.getTime()
    if (ahead <= REPAIR_LIMITS.aheadMs && -ahead <= REPAIR_LIMITS.behindMs) at = ahead > 0 ? now : deviceTime
  }
  return notBefore && at.getTime() < notBefore.getTime() ? notBefore : at
}

export const REPAIR_REFUSALS = ['WRONG_STATE', 'ALREADY_IN', 'NOT_IN', 'NO_STATION', 'NOT_THIS_BUNDLE', 'WORK_ORDER_ON_HOLD', 'WORK_ORDER_NOT_OPEN', 'COUNTS_DO_NOT_ADD_UP'] as const
export type RepairRefusalCode = (typeof REPAIR_REFUSALS)[number]

export interface RepairRefusal {
  readonly code: RepairRefusalCode
  readonly message: string
  /** What to do about it, in words. */
  readonly fix?: string
}

const garments = (count: number) => `${count} garment${count === 1 ? '' : 's'}`

export interface ScanFacts {
  readonly step: RepairStep
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus; readonly holdReason?: string | null }
  readonly rework: RepairFacts & { readonly quantity: number; readonly bundleCode: string | null; readonly stationCode?: string | null }
  /** The tablet's station (a scan in needs one). */
  readonly station: { readonly code: string } | null
  /** The code scanned, when one was: it must be the rework's bundle. */
  readonly code?: string | null | undefined
  /** OUT: the garments that came out good and those scrapped. */
  readonly good?: number | undefined
  readonly scrap?: number | undefined
}

/** Why a bundle may not be scanned in or out at the repair station, or null. */
export function scanRefusal(facts: ScanFacts): RepairRefusal | null {
  const { rework, workOrder } = facts
  if (rework.status !== 'OPEN' && rework.status !== 'IN_PROGRESS') {
    return { code: 'WRONG_STATE', message: `This rework is ${rework.status}: nothing is repaired on it any more.`, fix: 'Pick another bundle of the queue.' }
  }
  if (facts.step === 'IN' && rework.repairInAt) {
    return { code: 'ALREADY_IN', message: `This bundle was scanned in already${rework.stationCode ? ` at ${rework.stationCode}` : ''}.`, fix: 'Scan it out when the repair is done.' }
  }
  if (facts.step === 'OUT' && !rework.repairInAt) return { code: 'NOT_IN', message: 'This bundle was not scanned in at a repair station.', fix: 'Scan it in first.' }
  if (facts.step === 'IN' && !facts.station) return { code: 'NO_STATION', message: 'This tablet belongs to no station: a repair is scanned in at a station.', fix: 'Use the tablet of the repair station.' }
  if (facts.code && rework.bundleCode && normalCode(facts.code) !== normalCode(rework.bundleCode)) {
    return { code: 'NOT_THIS_BUNDLE', message: `That is not bundle ${rework.bundleCode} of this repair.`, fix: `Scan the ticket of bundle ${rework.bundleCode}.` }
  }
  if (workOrder.status === 'ON_HOLD') {
    return { code: 'WORK_ORDER_ON_HOLD', message: `Work order ${workOrder.number} is on hold${workOrder.holdReason ? ` (${workOrder.holdReason})` : ''}: its repair waits until the hold is lifted.` }
  }
  if (workOrder.status !== 'RELEASED' && workOrder.status !== 'IN_PROGRESS') {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${workOrder.number} is ${workOrder.status}: its rework is repaired while it is RELEASED or IN_PROGRESS.` }
  }
  if (facts.step === 'OUT') {
    const good = facts.good ?? 0
    const scrap = facts.scrap ?? 0
    if (!Number.isInteger(good) || !Number.isInteger(scrap) || good < 0 || scrap < 0 || good + scrap !== rework.quantity) {
      return { code: 'COUNTS_DO_NOT_ADD_UP', message: `This repair has ${garments(rework.quantity)}: good and scrapped add up to them (${good} + ${scrap} given).` }
    }
  }
  return null
}

const normalCode = (code: string) => code.trim().toUpperCase()

// ---- second quality ------------------------------------------------------------------------------------------------------------

/** Why garments go to second quality (a code without spaces, the guard's rule; OTHER needs the words). */
export const DOWNGRADE_REASONS = ['LEATHER_FLAW', 'SHADE', 'STAIN', 'STITCHING', 'ALIGNMENT', 'MEASUREMENT', 'OTHER'] as const
export type DowngradeReason = (typeof DOWNGRADE_REASONS)[number]

/** The words of a reason (the office's lists and refusals); a reason not on the list (an older row) reads as its code. */
export const DOWNGRADE_REASON_WORDS: Readonly<Record<DowngradeReason, { readonly it: string; readonly en: string }>> = Object.freeze({
  LEATHER_FLAW: { it: 'Difetto della pelle', en: 'Leather flaw' },
  SHADE: { it: 'Tonalità diversa', en: 'Shade difference' },
  STAIN: { it: 'Macchia', en: 'Stain' },
  STITCHING: { it: 'Cucitura visibile', en: 'Visible stitching fault' },
  ALIGNMENT: { it: 'Allineamento', en: 'Alignment' },
  MEASUREMENT: { it: 'Misure fuori tolleranza', en: 'Measurements out of tolerance' },
  OTHER: { it: 'Altro', en: 'Other' },
})

export const isDowngradeReason = (value: string): value is DowngradeReason => (DOWNGRADE_REASONS as readonly string[]).includes(value)

/** The work order statuses whose garments may go to second quality (the guard's list). */
export const DOWNGRADE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'])

export const DOWNGRADE_TARGETS = ['SKU', 'ITEM'] as const
export type DowngradeTarget = (typeof DOWNGRADE_TARGETS)[number]

export const DOWNGRADE_REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'NOT_SCRAP',
  'NOT_A_GARMENT',
  'MORE_THAN_SCRAPPED',
  'NOT_A_REASON',
  'REASON_WORDS',
  'SCRAP_WAITS_APPROVAL',
  'SCRAP_REFUSED',
  'PPE_CONFIRM',
  'NO_SKU',
  'SKU_IN_FINISHED_GOODS',
  'NOT_A_SECOND_QUALITY_ITEM',
  'ALREADY_WITHDRAWN',
  'GARMENTS_MOVED',
] as const
export type DowngradeRefusalCode = (typeof DOWNGRADE_REFUSALS)[number]

export interface DowngradeRefusal {
  readonly code: DowngradeRefusalCode
  readonly message: string
  readonly fix?: string
}

export interface DowngradeFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  /** The garments the source scrapped (a scan's scrap line or lines, a finished rework's scrap); 0: it scrapped none. */
  readonly scrapped: number
  /** Already sent to second quality from the same source (withdrawn downgrades left out). */
  readonly downgraded: number
  readonly quantity: number
  /** The bundle's part: a cut piece (a sleeve) is not a garment. */
  readonly part: string | null
  readonly reasonCode: string
  readonly note?: string | null | undefined
  /** B-W2b-53: the scan's scrap above the site's limit, waiting or refused (null: none needed, or decided yes). */
  readonly approval: 'WAITING' | 'REFUSED' | null
  readonly ppe: boolean
  readonly ppeConfirmed: boolean
  readonly target: DowngradeTarget
  /** SKU: the cell's SKU exists. */
  readonly skuKnown: boolean
  /** The place named is finished-goods stock (or inside it). */
  readonly placeInFinishedGoods: boolean
  /** ITEM: the item named is a FINISHED item kept for second quality (no SKU of its own). */
  readonly itemFits?: boolean
}

/** Garments of a source still free to go to second quality. */
export const downgradeLeft = (facts: Pick<DowngradeFacts, 'scrapped' | 'downgraded'>): number => Math.max(0, facts.scrapped - facts.downgraded)

/** The garments sent to second quality from one source, withdrawn ones left out. */
export function downgradedFrom(rows: readonly { readonly sourceScanId: string | null; readonly reworkOrderId: string | null; readonly quantity: number; readonly voidedAt: unknown }[], source: { readonly sourceScanId?: string | null; readonly reworkOrderId?: string | null }): number {
  return rows
    .filter((row) => row.voidedAt === null || row.voidedAt === undefined)
    .filter((row) => (source.sourceScanId ? row.sourceScanId === source.sourceScanId : source.reworkOrderId ? row.reworkOrderId === source.reworkOrderId && row.sourceScanId === null : false))
    .reduce((sum, row) => sum + row.quantity, 0)
}

/** Why these garments may not go to second quality, or null. */
export function downgradeRefusal(facts: DowngradeFacts): DowngradeRefusal | null {
  if (!DOWNGRADE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}: its garments go to second quality while it is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED.` }
  }
  if (facts.scrapped < 1) return { code: 'NOT_SCRAP', message: 'That row scrapped no garment: only scrapped garments go to second quality.' }
  if (facts.part) return { code: 'NOT_A_GARMENT', message: `A cut piece (${facts.part}) is not a garment: only whole garments go to second quality.`, fix: 'Replace the piece with a recut instead.' }
  if (facts.approval === 'WAITING') return { code: 'SCRAP_WAITS_APPROVAL', message: 'This scrap is above the limit and waits for the team leader’s approval: nothing goes to second quality before.', fix: 'Approve or refuse the scrap first.' }
  if (facts.approval === 'REFUSED') return { code: 'SCRAP_REFUSED', message: 'The team leader refused this scrap count: there is nothing scrapped to send to second quality.' }
  const left = downgradeLeft(facts)
  if (!Number.isInteger(facts.quantity) || facts.quantity < 1 || facts.quantity > left) {
    return {
      code: 'MORE_THAN_SCRAPPED',
      message: left === 0 ? `Every garment this row scrapped (${facts.scrapped}) went to second quality already.` : `This row scrapped ${garments(facts.scrapped)}; ${left} can still go to second quality, ${facts.quantity} asked.`,
    }
  }
  if (!isDowngradeReason(facts.reasonCode)) return { code: 'NOT_A_REASON', message: `${facts.reasonCode} is not a second-quality reason: pick one of ${DOWNGRADE_REASONS.join(', ')}.` }
  if (facts.reasonCode === 'OTHER' && (facts.note ?? '').trim().length < 3) return { code: 'REASON_WORDS', message: 'Say in words why the garments go to second quality.' }
  if (facts.ppe && !facts.ppeConfirmed) {
    return {
      code: 'PPE_CONFIRM',
      message: 'This is protective clothing: it goes to second quality only when the fault does not touch its protection (seams, armour, abrasion zones). A safety fault is scrapped.',
      fix: 'Confirm the fault does not touch the protection.',
    }
  }
  if (facts.target === 'SKU' && !facts.skuKnown) return { code: 'NO_SKU', message: 'The garments of this cell have no SKU yet: keep them as a second-quality item.' }
  if (facts.target === 'SKU' && facts.placeInFinishedGoods) {
    return { code: 'SKU_IN_FINISHED_GOODS', message: 'Second-quality garments kept as the SKU go into a place outside finished-goods stock, so they never ship as first quality.', fix: 'Pick a second-quality place.' }
  }
  if (facts.target === 'ITEM' && facts.itemFits === false) return { code: 'NOT_A_SECOND_QUALITY_ITEM', message: 'That item is not kept for second quality: pick a finished item of kind FINISHED with no SKU of its own, counted in pieces.' }
  return null
}

/** Why a downgrade may not be withdrawn, or null. */
export function withdrawRefusal(downgrade: { readonly voidedAt: unknown }): DowngradeRefusal | null {
  return downgrade.voidedAt ? { code: 'ALREADY_WITHDRAWN', message: 'This downgrade is withdrawn already.' } : null
}

/** The key of a downgrade's stock move (no move column on GarmentDowngrade: the move is found by its key). */
export const downgradeMoveKey = (downgradeId: string): string => `production.downgrade:${downgradeId}:1`
/** The key of the move that takes a withdrawn downgrade's garments out again. */
export const withdrawMoveKey = (downgradeId: string): string => `production.downgrade:${downgradeId}:withdraw`
