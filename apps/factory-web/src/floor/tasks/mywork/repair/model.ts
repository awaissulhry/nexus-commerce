/**
 * My work's repair queue (B-W2b-126; MES-132; design floor.mywork "Variants: … repair queue (W2b, MES-132)"), the rules
 * without a screen: the queue as `GET /production/repair/station` answers it, what this tablet did meanwhile (a scan kept in
 * the queue changes the row on screen at once: in repair, or gone), which row a scanned code names, what the tile counts,
 * why a scan waits, and a refusal in this screen's words. Per bundle and work order: never a person, never a pace.
 */

export type RepairState = 'WAITING' | 'IN_REPAIR'

export interface RepairRow {
  readonly reworkId: string
  readonly workOrder: { readonly id: string; readonly number: string; readonly status: string; readonly dueDate: string | null; readonly rush: boolean; readonly holdReason: string | null; readonly style: { readonly code: string; readonly name: string } }
  readonly cell: { readonly id: string; readonly colourwayCode: string; readonly size: string }
  readonly bundle: { readonly id: string; readonly code: string; readonly part: string | null } | null
  readonly quantity: number
  readonly reason: { readonly code: string; readonly it: string | null; readonly en: string | null }
  readonly description: string | null
  readonly foundAt: { readonly seq: number; readonly code: string; readonly name: string } | null
  readonly reworkAt: { readonly seq: number; readonly code: string; readonly name: string }
  readonly state: RepairState
  readonly here: boolean
  readonly station: { readonly id: string; readonly code: string } | null
  readonly inAt: string | null
  readonly since: string
  readonly held: boolean
  readonly version: number
}

export interface RepairQueue {
  readonly asOf: string
  readonly station: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly rows: readonly RepairRow[]
  readonly counts: { readonly here: number; readonly waiting: number; readonly inRepair: number }
}

/** What this tablet did to a row since the queue was read: scanned in (kept or sent) or scanned out. */
export interface RepairDone {
  readonly reworkId: string
  readonly step: 'IN' | 'OUT'
  readonly at: string
  /** The queued action's id (its two ticks), or null once the office answered at once. */
  readonly clientEventId: string | null
  readonly good?: number
  readonly scrap?: number
}

/** The queue as this tablet shows it: what it scanned in is in repair here, what it scanned out is gone. */
export function withDone(queue: RepairQueue | null, done: readonly RepairDone[], station: RepairQueue['station'] | null = queue?.station ?? null): RepairQueue | null {
  if (!queue) return null
  const out = new Set(done.filter((entry) => entry.step === 'OUT').map((entry) => entry.reworkId))
  const scannedIn = new Map(done.filter((entry) => entry.step === 'IN').map((entry) => [entry.reworkId, entry]))
  const rows = queue.rows
    .filter((row) => !out.has(row.reworkId))
    .map((row) => {
      const entry = scannedIn.get(row.reworkId)
      if (!entry || row.state === 'IN_REPAIR') return row
      return { ...row, state: 'IN_REPAIR' as const, here: true, inAt: entry.at, station: station ? { id: station.id, code: station.code } : row.station }
    })
  return { ...queue, rows, counts: countsOf(rows) }
}

export function countsOf(rows: readonly Pick<RepairRow, 'here' | 'state'>[]): RepairQueue['counts'] {
  return { here: rows.filter((row) => row.here).length, waiting: rows.filter((row) => row.state === 'WAITING').length, inRepair: rows.filter((row) => row.state === 'IN_REPAIR').length }
}

/** Marks no longer needed: the office's answer shows the row moved (scanned in) or gone (scanned out). */
export function doneStill(done: readonly RepairDone[], fresh: RepairQueue): RepairDone[] {
  return done.filter((entry) => {
    const row = fresh.rows.find((candidate) => candidate.reworkId === entry.reworkId)
    return entry.step === 'IN' ? row !== undefined && row.state === 'WAITING' : row !== undefined
  })
}

const normal = (code: string) => code.trim().toUpperCase()

/** The row a scanned label names (its bundle's ticket), or null. */
export function rowOfCode(queue: RepairQueue | null, code: string): RepairRow | null {
  if (!queue) return null
  const wanted = normal(code)
  return queue.rows.find((row) => row.bundle !== null && normal(row.bundle.code) === wanted) ?? null
}

/** Is this code the row's own bundle? A row with no bundle takes no scan (its card's button starts it). */
export function isRowCode(row: Pick<RepairRow, 'bundle'>, code: string): boolean {
  return row.bundle !== null && normal(row.bundle.code) === normal(code)
}

/** My work's tile: this station's repairs (else the site's), hidden at zero. */
export function repairTile(queue: RepairQueue | null): { readonly count: number; readonly here: boolean } | null {
  if (!queue || queue.rows.length === 0) return null
  return queue.counts.here > 0 ? { count: queue.counts.here, here: true } : { count: queue.rows.length, here: false }
}

/** The reason in the screen's language, else its code. */
export function reasonWords(row: Pick<RepairRow, 'reason'>, language: string): string {
  return (language === 'it' ? row.reason.it : row.reason.en) ?? row.reason.code
}

/** Why a scan cannot go now (null: it goes, online or into the queue): a held work order, offline with nothing read. */
export type RepairHeld = 'onHold' | 'notOpen' | null

export function repairHeld(row: Pick<RepairRow, 'held' | 'workOrder'>): RepairHeld {
  if (row.held) return 'onHold'
  if (row.workOrder.status !== 'RELEASED' && row.workOrder.status !== 'IN_PROGRESS') return 'notOpen'
  return null
}

/** The refusals this screen says in its own words (factory-domain production/repair REPAIR_REFUSALS). */
export const KNOWN_REPAIR_REFUSALS = new Set(['WRONG_STATE', 'ALREADY_IN', 'NOT_IN', 'NO_STATION', 'NOT_THIS_BUNDLE', 'WORK_ORDER_ON_HOLD', 'WORK_ORDER_NOT_OPEN', 'COUNTS_DO_NOT_ADD_UP', /* this tablet's own: a label of no bundle in the queue */ 'NOT_IN_QUEUE'])

/** The scan out's counts: everything good, or the good ones typed (the rest scrapped). */
export function outCounts(row: Pick<RepairRow, 'quantity'>, good: number | null): { good: number; scrap: number } | null {
  const value = good ?? row.quantity
  if (!Number.isInteger(value) || value < 0 || value > row.quantity) return null
  return { good: value, scrap: row.quantity - value }
}
