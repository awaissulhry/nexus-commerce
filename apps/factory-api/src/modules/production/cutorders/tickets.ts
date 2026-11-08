import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { lengthText, type Language, type LengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { floorReadyRefusal } from '@nexus/factory-domain/production/cutting/rules'
import { PRODUCTION_CUT, PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_CUTORDERS_MANAGE } from '@nexus/factory-domain/production/cutorders/permissions'
import { defaultParts } from '@nexus/factory-domain/production/cutorders/plies'
import { ratioText, workOrderRefusal, type CutOrderStatus, type CutTicketKind, type CutTicketStatus, type LayStatus } from '@nexus/factory-domain/production/cutorders/rules'
import { CUT_TICKET_LABEL_KIND, fabricOrderCut, finishRefusal, nextScanOf, scanCodeOf, startRefusal, ticketLines, ticketZpl, type TicketLabel } from '@nexus/factory-domain/production/cutorders/tickets'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { activeHoldsOf } from '../../quality/holds/checks'
import { asTenantSystem } from '../bundles/codes'
import { floorOf, may, officeOf, refuse, workerOf } from './access'
import { emitOrder, emitTicket } from './emit'
import { makeTicket } from './plan'
import { jobKey, labelTarget, queueLabel } from './printing'
import { plyLinesOf, readCutOrder, readLayRolls, readLays, readLines, readPlyRuns, TICKET_COLUMNS, type CutOrderRow, type Reader, type TicketRow } from './store'
import { layRollView, plyRunView, summaryView, ticketView } from './views'

/**
 * Cut tickets at the table and in the office (B-W2b-112; MES-041; design floor.fabriccut "Cut ticket" and "Cut", production.cutting
 * "Print tickets"):
 *
 *   GET  /production/cut-tickets/waiting       the site's tickets to cut (OPEN or STARTED, of released or running cut orders)
 *   GET  /production/cut-tickets/scan?code=    what the cutter starts from: style, colour, sizes and ratio, plies, marker, parts,
 *                                              due; the lay and its rolls; what the next scan does (or why it would stop)
 *   POST /production/cut-tickets/start         the start scan (floor): OPEN → STARTED; the cut order's first start RELEASED →
 *                                              IN_PROGRESS. Refused for a work order on hold, a voided or recut ticket, a cut order
 *                                              back in planning or cancelled, and while the site's floor is not ready (privacy)
 *   POST /production/cut-tickets/finish        the end scan (floor): STARTED → DONE once the lay was counted (CHECKED); the lay CUT;
 *                                              the cut order CUT when every lay is cut or cancelled (a leather one with its ticket)
 *   POST /production/cut-tickets/:id/void      the office voids a lost or wrong ticket with the reason, and makes its replacement
 *   POST /production/cut-tickets/:id/print     the office prints a ticket on a label printer of the site (ZPL, label kind CUT_TICKET)
 *
 * Each write is ONE command (the floor's with its Idempotency-Key), audited, with cut_ticket.changed (and cut_order.changed when
 * the cut order moves). A floor session moves only what the table moves (the database's floor rules); no worker is named.
 */

const SCAN_CARD_WORDS: Readonly<Record<Language, { readonly next: Readonly<Record<'START' | 'FINISH' | 'NONE', string>> }>> = {
  it: { next: { START: 'Scansiona per iniziare il taglio.', FINISH: 'Scansiona di nuovo a taglio finito.', NONE: 'Nessuna scansione da fare.' } },
  en: { next: { START: 'Scan to start cutting.', FINISH: 'Scan again when the cut is done.', NONE: 'Nothing to scan.' } },
}

/** The ticket the caller may see by its code (a floor device: its own site); 404 otherwise. */
async function ticketByCode(db: Reader, context: OfficeContext | FloorContext, code: string): Promise<TicketRow> {
  const scan = scanCodeOf(code)
  const ticket = scan === '' ? null : await db.cutTicket.findFirst({ where: { scanCode: scan }, select: TICKET_COLUMNS })
  if (!ticket || !may(context, PRODUCTION_CUT, ticket)) throw new NotFoundError(`No cut ticket ${scan} at this site.`)
  return ticket
}

/** GET /production/cut-tickets/waiting: the site's CUT tickets OPEN or STARTED of released or running cut orders, oldest first. */
export async function waitingTickets(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = workerOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUT, { company: 'companyId', site: 'siteId' }) as Prisma.CutTicketWhereInput
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  return caller.withClient(async (db) => {
    const tickets = await db.cutTicket.findMany({
      where: { AND: [scope, siteId ? { siteId } : {}, { kind: 'CUT', status: { in: ['OPEN', 'STARTED'] }, cutOrder: { is: { status: { in: ['RELEASED', 'IN_PROGRESS'] } } } }] },
      select: TICKET_COLUMNS,
      orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
      take: 200,
    })
    const orderIds = [...new Set(tickets.map((ticket) => ticket.cutOrderId!))]
    const [orders, lays, lines] = await Promise.all([
      db.cutOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, kind: true, dueDate: true, markerName: true, item: { select: { code: true, name: true } }, itemColour: { select: { code: true, name: true } } } }),
      readLays(db, orderIds),
      readLines(db, orderIds),
    ])
    return {
      tickets: tickets.map((ticket) => {
        const order = orders.find((row) => row.id === ticket.cutOrderId)!
        const lay = lays.find((row) => row.id === ticket.layId) ?? null
        const own = lines.filter((line) => line.cutOrderId === order.id)
        return {
          ...ticketView(ticket, lay?.seq ?? null),
          cutOrder: { id: order.id, number: order.number, kind: order.kind, marker: order.markerName, dueDate: order.dueDate ? order.dueDate.toISOString().slice(0, 10) : null, material: { item: order.item, colour: order.itemColour } },
          lay: lay ? { id: lay.id, seq: lay.seq, plies: lay.plies, status: lay.status } : null,
          ratio: ratioText(own.map((line) => ({ size: line.workOrderSize.size, ratio: line.ratio }))),
          styles: [...new Set(own.map((line) => line.workOrderSize.workOrder.style.code))],
        }
      }),
    }
  })
}

/** The card of a ticket: everything the cutter starts from (see the head of this file). */
async function cardOf(db: Reader, ticket: TicketRow) {
  const order = (await readCutOrder(db, ticket.cutOrderId!))!
  const [lines, lays] = await Promise.all([readLines(db, [order.id]), readLays(db, [order.id])])
  const lay = lays.find((row) => row.id === ticket.layId) ?? null
  const live = lays.filter((row) => row.status !== 'CANCELLED')
  const [layRolls, plyRuns, plyLines] = await Promise.all([readLayRolls(db, lay ? [lay.id] : []), readPlyRuns(db, lay ? [lay.id] : []), order.kind === 'FABRIC' ? plyLinesOf(db, order, lines) : Promise.resolve([])])
  const next = nextScanOf({ number: ticket.number, kind: ticket.kind as CutTicketKind, status: ticket.status as CutTicketStatus, voidReason: ticket.voidReason }, { number: order.number, status: order.status as CutOrderStatus }, lay ? (lay.status as LayStatus) : null, lay?.seq ?? null)
  const summary = summaryView(order, lines, lays, [])
  return {
    ticket: ticketView(ticket, lay?.seq ?? null),
    cutOrder: {
      id: order.id,
      number: order.number,
      kind: summary.kind,
      status: summary.status,
      material: summary.material,
      marker:
        order.markerName !== null && order.markerLength !== null
          ? { name: order.markerName, length: order.markerLength.toFixed(4), uom: order.markerUom as LengthUom, widthCm: order.markerWidthCm?.toFixed(2) ?? null, words: { it: lengthText(order.markerLength.toString(), order.markerUom as LengthUom, 'it'), en: lengthText(order.markerLength.toString(), order.markerUom as LengthUom, 'en') } }
          : null,
      ratio: order.kind === 'FABRIC' ? ratioText(lines.map((line) => ({ size: line.workOrderSize.size, ratio: line.ratio }))) : null,
      plies: summary.plies,
      garments: summary.garments,
      dueDate: summary.dueDate,
      station: summary.station,
      words: summary.words,
    },
    lay: lay ? { id: lay.id, seq: lay.seq, of: live.length, plies: lay.plies, status: lay.status as LayStatus, counted: lay.status === 'CHECKED' || lay.status === 'CUT' ? lay.plyCountLeft : null, version: lay.version, rolls: layRolls.map(layRollView) } : null,
    lines: lines.map((line) => ({ workOrder: { id: line.workOrderId, number: line.workOrderSize.workOrder.number }, style: line.workOrderSize.workOrder.style, colourway: line.workOrderSize.colourway, size: line.workOrderSize.size, ratio: line.ratio, quantity: line.quantity })),
    parts: defaultParts(plyLines),
    plyRuns: plyRuns.map(plyRunView),
    next: { ...next, words: { it: SCAN_CARD_WORDS.it.next[next.next], en: SCAN_CARD_WORDS.en.next[next.next] } },
  }
}

/** GET /production/cut-tickets/scan?code=: the ticket's card (floor: its own site; office: production.cut at the site). */
export async function scanTicket(caller: CommandCaller, code: string) {
  const context = workerOf(caller)
  return caller.withClient(async (db) => {
    const ticket = await ticketByCode(db, context, code)
    if (ticket.kind === 'RECUT' || !ticket.cutOrderId) refuse({ code: 'TICKET_IS_RECUT', message: `Ticket ${ticket.number} is a recut ticket: it is cut from the recut list.` })
    return cardOf(db, ticket)
  })
}

/** The site's floor is ready for real work (platform/privacy, read as the tenant's system caller), or a 409 in the gate's words. */
async function assertFloorReady(caller: CommandCaller, context: FloorContext, siteId: string): Promise<void> {
  const refusal = floorReadyRefusal(await asTenantSystem(caller, context).withClient((client) => floorReadinessFor(client, siteId, serverClock.now())))
  if (refusal) refuse({ code: 'FLOOR_NOT_READY', message: refusal.message })
}

/** A work order of the cut order on hold (its status, or an active quality hold): nothing is cut for it. */
async function holdRefusal(tx: CommandTx, workOrderIds: readonly string[]) {
  const orders = await tx.workOrder.findMany({ where: { id: { in: [...workOrderIds] } }, select: { id: true, number: true, status: true, holdReason: true }, orderBy: { number: 'asc' } })
  for (const order of orders) {
    const refusal = workOrderRefusal(order)
    if (refusal) return refusal
  }
  const holds = await activeHoldsOf(tx, 'WorkOrder', workOrderIds)
  if (holds.length > 0) {
    const held = orders.find((order) => holds.some((hold) => hold.subjectIds.includes(order.id)))
    return { code: 'WORK_ORDER_ON_HOLD' as const, message: `Work order ${held?.number ?? ''} is on hold by quality: nothing is cut for it.` }
  }
  return null
}

async function ticketInCommand(tx: CommandTx, ticketId: string): Promise<TicketRow> {
  return tx.cutTicket.findUniqueOrThrow({ where: { id: ticketId }, select: TICKET_COLUMNS })
}

/**
 * The scans lock the ticket's row (FOR UPDATE) instead of command()'s version bump: a DONE or VOID ticket never changes (the
 * database refuses even its version), so a scan of one is refused in words first; the move itself bumps the version.
 */
async function lockTicket(tx: CommandTx, ticketId: string): Promise<TicketRow> {
  await tx.$queryRaw`SELECT 1 FROM "CutTicket" WHERE id = ${ticketId}::uuid FOR UPDATE`
  return ticketInCommand(tx, ticketId)
}

/** The ticket a floor scan names: at the device's site, a CUT ticket (a recut is B-W2b-117's). */
async function scannedTicket(caller: CommandCaller, code: string) {
  const context = floorOf(caller)
  const ticket = await caller.withClient((db) => ticketByCode(db, context, code))
  if (ticket.kind === 'RECUT' || !ticket.cutOrderId) refuse({ code: 'TICKET_IS_RECUT', message: `Ticket ${ticket.number} is a recut ticket: it is cut from the recut list.` })
  await assertFloorReady(caller, context, ticket.siteId)
  return { context, ticket }
}

/** POST /production/cut-tickets/start: the start scan at the table. */
export async function startTicket(caller: CommandCaller, body: { readonly code: string }, idempotencyKey?: string) {
  const { ticket } = await scannedTicket(caller, body.code)
  const { result, replayed } = await command(caller, { name: 'production.startCutTicket', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockTicket(tx, ticket.id)
    const order = (await readCutOrder(tx, current.cutOrderId!))!
    const refusal = startRefusal({ number: current.number, kind: current.kind as CutTicketKind, status: current.status as CutTicketStatus, voidReason: current.voidReason }, { number: order.number, status: order.status as CutOrderStatus })
    if (refusal) refuse(refusal)
    const workOrderIds = [...new Set((await readLines(tx, [order.id])).map((line) => line.workOrderId))]
    const held = await holdRefusal(tx, workOrderIds)
    if (held) refuse(held)
    await tx.cutTicket.update({ where: { id: current.id }, data: { status: 'STARTED', startedAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const first = order.status === 'RELEASED'
    if (first) await tx.cutOrder.update({ where: { id: order.id }, data: { status: 'IN_PROGRESS', updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const after = (await readCutOrder(tx, order.id))!
    tools.audit({ action: 'production.startCutTicket', recordType: 'CutTicket', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'STARTED', cutOrder: after.number, cutOrderStatus: after.status } })
    emitTicket(tools, after, { ...current, status: 'STARTED' }, 'STARTED', null)
    if (first) emitOrder(tools, after, 'STARTED', workOrderIds)
    return cardOf(tx, await ticketInCommand(tx, current.id))
  })
  return { ...result, replayed }
}

/** POST /production/cut-tickets/finish: the end scan at the table. */
export async function finishTicket(caller: CommandCaller, body: { readonly code: string }, idempotencyKey?: string) {
  const { ticket } = await scannedTicket(caller, body.code)
  const { result, replayed } = await command(caller, { name: 'production.finishCutTicket', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const current = await lockTicket(tx, ticket.id)
    const order = (await readCutOrder(tx, current.cutOrderId!))!
    const lays = await readLays(tx, [order.id])
    const lay = lays.find((row) => row.id === current.layId) ?? null
    const refusal = finishRefusal({ number: current.number, kind: current.kind as CutTicketKind, status: current.status as CutTicketStatus, voidReason: current.voidReason }, lay ? (lay.status as LayStatus) : null, lay?.seq ?? null)
    if (refusal) refuse(refusal)
    await tx.cutTicket.update({ where: { id: current.id }, data: { status: 'DONE', doneAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    if (lay && lay.status === 'CHECKED') await tx.lay.update({ where: { id: lay.id }, data: { status: 'CUT', cutAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const statuses = lays.map((row) => (row.id === lay?.id ? 'CUT' : row.status) as LayStatus)
    const cut = order.status === 'IN_PROGRESS' && (order.kind === 'LEATHER' || fabricOrderCut(statuses))
    if (cut) await tx.cutOrder.update({ where: { id: order.id }, data: { status: 'CUT', cutAt: now, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
    const after = (await readCutOrder(tx, order.id))!
    tools.audit({
      action: 'production.finishCutTicket',
      recordType: 'CutTicket',
      recordId: current.id,
      companyId: current.companyId,
      siteId: current.siteId,
      before: { status: current.status, lay: lay ? lay.status : null },
      after: { status: 'DONE', lay: lay ? 'CUT' : null, cutOrder: after.number, cutOrderStatus: after.status },
    })
    emitTicket(tools, after, { ...current, status: 'DONE' }, 'DONE', null)
    if (cut) emitOrder(tools, after, 'CUT', [...new Set((await readLines(tx, [order.id])).map((line) => line.workOrderId))])
    return cardOf(tx, await ticketInCommand(tx, current.id))
  })
  return { ...result, replayed }
}

/** The ticket of a cut order the office manages (404 / 403). */
async function managedTicket(caller: CommandCaller, ticketId: string): Promise<{ context: OfficeContext; ticket: TicketRow; order: CutOrderRow }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const ticket = isUuid(ticketId) ? await db.cutTicket.findUnique({ where: { id: ticketId }, select: TICKET_COLUMNS }) : null
    const order = ticket?.cutOrderId ? await readCutOrder(db, ticket.cutOrderId) : null
    return { ticket, order }
  })
  if (!found.ticket || !found.order || !may(context, PRODUCTION_CUTTING_VIEW, found.order)) throw new NotFoundError('Cut ticket not found.')
  if (!may(context, PRODUCTION_CUTORDERS_MANAGE, found.order)) throw new ForbiddenError('Tickets are voided and printed with production.cutorders.manage at the site.')
  return { context, ticket: found.ticket, order: found.order }
}

/** POST /production/cut-tickets/:ticketId/void: a lost or wrong ticket voided with the reason; `replace` makes its new ticket. */
export async function voidTicket(caller: CommandCaller, ticketId: string, body: { readonly version: number; readonly reason: string; readonly replace?: boolean | undefined }, idempotencyKey?: string) {
  const { ticket } = await managedTicket(caller, ticketId)
  // A DONE or VOID ticket never changes, not even its version (the database's rule): refused in words before the bump.
  if (ticket.status === 'DONE' || ticket.status === 'VOID') refuse({ code: ticket.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Ticket ${ticket.number} is ${ticket.status.toLowerCase()}: it is not voided.` })
  const { result } = await command(caller, { name: 'production.voidCutTicket', idempotencyKey, input: { ticketId, ...body }, record: { type: 'CutTicket', id: ticketId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await ticketInCommand(tx, ticketId)
    const order = (await readCutOrder(tx, current.cutOrderId!))!
    if (current.status === 'DONE' || current.status === 'VOID') refuse({ code: current.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Ticket ${current.number} is ${current.status.toLowerCase()}: it is not voided.` })
    const reason = body.reason.trim()
    await tx.cutTicket.update({ where: { id: ticketId }, data: { status: 'VOID', voidedAt: now, voidReason: reason, updatedAt: now }, select: { id: true } })
    let replacement: Awaited<ReturnType<typeof makeTicket>> | null = null
    if (body.replace) {
      const lay = current.layId ? (await readLays(tx, [order.id])).find((row) => row.id === current.layId) : null
      if (order.status !== 'PLANNED' && order.status !== 'RELEASED' && order.status !== 'IN_PROGRESS') refuse({ code: 'CUT_ORDER_NOT_RELEASED', message: `Cut order ${order.number} is ${order.status.toLowerCase()}: it takes no new ticket.` })
      if (lay && (lay.status === 'CUT' || lay.status === 'CANCELLED')) refuse({ code: 'TICKET_DONE', message: `Lay ${lay.seq} is ${lay.status.toLowerCase()}: it takes no new ticket.` })
      replacement = await makeTicket(tools, order, current.layId)
    }
    tools.audit({ action: 'production.voidCutTicket', recordType: 'CutTicket', recordId: ticketId, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: 'VOID', replacedBy: replacement?.number ?? null }, reason })
    emitTicket(tools, order, { ...current, status: 'VOID' }, 'VOIDED', replacement?.id ?? null)
    if (replacement) emitTicket(tools, order, replacement, 'MADE', null)
    const tickets = await tx.cutTicket.findMany({ where: { id: { in: [ticketId, ...(replacement ? [replacement.id] : [])] } }, select: TICKET_COLUMNS })
    const laySeq = current.layId ? ((await readLays(tx, [order.id])).find((row) => row.id === current.layId)?.seq ?? null) : null
    return { voided: ticketView(tickets.find((row) => row.id === ticketId)!, laySeq), replacement: replacement ? ticketView(tickets.find((row) => row.id === replacement!.id)!, laySeq) : null }
  })
  return result
}

/** The ticket's label in its language, from the cut order as it is. */
async function labelOf(db: Reader, ticket: TicketRow, order: CutOrderRow, language: Language): Promise<TicketLabel> {
  const [lines, lays, company] = await Promise.all([readLines(db, [order.id]), readLays(db, [order.id]), db.company.findUnique({ where: { id: order.companyId }, select: { legalName: true, tradeName: true } })])
  const live = lays.filter((lay) => lay.status !== 'CANCELLED')
  const lay = live.find((row) => row.id === ticket.layId) ?? null
  const styles = [...new Set(lines.map((line) => line.workOrderSize.workOrder.style.code))]
  const due = order.dueDate ?? lines.map((line) => line.workOrderSize.workOrder.dueDate).filter((value): value is Date => value !== null).sort((left, right) => left.getTime() - right.getTime())[0] ?? null
  return {
    code: ticket.scanCode,
    language,
    maker: company?.tradeName || company?.legalName || null,
    cutOrderNumber: order.number,
    kind: order.kind as 'FABRIC' | 'LEATHER',
    lay: lay ? { seq: lay.seq, of: live.length, plies: lay.plies } : null,
    material: [order.item.code, order.itemColour?.code, order.item.name].filter((part) => part).join(' '),
    marker: order.markerName !== null && order.markerLength !== null ? `${order.markerName} · ${lengthText(order.markerLength.toString(), order.markerUom as LengthUom, language)}` : null,
    ratio: order.kind === 'FABRIC' ? ratioText(lines.map((line) => ({ size: line.workOrderSize.size, ratio: line.ratio }))) : null,
    styles: styles.join(', '),
    workOrders: [...new Set(lines.map((line) => line.workOrderSize.workOrder.number))].join(', '),
    garments: lines.reduce((sum, line) => sum + line.quantity, 0),
    due: due ? due.toISOString().slice(0, 10) : null,
  }
}

export interface PrintBody {
  readonly printerId?: string | null | undefined
  readonly copies?: number | undefined
  readonly language?: Language | undefined
}

/** POST /production/cut-tickets/:ticketId/print: the ticket on a label printer of the site; its print time. */
export async function printTicket(caller: CommandCaller, ticketId: string, body: PrintBody, idempotencyKey?: string) {
  const { context, ticket, order } = await managedTicket(caller, ticketId)
  if (ticket.status === 'DONE' || ticket.status === 'VOID') refuse({ code: ticket.status === 'DONE' ? 'TICKET_DONE' : 'TICKET_VOID', message: `Ticket ${ticket.number} is ${ticket.status.toLowerCase()}: it is not printed again.` })
  const language = body.language ?? 'it'
  const label = await caller.withClient((db) => labelOf(db, ticket, order, language))
  const target = await labelTarget(caller, context, { siteId: order.siteId, stationPrinterId: order.station?.labelPrinterId ?? null }, body.printerId)
  const copies = body.copies ?? 1
  const queued = await queueLabel(caller, target, { recordType: 'CutTicket', recordId: ticket.id, kind: CUT_TICKET_LABEL_KIND, scanId: ticket.scanCode, copies, zplFor: (stock) => ticketZpl(label, stock, copies) }, jobKey('cut-ticket', ticket.id, idempotencyKey))
  const laySeq = ticket.layId ? ((await caller.withClient((db) => readLays(db, [order.id]))).find((row) => row.id === ticket.layId)?.seq ?? null) : null
  let printed = ticketView(ticket, laySeq)
  if (queued.job) {
    const { result } = await command(caller, { name: 'production.printCutTicket', idempotencyKey, input: { ticketId, ...body }, record: { type: 'CutTicket', id: ticket.id } }, async (tools: CommandTools) => {
      const { tx, now } = tools
      await tx.cutTicket.update({ where: { id: ticket.id }, data: { printedAt: now, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'production.printCutTicket', recordType: 'CutTicket', recordId: ticket.id, companyId: ticket.companyId, siteId: ticket.siteId, after: { printedAt: now.toISOString(), jobId: queued.job!.id, copies } })
      emitTicket(tools, order, ticket, 'PRINTED', null)
      return ticketView(await ticketInCommand(tx, ticket.id), laySeq)
    })
    printed = result
  }
  return { ticket: printed, label: ticketLines(label), job: queued.job, problem: queued.problem }
}
