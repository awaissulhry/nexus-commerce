import type { Prisma } from '@nexus/factory-db'
import { PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_BUNDLES_VIEW } from '@nexus/factory-domain/production/bundles/permissions'
import type { BundlePlace } from '@nexus/factory-domain/production/bundles/where'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { bundleView } from './bundles'
import { couponView, readCouponByCode, readCoupons } from './coupons'
import { shadesOf } from './matching'
import { BUNDLE_COLUMNS, readBundle, readReprints, readTicketJobs, type BundleRow, type Reader } from './store'
import { placeView, stationsOf, trackBundles, type Tracked } from './track'
import { hidesOf } from './views'

/**
 * Where every bundle is (B-W2b-41; MES-074, MES-168; design production.bundles SCR-259: tiles, the grid, the Bundle
 * record; production.floor "Stuck bundles"). Office reads with production.bundles.view over the work orders' company
 * and site (a bundle has no company column: the list is scoped through its work order). The place, the last scan and
 * the stuck wait come from track.ts; nothing here carries money or names a person (the record's Scans tab is the work
 * order's scans route, GET /production/scans/work-orders/:id/scans?bundleId=, where the site names workers: one record).
 */

/** The work orders whose bundles still move: the tiles and the stuck list read only those (finished ones stay ACTIVE for good). */
const OPEN_WORK_ORDERS = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
/** The most ACTIVE bundles one tiles or stuck read tracks (the rest: narrow by site). */
export const MAX_TRACKED = 5000
/** The most rows one list request reads to find a page that matches a place or stuck filter. */
const MAX_SCANNED = 2000

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The bundles the caller may read with production.bundles.view, through their work orders' company and site. */
function scopeOf(context: OfficeContext): Prisma.BundleWhereInput {
  return { workOrder: { is: scopeWhere(actorOf(context), PRODUCTION_BUNDLES_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput } }
}

/** The grid's row: the bundle, its work order and cell, its place now, last scan, stuck wait and genealogy (MES-074). */
function rowView(row: Tracked, stations: Awaited<ReturnType<typeof stationsOf>>, hides: Awaited<ReturnType<typeof hidesOf>>) {
  const own = new Map(row.bundle.cutLogIds.flatMap((id) => (hides.has(id) ? [[hides.get(id)!.hideId, hides.get(id)!] as const] : [])))
  return {
    id: row.bundle.id,
    code: row.bundle.code,
    replacedCodes: [...row.bundle.replacedCodes],
    status: row.bundle.status,
    siteId: row.bundle.siteId,
    workOrder: { id: row.workOrder.id, number: row.workOrder.number, status: row.workOrder.status },
    style: row.style ?? { id: row.workOrder.styleId, code: '', name: '' },
    workOrderSizeId: row.bundle.workOrderSizeId,
    colourwayCode: row.cell?.colourwayCode ?? '',
    colourwayName: row.cell?.colourwayName ?? '',
    size: row.cell?.size ?? '',
    part: row.bundle.part,
    quantity: row.bundle.quantity,
    parentBundleId: row.bundle.parentBundleId,
    ...placeView(row, stations),
    hides: [...own.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
    voidedAt: row.bundle.voidedAt ? toUtcIso(row.bundle.voidedAt) : null,
    createdAt: toUtcIso(row.bundle.createdAt),
  }
}

async function rowsOf(db: Reader, rows: readonly Tracked[]) {
  const stations = await stationsOf(db, rows.map((row) => row.lastScan?.stationId ?? null))
  const hides = await hidesOf(db, [...new Set(rows.flatMap((row) => row.bundle.cutLogIds))])
  return rows.map((row) => rowView(row, stations, hides))
}

// ---- the grid ----------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly status?: 'ACTIVE' | 'VOID' | undefined
  readonly place?: readonly BundlePlace[] | undefined
  readonly stuck?: boolean | undefined
  /** A scanned or typed ticket or coupon code, or a work order number. */
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /production/bundles: newest first, in pages (a place or stuck filter reads on until a page is full). */
export async function listBundles(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const typed = query.q?.trim().toUpperCase()
    const couponBundle = typed ? (await readCouponByCode(db, typed))?.bundleId : undefined
    const filters: Prisma.BundleWhereInput[] = [
      scopeOf(context),
      query.siteId ? { siteId: query.siteId } : {},
      query.workOrderId ? { workOrderId: query.workOrderId } : {},
      query.status ? { status: query.status } : {},
      typed ? { OR: [{ code: typed }, { replacedCodes: { has: typed } }, { workOrder: { is: { number: query.q!.trim() } } }, ...(couponBundle ? [{ id: couponBundle }] : [])] } : {},
    ]
    const filtered = (query.place && query.place.length > 0) || query.stuck === true
    const page: Tracked[] = []
    let cursor = query.cursor
    let scanned = 0
    let more = false
    while (page.length < query.limit) {
      const take = filtered ? 200 : query.limit + 1
      const batch = await db.bundle.findMany({ where: { AND: [...filters, cursor ? { id: { lt: cursor } } : {}] }, select: BUNDLE_COLUMNS, orderBy: { id: 'desc' }, take })
      if (batch.length === 0) break
      const tracked = await trackBundles(db, filtered ? batch : batch.slice(0, query.limit), now)
      for (const row of tracked) {
        if (page.length >= query.limit) {
          more = true
          break
        }
        cursor = row.bundle.id
        if (query.place && query.place.length > 0 && !query.place.includes(row.place.place)) continue
        if (query.stuck === true && !row.stuck.stuck) continue
        page.push(row)
      }
      scanned += batch.length
      if (!filtered) {
        more = batch.length > query.limit
        break
      }
      if (batch.length < take) break
      if (scanned >= MAX_SCANNED) {
        more = true
        break
      }
      cursor = batch.at(-1)!.id
    }
    return { bundles: await rowsOf(db, page), nextCursor: more ? (filtered ? (cursor ?? null) : (page.at(-1)?.bundle.id ?? null)) : null, asOf: toUtcIso(now) }
  })
}

// ---- the tiles and the stuck list -----------------------------------------------------------------------------------------------

/** The ACTIVE bundles of the caller's open work orders (at a site when named), tracked. */
async function openTracked(db: Reader, context: OfficeContext, siteId: string | undefined, now: Date): Promise<{ rows: Tracked[]; capped: boolean }> {
  const bundles = await db.bundle.findMany({
    where: { AND: [scopeOf(context), siteId ? { siteId } : {}, { status: 'ACTIVE' }, { workOrder: { is: { status: { in: [...OPEN_WORK_ORDERS] } } } }] },
    select: BUNDLE_COLUMNS,
    orderBy: { id: 'desc' },
    take: MAX_TRACKED + 1,
  })
  return { rows: await trackBundles(db, bundles.slice(0, MAX_TRACKED), now), capped: bundles.length > MAX_TRACKED }
}

/** GET /production/bundles/tiles: Active · Stuck (no scan for the site's limit) · Tickets replaced today · On hold · At a subcontractor. */
export async function bundleTiles(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const { rows, capped } = await openTracked(db, context, query.siteId, now)
    // Today: from the business day's start to the next one's (a row dated later is not today's).
    const today = businessDate(now)
    const day = { gte: businessDayStart(today), lt: businessDayStart(plusDays(today, 1)) }
    const scope = scopeOf(context)
    const site = query.siteId ? { siteId: query.siteId } : {}
    const reprints = await db.bundleReprint.count({ where: { createdAt: day, ...site, bundle: { is: scope } } })
    const couponReprints = await db.bundleCoupon.count({ where: { createdAt: day, replacesId: { not: null }, ...site, bundle: { is: scope } } })
    const limits = [...new Set(rows.map((row) => row.limitHours))]
    return {
      active: rows.length,
      stuck: rows.filter((row) => row.stuck.stuck).length,
      /** The site's limit when one site is read (the tile's "No scan for N h"); null when sites differ. */
      stuckLimitHours: limits.length === 1 ? limits[0]! : null,
      ticketsReplacedToday: reprints + couponReprints,
      onHold: rows.filter((row) => row.place.place === 'QUALITY' && row.place.qualityReason === 'HOLD').length,
      atSubcontractor: rows.filter((row) => row.place.place === 'SUBCONTRACTOR').length,
      capped,
      asOf: toUtcIso(now),
    }
  })
}

/** GET /production/bundles/stuck: the bundles with no scan past their site's limit, the longest wait first (MES-168). */
export async function stuckBundles(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const { rows, capped } = await openTracked(db, context, query.siteId, now)
    const stuck = rows.filter((row) => row.stuck.stuck).sort((a, b) => b.stuck.hours - a.stuck.hours || (a.bundle.code < b.bundle.code ? -1 : 1))
    return { bundles: await rowsOf(db, stuck), capped, asOf: toUtcIso(now) }
  })
}

// ---- the bundle record --------------------------------------------------------------------------------------------------------

const COUNT_KINDS = ['REPORT', 'UNDO', 'CORRECTION'] as const

/** GET /production/bundles/:bundleId: progress, quality, genealogy, ticket and coupons of one bundle (SCR-259 record). */
export async function bundleRecord(caller: CommandCaller, bundleId: string) {
  const context = officeOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const found = isUuid(bundleId) ? await db.bundle.findFirst({ where: { AND: [{ id: bundleId }, scopeOf(context)] }, select: BUNDLE_COLUMNS }) : null
    if (!found) throw new NotFoundError('This bundle does not exist or is in another company.')
    const [row] = await trackBundles(db, [found], now)
    if (!row) throw new NotFoundError('This bundle does not exist or is in another company.')
    const header = (await db.workOrder.findUnique({ where: { id: row.workOrder.id }, select: { id: true, number: true, batchNumber: true, status: true, companyId: true, siteId: true } }))!
    const cells = new Map(row.cell ? [[row.bundle.workOrderSizeId, row.cell]] : [])
    // Progress: per scanned operation, done · here · not reached, with the standing report's counts.
    const counts = await db.operationScan.findMany({
      where: { bundleId: row.bundle.id, kind: { in: [...COUNT_KINDS] } },
      select: { id: true, workOrderOperationId: true, kind: true, correctsId: true, goodQuantity: true, scrapQuantity: true, reworkQuantity: true },
    })
    const voided = new Set(counts.flatMap((scan) => (scan.correctsId ? [scan.correctsId] : [])))
    const standing = new Map(counts.filter((scan) => scan.kind !== 'UNDO' && !voided.has(scan.id)).map((scan) => [scan.workOrderOperationId, scan]))
    const progress = row.operations.map((operation) => {
      const report = standing.get(operation.id)
      const state = report ? ('DONE' as const) : row.place.next?.id === operation.id && (row.place.place === 'LINE' || row.place.place === 'CUTTING') ? ('HERE' as const) : ('NOT_REACHED' as const)
      return { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name, scanRequired: operation.scanRequired, state, good: report?.goodQuantity ?? null, scrap: report?.scrapQuantity ?? null, rework: report?.reworkQuantity ?? null }
    })
    // Quality: the holds on it or its work order, the reworks it travels in (open and done).
    const holds = row.holdIds.length ? await db.qualityHold.findMany({ where: { id: { in: [...row.holdIds] } }, select: { id: true, subjectType: true, reasonCode: true, placedAt: true } }) : []
    const reworks = await db.reworkOrder.findMany({ where: { bundleId: row.bundle.id }, select: { id: true, status: true, quantity: true, createdAt: true }, orderBy: { createdAt: 'asc' } })
    // Genealogy: the hides and lots (with their shade), the bundle it was split off and its own splits, the garments' serials.
    const hides = await hidesOf(db, row.bundle.cutLogIds)
    const shades = await shadesOf(db, [row.bundle])
    const parent = row.bundle.parentBundleId ? await readBundle(db, row.bundle.parentBundleId) : null
    const children = await db.bundle.findMany({ where: { parentBundleId: row.bundle.id }, select: { id: true, code: true, quantity: true, status: true }, orderBy: { createdAt: 'asc' } })
    const serials = await db.garmentSerial.findMany({ where: { bundleId: row.bundle.id }, select: { id: true, serial: true, status: true }, orderBy: { serial: 'asc' }, take: 200 })
    // Ticket: the current code, the replaced ones, the reprints (why, where; never who), the print jobs (print.view), the coupons.
    const seesPrints = can(actorOf(context), PRINT_VIEW, { companyId: header.companyId, siteId: header.siteId })
    const reprints = await readReprints(db, [row.bundle.id])
    const jobs = seesPrints ? await readTicketJobs(db, [row.bundle.id]) : []
    const coupons = await readCoupons(db, [row.bundle.id])
    const operations = new Map(row.operations.map((operation) => [operation.id, operation]))
    const stations = await stationsOf(db, [row.lastScan?.stationId ?? null])
    const ownHides = new Map(row.bundle.cutLogIds.flatMap((id) => (hides.has(id) ? [[hides.get(id)!.hideId, hides.get(id)!] as const] : [])))
    return {
      bundle: { ...bundleView(row.bundle as BundleRow, cells), colourwayName: row.cell?.colourwayName ?? '', scans: row.scans.length },
      workOrder: { id: header.id, number: header.number, batchNumber: header.batchNumber, status: header.status, siteId: header.siteId },
      style: row.style ?? { id: row.workOrder.styleId, code: '', name: '' },
      ...placeView(row, stations),
      progress,
      quality: {
        holds: holds.map((hold) => ({ id: hold.id, subjectType: hold.subjectType, reasonCode: hold.reasonCode, placedAt: toUtcIso(hold.placedAt) })),
        reworks: reworks.map((rework) => ({ id: rework.id, status: rework.status, quantity: rework.quantity, createdAt: toUtcIso(rework.createdAt) })),
      },
      genealogy: {
        hides: [...ownHides.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
        shades: shades.get(row.bundle.id) ?? [],
        parent: parent ? { id: parent.id, code: parent.code } : null,
        children,
        serials,
      },
      ticket: {
        code: row.bundle.code,
        replacedCodes: [...row.bundle.replacedCodes],
        reprints: reprints.map((reprint) => ({ code: reprint.code, replacedCode: reprint.replacedCode, reason: reprint.reason, printerId: reprint.printerId, postedBy: reprint.deviceId ? ('FLOOR' as const) : ('OFFICE' as const), at: toUtcIso(reprint.createdAt) })),
        jobs: seesPrints ? jobs.map((job) => ({ jobId: job.id, printerId: job.printerId, scanId: job.scanId, status: job.status, lastError: job.lastError, createdAt: toUtcIso(job.createdAt) })) : null,
        coupons: coupons.map((coupon) => couponView(coupon, operations)),
      },
      asOf: toUtcIso(now),
    }
  })
}
