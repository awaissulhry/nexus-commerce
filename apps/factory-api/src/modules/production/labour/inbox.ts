import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_LABOUR_VIEW } from '@nexus/factory-domain/production/labour/permissions'
import { blockersOf, changesOf, LABOUR_LIMITS, lineDayState, readDisputeMessage, type Change, type InboxKind } from '@nexus/factory-domain/production/labour/rules'
import { minutesOf, unusualOf } from '@nexus/factory-domain/production/offstandard/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { codesById, editedBlocks } from '../offstandard/store'
import { officeOf } from './access'
import type { InboxQuery } from './contract'
import { linesInScope, openDays, reportsOf, sitesInScope } from './days'
import { bundlesById, isoDay, lineOf, lineSources, linesById, operationsById, workOrdersById, type Reader } from './store'

/**
 * One queue (B-W2b-45; design production.labour "To decide": "Correction requests (MES-096), disputes (MES-206),
 * off-standard blocks (MES-157) and line days to close (MES-203) as one queue", columns kind · line · date · work order /
 * bundle / operation · what changes (ChangeValue from → to) · age; the tiles "Corrections to decide", "Disputes open",
 * "Off-standard blocks to approve", "Line days to close"). Oldest first. Read with production.labour.view over the sites
 * the caller reaches (scopeWhere); each item is decided on its own record and route (scans' corrections, this module's
 * disputes and line days, off-standard blocks).
 *
 * Never who (Owner answers W1, F2; Statuto dei Lavoratori art. 4): an item says where, when, what, and whether its record
 * names a person (`named`), never the person; no filter, group or total by person.
 */

interface Item {
  readonly kind: InboxKind
  readonly id: string
  readonly version: number | null
  readonly siteId: string
  readonly line: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly workDate: string | null
  readonly workOrder: { readonly id: string; readonly number: string } | null
  readonly bundle: { readonly id: string; readonly code: string } | null
  readonly operation: { readonly id: string; readonly seq: number; readonly code: string; readonly name: string } | null
  readonly changes: readonly Change[]
  readonly code: string | null
  readonly minutes: number | null
  readonly recordType: string | null
  readonly recordId: string | null
  readonly unusual: readonly string[]
  readonly named: boolean
  readonly raisedAt: Date
}

const placeOf = (row: { id: string; code: string; name: string } | undefined) => (row ? { id: row.id, code: row.code, name: row.name } : null)

/** Every item waiting in the caller's scope (unsorted), and the line days held. */
async function gather(db: Reader, caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined; readonly kind?: InboxKind | undefined }, now: Date) {
  const actor = actorOf(officeOf(caller))
  const dayLines = await linesInScope(db, caller, query)
  const sites = await sitesInScope(db, caller, query)
  const siteIds = sites.map((site) => site.id)
  const zoneOf = new Map(sites.map((site) => [site.id, site.timezone]))
  const items: Item[] = []
  const wants = (kind: InboxKind) => !query.kind || query.kind === kind
  let held = 0

  if (wants('CORRECTION') && siteIds.length > 0) {
    const requests = await db.scanCorrectionRequest.findMany({
      where: { status: 'PENDING', siteId: { in: siteIds } },
      select: { id: true, version: true, siteId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, scanId: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true, serverTime: true },
    })
    if (requests.length > 0) {
      const roots = await reportsOf(db, requests.map((request) => request.scanId))
      const scans = new Map((await db.operationScan.findMany({ where: { id: { in: requests.map((request) => request.scanId) } }, select: { id: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true } })).map((row) => [row.id, row]))
      const allLines = await lineSources(db, dayLines.map((entry) => entry.line.id))
      const lines = await linesById(db, [...new Set([...allLines.stationLine.values(), ...allLines.deviceLine.values()])])
      const operations = await operationsById(db, requests.map((request) => request.workOrderOperationId))
      const bundles = await bundlesById(db, requests.map((request) => request.bundleId))
      const workOrders = await workOrdersById(db, requests.map((request) => request.workOrderId))
      for (const request of requests) {
        const root = roots.get(request.scanId)
        const lineId = root ? lineOf(allLines, root) : null
        if (query.lineId && lineId !== query.lineId) continue
        const scan = scans.get(request.scanId)
        const operation = operations.get(request.workOrderOperationId)
        items.push({
          kind: 'CORRECTION',
          id: request.id,
          version: request.version,
          siteId: request.siteId,
          line: lineId ? placeOf(lines.get(lineId)) : null,
          workDate: root ? businessDate(root.serverTime, zoneOf.get(request.siteId)) : null,
          workOrder: workOrders.get(request.workOrderId) ?? null,
          bundle: bundles.get(request.bundleId) ?? null,
          operation: operation ? { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name } : null,
          changes: scan ? changesOf({ good: scan.goodQuantity, scrap: scan.scrapQuantity, rework: scan.reworkQuantity }, { good: request.goodQuantity, scrap: request.scrapQuantity, rework: request.reworkQuantity }) : [],
          code: null,
          minutes: null,
          recordType: 'OperationScan',
          recordId: root?.id ?? request.scanId,
          unusual: [],
          named: true,
          raisedAt: request.serverTime,
        })
      }
    }
  }

  if (wants('DISPUTE') && siteIds.length > 0) {
    const disputes = await db.labourDispute.findMany({
      where: { status: 'OPEN', siteId: { in: siteIds }, ...(query.lineId ? { lineId: query.lineId } : {}) },
      select: { id: true, version: true, siteId: true, lineId: true, workDate: true, recordType: true, recordId: true, message: true, createdAt: true },
    })
    const lines = await linesById(db, disputes.map((row) => row.lineId))
    for (const row of disputes) {
      items.push({
        kind: 'DISPUTE',
        id: row.id,
        version: row.version,
        siteId: row.siteId,
        line: row.lineId ? placeOf(lines.get(row.lineId)) : null,
        workDate: isoDay(row.workDate),
        workOrder: null,
        bundle: null,
        operation: null,
        changes: [],
        code: readDisputeMessage(row.message).reason,
        minutes: null,
        recordType: row.recordType,
        recordId: row.recordId,
        unusual: [],
        named: true,
        raisedAt: row.createdAt,
      })
    }
  }

  if (wants('OFF_STANDARD')) {
    const blocks = await db.offStandardEntry.findMany({
      where: { AND: [scopeWhere(actor, PRODUCTION_LABOUR_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.OffStandardEntryWhereInput, { status: 'PENDING' }, query.siteId ? { siteId: query.siteId } : {}, query.lineId ? { lineId: query.lineId } : {}] },
      select: { id: true, version: true, siteId: true, lineId: true, workDate: true, codeId: true, source: true, startedAt: true, endedAt: true, workerId: true },
    })
    const codes = await codesById(db, blocks.map((block) => block.codeId))
    const lines = await linesById(db, blocks.map((block) => block.lineId))
    const edited = await editedBlocks(db, blocks.map((block) => block.id))
    for (const block of blocks) {
      items.push({
        kind: 'OFF_STANDARD',
        id: block.id,
        version: block.version,
        siteId: block.siteId,
        line: block.lineId ? placeOf(lines.get(block.lineId)) : null,
        workDate: isoDay(block.workDate),
        workOrder: null,
        bundle: null,
        operation: null,
        changes: [],
        code: codes.get(block.codeId)?.code ?? null,
        minutes: minutesOf(block.startedAt, block.endedAt, now),
        recordType: 'OffStandardEntry',
        recordId: block.id,
        unusual: unusualOf({ status: 'PENDING', source: block.source, startedAt: block.startedAt, endedAt: block.endedAt, edited: edited.has(block.id) }, now),
        named: block.workerId !== null,
        raisedAt: block.endedAt ?? block.startedAt,
      })
    }
  }

  if (wants('LINE_DAY')) {
    for (const acc of await openDays(db, caller, query, now)) {
      const facts = { closed: false, counts: acc.counts }
      if (lineDayState(facts) !== 'READY') {
        held += blockersOf(facts).length > 0 ? 1 : 0
        continue
      }
      items.push({
        kind: 'LINE_DAY',
        id: `${acc.line.id}:${acc.workDate}`,
        version: acc.row?.version ?? null,
        siteId: acc.site.id,
        line: placeOf(acc.line),
        workDate: acc.workDate,
        workOrder: null,
        bundle: null,
        operation: null,
        changes: [],
        code: null,
        minutes: null,
        recordType: 'LabourDay',
        recordId: acc.row?.id ?? null,
        unusual: [],
        named: false,
        // A day waits from its end (the next day's start, as the screen ages it).
        raisedAt: acc.row?.reopenedAt ?? new Date(`${acc.workDate}T23:59:59.000Z`),
      })
    }
  }
  return { items, held }
}

const ageOf = (raisedAt: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - raisedAt.getTime()) / 60_000))

export async function labourInbox(caller: CommandCaller, query: InboxQuery) {
  officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const { items } = await gather(db, caller, query, now)
    const sorted = [...items].sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || (a.id < b.id ? -1 : 1))
    const limit = Math.min(query.limit, LABOUR_LIMITS.rows)
    return {
      items: sorted.slice(0, limit).map((item) => ({ ...item, changes: [...item.changes], unusual: [...item.unusual], raisedAt: toUtcIso(item.raisedAt), ageMinutes: ageOf(item.raisedAt, now) })),
      more: sorted.length > limit,
    }
  })
}

/** The tiles: what waits per kind in the caller's scope. Counts of records, never of people. */
export async function labourCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }) {
  officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const { items, held } = await gather(db, caller, query, now)
    const count = (kind: InboxKind) => items.filter((item) => item.kind === kind).length
    return { corrections: count('CORRECTION'), disputes: count('DISPUTE'), offStandard: count('OFF_STANDARD'), lineDays: count('LINE_DAY'), heldDays: held }
  })
}
