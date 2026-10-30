import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { LabelLanguage } from '@nexus/factory-domain/labels/model'
import { PRODUCTION_BUNDLES } from '@nexus/factory-domain/production/bundles/permissions'
import { liveGarments, splitRefusal, type SplitReason } from '@nexus/factory-domain/production/bundles/split'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { useScanIds } from '../../../platform/numbering/scan-ids'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { floorRecordSubjectFor } from '../settings/subject'
import { assertFloorReady, bundleView, mayBundle, postedBy, printTickets, refused, ticketBase, ticketOf, ticketPrinter, workerOf } from './bundles'
import { withTicketCodes, type TicketCodes } from './codes'
import { deviceStationOf, lockBundle, lockCells, readBundle, readBundleByClientEvent, readCellLabels, readHeader, type BundleHeader, type BundleRow } from './store'

/**
 * Split a bundle (B-W2a-13; MES-071; design floor.bundles "Split a bundle", production.bundles "Split bundle"): some
 * garments of a bundle go off into a child bundle with its own ticket (rework, a recut, a hold), floor or office,
 * production.bundles. ONE command (the rework's open command calls `splitInCommand` too):
 *
 *   the work order's issue lock (a scan of it takes the same lock shared: no scan crosses a split) → the cell's bundle
 *   lock → the parent row FOR UPDATE → the rules (factory-domain production/bundles/split: an ACTIVE bundle of a RELEASED
 *   or IN_PROGRESS work order; a held one in words; 1 … live − 1 garments) → the next ticket code (the tenant's BUNDLE
 *   counter, or the tablet's own block with a queue event) → the child row (same cell and part, the parent's cut log
 *   entries: genealogy) → audits (child, parent, work order) → production.bundle_split.
 *
 * The parent keeps its quantity as cut (W1 freezes it); its live garments are its quantity less its children's. The
 * scans read both through bundles/flow.ts. The …_production_w2a_guards Bundle_split_check trigger is the last word. The
 * ticket is queued after the commit like a made one (the station's label printer, else the site's only one; or PDF).
 */

export interface SplitInput {
  readonly quantity: number
  readonly reason: SplitReason
  readonly note?: string | undefined
  readonly clientEventId?: string | undefined
  readonly ticketCode?: string | undefined
  readonly printerId?: string | null | undefined
  readonly language?: LabelLanguage | undefined
}

type Worker = FloorContext | OfficeContext

/** The work order's hold reason (the header leaves it out). */
async function holdReasonOf(tools: CommandTools, workOrderId: string): Promise<string | null> {
  return (await tools.tx.workOrder.findUnique({ where: { id: workOrderId }, select: { holdReason: true } }))?.holdReason ?? null
}

/**
 * The split INSIDE a command: the parent is locked and checked here; the caller took the work order's issue lock. Returns
 * the child, the parent (with its live garments) and the child's ticket to print after the commit.
 */
export async function splitInCommand(
  tools: CommandTools,
  args: { readonly parentId: string; readonly quantity: number; readonly reason: SplitReason; readonly note?: string | null | undefined; readonly clientEventId?: string | undefined; readonly ticketCode?: string | undefined; readonly language?: LabelLanguage | undefined; readonly codes: TicketCodes },
) {
  const context = tools.context as Worker
  const { tx } = tools
  const before = await readBundle(tx, args.parentId)
  if (!before) throw new NotFoundError('Bundle not found.')
  await lockCells(tx, context.tenantId, before.siteId, [before.workOrderSizeId])
  const parent = (await lockBundle(tx, args.parentId))!
  const workOrder = (await readHeader(tx, parent.workOrderId))!
  if (!mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Bundle not found.')
  const children = await tx.bundle.findMany({ where: { parentBundleId: parent.id }, select: { quantity: true, status: true } })
  const refusal = splitRefusal({ bundle: parent, workOrder: { number: workOrder.number, status: workOrder.status, holdReason: await holdReasonOf(tools, workOrder.id) }, children, quantity: args.quantity })
  if (refusal) refused(refusal)

  // Who it names: on the floor the site's rules (409 in words; at a station site nobody); in the office the user.
  const createdById =
    context.audience === 'floor'
      ? (await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId: await deviceStationOf(tx, context.deviceId) })).workerId
        ? context.actorId
        : null
      : context.actorId
  const id = newId()
  const [code] =
    args.ticketCode !== undefined ? (await useScanIds(tools, 'BUNDLE', [{ code: args.ticketCode, record: { type: 'Bundle', id } }])).map((use) => use.code) : await args.codes.take(tx, 1)
  await tx.bundle.create({
    data: {
      id,
      siteId: workOrder.siteId,
      workOrderId: workOrder.id,
      workOrderSizeId: parent.workOrderSizeId,
      code: code!,
      quantity: args.quantity,
      part: parent.part,
      cutLogIds: [...parent.cutLogIds],
      parentBundleId: parent.id,
      deviceId: context.audience === 'floor' ? context.deviceId : null,
      clientEventId: args.clientEventId ?? null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById,
    },
    select: { id: true },
  })
  const live = liveGarments(parent.quantity, [...children, { quantity: args.quantity, status: 'ACTIVE' }])
  const note = args.note?.trim() || null
  const scope = { companyId: workOrder.companyId, siteId: workOrder.siteId }
  const reason = note ? `${args.reason}: ${note}` : args.reason
  tools.audit({ recordType: 'Bundle', recordId: id, ...scope, after: { workOrderId: workOrder.id, workOrderSizeId: parent.workOrderSizeId, code, quantity: args.quantity, part: parent.part, parentBundleId: parent.id, cutLogIds: parent.cutLogIds, splitReason: args.reason }, reason })
  tools.audit({ recordType: 'Bundle', recordId: parent.id, ...scope, after: { splitOff: { bundleId: id, code, quantity: args.quantity }, live }, reason })
  tools.audit({ recordType: 'WorkOrder', recordId: workOrder.id, ...scope, after: { bundleSplit: { parentBundleId: parent.id, bundleId: id, code, quantity: args.quantity } }, reason })
  tools.emit({
    type: 'production.bundle_split',
    subject: workOrder.id,
    ...scope,
    payload: { workOrderId: workOrder.id, number: workOrder.number, bundleId: id, parentBundleId: parent.id, code: code!, workOrderSizeId: parent.workOrderSizeId, part: parent.part, quantity: args.quantity, reason: args.reason, postedBy: postedBy(context) },
  })
  const labels = await readCellLabels(tx, workOrder.id)
  const child = (await readBundle(tx, id))!
  const base = await ticketBase(tx, workOrder, args.language ?? 'it')
  return {
    workOrder,
    child,
    parent: { ...bundleView((await readBundle(tx, parent.id))!, labels), live },
    view: bundleView(child, labels),
    ticket: { bundleId: id, ticket: ticketOf(base, child, labels) },
  }
}

/** The bundle a split names, visible to the caller with production.bundles (else not found). */
async function splitTarget(caller: CommandCaller, bundleId: string): Promise<{ bundle: BundleRow; workOrder: BundleHeader }> {
  const context = workerOf(caller)
  const bundle = await caller.withClient((client) => readBundle(client, bundleId))
  const workOrder = bundle ? await caller.withClient((client) => readHeader(client, bundle.workOrderId)) : null
  if (!bundle || !workOrder || !mayBundle(context, PRODUCTION_BUNDLES, workOrder)) throw new NotFoundError('Bundle not found.')
  return { bundle, workOrder }
}

/** A queue event sent again: the child it made, its ticket queued again under the same key (nothing written now). */
async function splitBefore(caller: CommandCaller, workOrder: BundleHeader, parentId: string, body: SplitInput) {
  if (body.clientEventId === undefined) return null
  const clientEventId = body.clientEventId
  const found = await caller.withClient(async (client) => {
    const row = await readBundleByClientEvent(client, clientEventId)
    if (!row) return null
    const labels = await readCellLabels(client, workOrder.id)
    const parent = (await readBundle(client, parentId))!
    const children = await client.bundle.findMany({ where: { parentBundleId: parentId }, select: { quantity: true, status: true } })
    return { row, labels, parent: { ...bundleView(parent, labels), live: liveGarments(parent.quantity, children) }, base: await ticketBase(client, workOrder, body.language ?? 'it') }
  })
  if (!found) return null
  if (found.row.parentBundleId !== parentId) throw new ConflictError(`Client event ${clientEventId} made another bundle (${found.row.code}); send a new client event id for a new split.`)
  const target = await ticketPrinter(caller, workOrder, body.printerId).catch(() => ({ printer: null, problem: 'The ticket was printed with the first send.' }))
  const [ticket] = await printTickets(caller, target, [{ bundleId: found.row.id, ticket: ticketOf(found.base, found.row, found.labels) }])
  return { bundle: bundleView(found.row, found.labels), parent: found.parent, ticket: ticket!, replayed: true }
}

/** POST /production/bundles/:bundleId/split: one command, then the child's ticket. */
export async function splitBundle(caller: CommandCaller, bundleId: string, body: SplitInput, idempotencyKey?: string) {
  const context = workerOf(caller)
  if (body.ticketCode !== undefined && body.clientEventId === undefined) {
    throw new ValidationError('A ticket numbered on the tablet comes with its queue event.', [{ path: 'body/ticketCode', message: 'Send it with the clientEventId of the split it numbers.' }])
  }
  const { workOrder } = await splitTarget(caller, bundleId)
  const before = await splitBefore(caller, workOrder, bundleId, body)
  if (before) return before
  if (context.audience === 'floor') await assertFloorReady(caller, context, workOrder.siteId)
  const target = await ticketPrinter(caller, workOrder, body.printerId)
  const outcome = await withTicketCodes(caller, (codes) =>
    command(caller, { name: 'production.splitBundle', idempotencyKey, input: { bundleId, ...body } }, async (tools) => {
      await lockWorkOrderIssues(tools.tx, context.tenantId, workOrder.id)
      const split = await splitInCommand(tools, { parentId: bundleId, quantity: body.quantity, reason: body.reason, note: body.note, clientEventId: body.clientEventId, ticketCode: body.ticketCode, language: body.language, codes })
      return { bundle: split.view, parent: split.parent, ticket: split.ticket }
    }),
  )
  const { ticket, ...split } = outcome.result
  const [answer] = await printTickets(caller, target, [ticket])
  return { ...split, ticket: answer!, replayed: outcome.replayed }
}
