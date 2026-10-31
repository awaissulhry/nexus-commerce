import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { composeLabel, type LabelInput, type LabelLanguage } from '@nexus/factory-domain/labels/model'
import { labelZpl } from '@nexus/factory-domain/labels/zpl'
import { tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import {
  couponChangeRefusal,
  couponLabel,
  couponScan,
  couponsRefusal,
  couponsToIssue,
  MAX_COUPONS_PER_ISSUE,
  nothingToCoupon,
  type BundleCodeMode,
  type CouponScan,
  type CouponTicket,
} from '@nexus/factory-domain/production/bundles/coupons'
import { PRODUCTION_BUNDLES } from '@nexus/factory-domain/production/bundles/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { PrintJobView } from '../../../platform/print/contract'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { floorRecordSubjectFor } from '../settings/subject'
import { assertFloorReady, bundleWorkOrder, mayBundle, postedBy, refused, ticketBase, ticketPrinter, workerOf, type TicketPrinter } from './bundles'
import { withTicketCodes, type TicketCodes } from './codes'
import { deviceStationOf, lockBundle, readBundle, readBundles, readCellLabels, readHeader, readOperations, readScans, type BundleHeader, type Reader } from './store'
import { standingOf } from './track'

/**
 * Coupons per operation (B-W2b-41; MES-067; design production.settings "Bundle codes", floor.operation): at a site whose
 * bundle code mode is COUPON_PER_OPERATION, each scanned operation of a bundle gets its own coupon (BundleCoupon) with
 * its own code from the tenant's BUNDLE counter (codes.ts; no COUPON number kind exists: the codes are `BN-…` too, so
 * every scanner route reads them). Rules: factory-domain production/bundles/coupons.ts; the …_floor_work_w2b_guards
 * BundleCoupon trigger stays the last word (only ACTIVE → VOID with when and why; a replacement names a VOID coupon of
 * the same bundle and operation; one ACTIVE coupon per bundle and operation).
 *
 *   issue    floor or office (production.bundles): the missing coupons of a work order's ACTIVE bundles (or the ones
 *            named), one ONE command: the bundles locked FOR UPDATE in id order (a void or a reprint of one of them
 *            waits), then the codes, the rows, an audit per bundle and per work order, one event per bundle.
 *   reprint  a lost coupon: the old one VOID with the reason, a new one (new code) replaces it; a scan of the old one is
 *            refused with the new code in the words.
 *   void     a coupon voided with the reason (no new one). A voided bundle's coupons are voided with it (bundles.ts).
 * After the command each new coupon is queued on the label printer as a BUNDLE label (key `bundle-coupon:<id>`), or
 * its label is in the answer for the browser's PDF. A floor issue or reprint waits for the site's floor to be ready.
 * The scans module asks `couponForScan` inside its report command: a coupon reports its own operation (MES-067).
 */

export const COUPON_COLUMNS = { id: true, siteId: true, workOrderId: true, bundleId: true, workOrderOperationId: true, code: true, status: true, voidedAt: true, voidReason: true, replacesId: true, deviceId: true, version: true, createdAt: true } as const
export interface CouponRow {
  readonly id: string
  readonly siteId: string
  readonly workOrderId: string
  readonly bundleId: string
  readonly workOrderOperationId: string
  readonly code: string
  readonly status: 'ACTIVE' | 'VOID'
  readonly voidedAt: Date | null
  readonly voidReason: string | null
  readonly replacesId: string | null
  readonly deviceId: string | null
  readonly version: number
  readonly createdAt: Date
}

/** The site's bundle code mode (ProductionSettings.bundleCodeMode; ONE_CODE where the site has no row). The floor may read it. */
export async function bundleCodeModeFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<BundleCodeMode> {
  return (await db.productionSettings.findUnique({ where: { id: siteId }, select: { bundleCodeMode: true } }))?.bundleCodeMode ?? 'ONE_CODE'
}

/** These bundles' coupons (ACTIVE and VOID), oldest first. */
export async function readCoupons(db: Reader, bundleIds: readonly string[]): Promise<CouponRow[]> {
  if (bundleIds.length === 0) return []
  return db.bundleCoupon.findMany({ where: { bundleId: { in: [...bundleIds] } }, select: COUPON_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

export async function readCoupon(db: Reader, couponId: string): Promise<CouponRow | null> {
  if (!isUuid(couponId)) return null
  return db.bundleCoupon.findUnique({ where: { id: couponId }, select: COUPON_COLUMNS })
}

/** The coupon a scanned code names, as the caller sees it. */
export async function readCouponByCode(db: Reader, code: string): Promise<CouponRow | null> {
  return db.bundleCoupon.findFirst({ where: { code }, select: COUPON_COLUMNS })
}

/** The coupon row locked FOR UPDATE (after its bundle's lock), then read. */
async function lockCoupon(tx: CommandTx, couponId: string): Promise<CouponRow | null> {
  await tx.$queryRaw`SELECT "id" FROM "BundleCoupon" WHERE "id" = ${couponId}::uuid FOR UPDATE`
  return readCoupon(tx, couponId)
}

/** The coupon as the answers show it. */
export function couponView(row: CouponRow, operations: ReadonlyMap<string, { readonly seq: number; readonly code: string; readonly name: string }>) {
  const operation = operations.get(row.workOrderOperationId)
  return {
    id: row.id,
    bundleId: row.bundleId,
    workOrderId: row.workOrderId,
    code: row.code,
    status: row.status,
    operation: { id: row.workOrderOperationId, seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
    voidedAt: row.voidedAt ? toUtcIso(row.voidedAt) : null,
    voidReason: row.voidReason,
    replacesId: row.replacesId,
    postedBy: row.deviceId ? ('FLOOR' as const) : ('OFFICE' as const),
    createdAt: toUtcIso(row.createdAt),
  }
}

const operationMap = async (db: Reader, workOrderId: string) => new Map((await readOperations(db, workOrderId)).map((operation) => [operation.id, operation]))

/** Who a coupon names: on the floor the site's rules (at a station site nobody), in the office the user. */
async function createdByOf(tools: CommandTools, siteId: string): Promise<string | null> {
  const context = tools.context as ReturnType<typeof workerOf>
  if (context.audience !== 'floor') return context.actorId
  const subject = await floorRecordSubjectFor(tools.tx, { siteId, workerId: context.actorId, stationId: await deviceStationOf(tools.tx, context.deviceId) })
  return subject.workerId ? context.actorId : null
}

/** Voids the bundle's ACTIVE coupons inside its void's command (the bundle is locked already); their ids. */
export async function voidCouponsOf(tools: Pick<CommandTools, 'tx' | 'now'>, bundleId: string, reason: string): Promise<string[]> {
  const active = await tools.tx.bundleCoupon.findMany({ where: { bundleId, status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })
  for (const coupon of active) {
    await tools.tx.bundleCoupon.update({ where: { id: coupon.id }, data: { status: 'VOID', voidedAt: tools.now, voidReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  }
  return active.map((coupon) => coupon.id)
}

// ---- printing --------------------------------------------------------------------------------------------------------------

export interface CouponAnswer {
  readonly couponId: string
  readonly code: string
  readonly coupon: CouponTicket
  /** The coupon as a BUNDLE label for the browser's PDF (POST /print/labels/pdf). */
  readonly label: LabelInput
  readonly job: PrintJobView | null
  readonly problem: string | null
}

/** Queues each coupon on the printer after the command (once per coupon); a coupon voided since is never printed. */
async function printCoupons(caller: CommandCaller, target: TicketPrinter, coupons: readonly { readonly couponId: string; readonly coupon: CouponTicket }[]): Promise<CouponAnswer[]> {
  const context = workerOf(caller)
  const tag = tenantTag(context.tenantId)
  const current = new Map((await caller.withClient((client) => client.bundleCoupon.findMany({ where: { id: { in: coupons.map((row) => row.couponId) } }, select: { id: true, status: true } }))).map((row) => [row.id, row.status]))
  const answers: CouponAnswer[] = []
  for (const { couponId, coupon } of coupons) {
    const label = couponLabel(coupon)
    const stale = current.get(couponId) !== 'ACTIVE' ? `Coupon ${coupon.code} is voided: it is not printed.` : null
    if (stale || !target.printer) {
      answers.push({ couponId, code: coupon.code, coupon, label, job: null, problem: stale ?? target.problem })
      continue
    }
    try {
      const job = await queueModuleLabel(
        caller,
        { printerId: target.printer.id, recordType: 'BundleCoupon', recordId: couponId, copies: 1, labelKind: 'BUNDLE', scanId: coupon.code, zplFor: (stock) => labelZpl(composeLabel(label, { tenantTag: tag }), stock, 1) },
        `bundle-coupon:${couponId}`,
      )
      answers.push({ couponId, code: coupon.code, coupon, label, job, problem: null })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      answers.push({ couponId, code: coupon.code, coupon, label, job: null, problem: error.message })
    }
  }
  return answers
}

async function couponTickets(db: Reader, workOrder: BundleHeader, rows: readonly CouponRow[], language: LabelLanguage): Promise<{ couponId: string; coupon: CouponTicket }[]> {
  if (rows.length === 0) return []
  const base = await ticketBase(db, workOrder, language)
  const labels = await readCellLabels(db, workOrder.id)
  const operations = await operationMap(db, workOrder.id)
  const bundles = new Map((await readBundles(db, workOrder.id)).map((bundle) => [bundle.id, bundle]))
  return rows.map((row) => {
    const bundle = bundles.get(row.bundleId)!
    const cell = labels.get(bundle.workOrderSizeId)
    const operation = operations.get(row.workOrderOperationId)
    return {
      couponId: row.id,
      coupon: {
        code: row.code,
        bundleCode: bundle.code,
        operation: { seq: operation?.seq ?? 0, code: operation?.code ?? '', name: operation?.name ?? '' },
        ticket: { language, maker: base.maker, workOrder: base.workOrder, style: base.style, colourway: { code: cell?.colourwayCode ?? '', name: cell?.colourwayName ?? '' }, size: cell?.size ?? '', quantity: bundle.quantity, part: bundle.part },
      },
    }
  })
}

// ---- issue ---------------------------------------------------------------------------------------------------------------

export interface IssueCouponsInput {
  /** The bundles of the work order to print coupons for; absent: every ACTIVE bundle of it. */
  readonly bundleIds?: readonly string[] | undefined
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

async function issueInCommand(tools: CommandTools, workOrderId: string, body: IssueCouponsInput, codes: TicketCodes) {
  const context = tools.context as ReturnType<typeof workerOf>
  const { tx } = tools
  const workOrder = (await readHeader(tx, workOrderId))!
  const all = await readBundles(tx, workOrder.id)
  const asked = body.bundleIds ? [...new Set(body.bundleIds)] : all.filter((bundle) => bundle.status === 'ACTIVE').map((bundle) => bundle.id)
  const unknown = asked.filter((id) => !all.some((bundle) => bundle.id === id))
  if (unknown.length > 0) throw new ValidationError('These are not bundles of this work order.', unknown.map((id) => ({ path: 'body/bundleIds', message: `${id} is not a bundle of work order ${workOrder.number}.` })))
  // The bundles locked in id order: a void, a reprint or another issue of one of them waits for this one.
  for (const id of [...asked].sort()) await lockBundle(tx, id)
  const refusal = couponsRefusal({ mode: await bundleCodeModeFor(tx, workOrder.siteId), workOrder })
  if (refusal) refused(refusal)
  const bundles = (await Promise.all(asked.map((id) => readBundle(tx, id)))).filter((row) => row !== null)
  const operations = await readOperations(tx, workOrder.id)
  const existing = await readCoupons(tx, asked)
  const scans = await readScans(tx, asked)
  const plan = bundles.map((bundle) => ({
    bundle,
    operations: couponsToIssue({ bundle, operations, coupons: existing.filter((coupon) => coupon.bundleId === bundle.id), reportedAt: standingOf(scans.filter((scan) => scan.bundleId === bundle.id)) }),
  }))
  const total = plan.reduce((sum, entry) => sum + entry.operations.length, 0)
  if (total === 0) refused(nothingToCoupon(bundles.length))
  if (total > MAX_COUPONS_PER_ISSUE) throw new ValidationError(`${total} coupons at once is too many (at most ${MAX_COUPONS_PER_ISSUE}): name fewer bundles.`, [{ path: 'body/bundleIds', message: 'Name fewer bundles.' }])
  const createdById = await createdByOf(tools, workOrder.siteId)
  const taken = await codes.take(tx, total)
  const made: CouponRow[] = []
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  for (const entry of plan) {
    if (entry.operations.length === 0) continue
    const rows = entry.operations.map((operation) => ({
      id: newId(),
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      bundleId: entry.bundle.id,
      workOrderOperationId: operation.id,
      code: taken.shift()!,
      deviceId: context.audience === 'floor' ? context.deviceId : null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById,
    }))
    await tx.bundleCoupon.createMany({ data: rows })
    made.push(...(await tx.bundleCoupon.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: COUPON_COLUMNS, orderBy: { createdAt: 'asc' } })))
    tools.audit({ recordType: 'Bundle', recordId: entry.bundle.id, ...scope, after: { coupons: rows.map((row) => ({ id: row.id, code: row.code, operationId: row.workOrderOperationId })) } })
    tools.emit({ type: 'production.bundle_coupons_changed', subject: workOrder.id, ...scope, payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: entry.bundle.id, change: 'ISSUED', couponIds: rows.map((row) => row.id), postedBy: postedBy(context) } })
  }
  tools.audit({ recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { couponsIssued: made.length, bundles: plan.filter((entry) => entry.operations.length > 0).map((entry) => entry.bundle.id) } })
  const views = await operationMap(tx, workOrder.id)
  return { workOrder: { id: workOrder.id, number: workOrder.number }, coupons: made.map((row) => couponView(row, views)), tickets: await couponTickets(tx, workOrder, made, body.language ?? 'it') }
}

/** The missing coupons of a work order's bundles, printed (MES-067). */
export async function issueCoupons(caller: CommandCaller, workOrderId: string, body: IssueCouponsInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  const workOrder = await bundleWorkOrder(caller, workOrderId, PRODUCTION_BUNDLES)
  if (context.audience === 'floor') await assertFloorReady(caller, context, workOrder.siteId)
  const target = await ticketPrinter(caller, workOrder, body.printerId)
  const outcome = await withTicketCodes(caller, (codes) => command(caller, { name: 'production.issueCoupons', idempotencyKey, input: { workOrderId, ...body } }, (tools) => issueInCommand(tools, workOrder.id, body, codes)))
  const { tickets, ...issued } = outcome.result
  return { ...issued, printed: await printCoupons(caller, target, tickets), replayed: outcome.replayed }
}

// ---- reprint and void ------------------------------------------------------------------------------------------------------

async function namedCoupon(caller: CommandCaller, couponId: string): Promise<{ coupon: CouponRow; workOrder: BundleHeader }> {
  const context = workerOf(caller)
  const coupon = await caller.withClient((client) => readCoupon(client, couponId))
  const workOrder = coupon ? await caller.withClient((client) => readHeader(client, coupon.workOrderId)) : null
  if (!coupon || !workOrder || !mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Coupon not found.')
  return { coupon, workOrder }
}

async function changeInCommand(tools: CommandTools, couponId: string, reason: string, reprint: { readonly codes: TicketCodes; readonly language: LabelLanguage } | null) {
  const context = tools.context as ReturnType<typeof workerOf>
  const { tx } = tools
  const named = (await readCoupon(tx, couponId))!
  // The bundle first (as an issue and a bundle's void take it), then the coupon.
  const bundle = (await lockBundle(tx, named.bundleId))!
  const coupon = (await lockCoupon(tx, couponId))!
  const workOrder = (await readHeader(tx, coupon.workOrderId))!
  const refusal = couponChangeRefusal({ coupon, bundle, workOrder, reprint: reprint !== null })
  if (refusal) refused(refusal)
  await tx.bundleCoupon.update({ where: { id: coupon.id }, data: { status: 'VOID', voidedAt: tools.now, voidReason: reason, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  let replacement: CouponRow | null = null
  if (reprint) {
    const [code] = await reprint.codes.take(tx, 1)
    const id = newId()
    await tx.bundleCoupon.create({
      data: { id, siteId: coupon.siteId, workOrderId: coupon.workOrderId, bundleId: coupon.bundleId, workOrderOperationId: coupon.workOrderOperationId, code: code!, replacesId: coupon.id, deviceId: context.audience === 'floor' ? context.deviceId : null, createdAt: tools.now, updatedAt: tools.now, createdById: await createdByOf(tools, coupon.siteId) },
      select: { id: true },
    })
    replacement = (await readCoupon(tx, id))!
  }
  tools.audit({ recordType: 'BundleCoupon', recordId: coupon.id, ...scope, before: { status: coupon.status }, after: { status: 'VOID', code: coupon.code, replacedBy: replacement?.code ?? null }, reason })
  tools.audit({ recordType: 'Bundle', recordId: bundle.id, ...scope, after: { couponId: coupon.id, code: coupon.code, voided: true, replacement: replacement ? { id: replacement.id, code: replacement.code } : null }, reason })
  tools.emit({
    type: 'production.bundle_coupons_changed',
    subject: workOrder.id,
    ...scope,
    payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: bundle.id, change: replacement ? 'REPRINTED' : 'VOIDED', couponIds: replacement ? [coupon.id, replacement.id] : [coupon.id], postedBy: postedBy(context) },
  })
  const operations = await operationMap(tx, workOrder.id)
  return {
    coupon: couponView((await readCoupon(tx, coupon.id))!, operations),
    replacement: replacement ? couponView(replacement, operations) : null,
    tickets: replacement ? await couponTickets(tx, workOrder, [replacement], reprint!.language) : [],
  }
}

/** A lost or damaged coupon printed again with a new code: the old one is VOID and refused when scanned. */
export async function reprintCoupon(caller: CommandCaller, couponId: string, body: { readonly reason: string; readonly printerId?: string | null | undefined; readonly language?: LabelLanguage | undefined }, idempotencyKey?: string) {
  const context = workerOf(caller)
  const { workOrder } = await namedCoupon(caller, couponId)
  if (context.audience === 'floor') await assertFloorReady(caller, context, workOrder.siteId)
  const target = await ticketPrinter(caller, workOrder, body.printerId)
  const reason = body.reason.trim()
  const outcome = await withTicketCodes(caller, (codes) =>
    command(caller, { name: 'production.reprintCoupon', idempotencyKey, input: { couponId, ...body, reason } }, (tools) => changeInCommand(tools, couponId, reason, { codes, language: body.language ?? 'it' })),
  )
  const { tickets, ...changed } = outcome.result
  const [printed] = await printCoupons(caller, target, tickets)
  return { coupon: changed.coupon, replacement: changed.replacement!, printed: printed!, replayed: outcome.replayed }
}

/** A coupon voided with its reason (no new one). */
export async function voidCoupon(caller: CommandCaller, couponId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  await namedCoupon(caller, couponId)
  const reason = body.reason.trim()
  const outcome = await command(caller, { name: 'production.voidCoupon', idempotencyKey, input: { couponId, reason } }, (tools) => changeInCommand(tools, couponId, reason, null))
  return { coupon: outcome.result.coupon, replayed: outcome.replayed }
}

// ---- the scans module's hook ---------------------------------------------------------------------------------------------------

/**
 * For the scans module's report command (modules/production/scans scans.ts), after it locked the bundle: what a scanned
 * code means when it is one of the bundle's coupons (MES-067). Null: the code is not a coupon (the bundle's own ticket,
 * current or replaced: the bundle rules answer). Else the operation the coupon reports, or why it takes nothing (an old
 * coupon with its replacement's code, a voided one, a coupon of another operation than the one named). The coupon row
 * is locked FOR SHARE, so a reprint or void of it waits for the scan (and a scan after a void sees it VOID).
 */
export async function couponForScan(tx: CommandTx, bundleId: string, scanned: string, namedOperationId: string | null): Promise<CouponScan | null> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "BundleCoupon" WHERE "code" = ${scanned} AND "bundleId" = ${bundleId}::uuid FOR SHARE`
  if (!row) return null
  const coupon = (await readCoupon(tx, row.id))!
  const replacement = coupon.status === 'VOID' ? await tx.bundleCoupon.findFirst({ where: { bundleId, workOrderOperationId: coupon.workOrderOperationId, status: 'ACTIVE' }, select: { code: true } }) : null
  const ids = [coupon.workOrderOperationId, ...(namedOperationId && isUuid(namedOperationId) ? [namedOperationId] : [])]
  const operations = new Map((await tx.workOrderOperation.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true, code: true, name: true } })).map((operation) => [operation.id, operation]))
  const named = namedOperationId ? (operations.get(namedOperationId) ?? { id: namedOperationId, seq: 0, code: '', name: 'another operation' }) : null
  return couponScan({ coupon, replacement, operation: operations.get(coupon.workOrderOperationId) ?? null, named })
}
