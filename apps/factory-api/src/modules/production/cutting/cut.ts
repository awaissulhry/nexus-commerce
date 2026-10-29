import type { Uom } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import type { HideState } from '@nexus/factory-domain/inventory/issue/rules'
import { quantityText, reversalOf } from '@nexus/factory-domain/inventory/ledger/moves'
import { baseQuantityOf } from '@nexus/factory-domain/inventory/ledger/units'
import { PRODUCTION_CUT, PRODUCTION_CUT_CORRECT } from '@nexus/factory-domain/production/cutting/permissions'
import {
  cellLabel,
  closesHide,
  correctionRefusal,
  cutDecision,
  cuttableRefusal,
  floorReadyRefusal,
  partsOf,
  piecesOf,
  stateAfterReversal,
  undoRefusal,
  type CutCell,
  type CutPiece,
  type CutRefusal,
  type Material,
} from '@nexus/factory-domain/production/cutting/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { systemContext } from '../../../platform/outbox/system'
import { floorReadinessFor } from '../../../platform/privacy/read'
import { issueInCommand, type IssueResult } from '../../inventory/issue/issue'
import { lockHideCuts, lockWorkOrderIssues } from '../../inventory/issue/store'
import { LEDGER_SELECT, postMoves, type PostedMove } from '../../inventory/ledger/post-moves'
import { floorRecordSubjectFor } from '../settings/subject'
import {
  deviceStationOf,
  lastLiveEntryOf,
  latestEntryOf,
  readBundlesOf,
  readCells,
  readCutTotals,
  readElsewhere,
  readEntry,
  readHeader,
  readHideById,
  readHideByCode,
  readHideLedger,
  readItem,
  readLivePieces,
  readLot,
  readPieces,
  readPlannedParts,
  unitsOf,
  type CutHeader,
  type EntryRow,
  type HideRow,
  type ItemRow,
  type LotRow,
  type Reader,
} from './store'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253; PLAN §4.7 stage 11b-cut; A2 SCR-094).
 * Each write is ONE command() on the floor (production.cut, its own site, with an Idempotency-Key) or the office
 * (production.cut.correct), in the lock order of B-W1-39: the work order's issue lock → the hide's cut lock (the
 * …_production_guards trigger's own) → the stock locks (postMoves, sorted; issueInCommand takes the work order's lock
 * again: advisory transaction locks are re-entrant). The rules are factory-domain production/cutting/rules; a refusal is
 * a 409 with its code (`refusal/<CODE>`); the triggers stay the last word.
 *
 *   cut        the floor: a scanned hide (issued to the work order first, in the same command, when it is still in
 *              stock: issueInCommand), the garment sets and parts per cell, the area from the BOM (or typed for single
 *              parts), and with Hide done the rest of the hide: the remnant's RETURN (postMoves, after the entry) or the
 *              hide used up. Offline-safe: a device's client event id is recorded once (the unique key); a resend
 *              under another Idempotency-Key answers the entry already recorded.
 *   undo       the floor: the cutter's own last entry on this device (and the remnant it returned, back to the work
 *              order), by a mirror entry.
 *   correct    the office: a mirror entry of any live entry, with the reason.
 * Before a cut, the site's floor must be ready (platform/privacy floorReadinessFor: a stored DPIA, a published worker
 * notice, and a legal basis on record where the site names workers), read as the tenant's system caller (the floor
 * reads neither the DPIA nor the legal basis); refused in the gate's words (409 FLOOR_NOT_READY).
 * Who an entry names is the site's floor rules' (production/settings subject.ts): the signed-in worker who acknowledged
 * the information notice, or only the device's station; at a station site the entry and its pieces name no creator
 * either (the audit row keeps the actor, office only). Every write records an audit row on the entry, one on the work
 * order (and one on the hide when its state moves) and emits production.cut_logged / hide_closed / cut_reversed.
 */

/** A cut refused by its rule (factory-domain production/cutting/rules): a 409 with the refusal's code in `refusal/<CODE>`. */
export class CutRefusedError extends ConflictError {
  override name = 'CutRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: CutRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

const refused = (refusal: CutRefusal): never => {
  throw new CutRefusedError(refusal)
}
const text = (value: { toString(): string }) => quantityText(value.toString())
const at = (value: Date | null) => (value ? toUtcIso(value) : null)

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

const floorIn = (tools: Pick<CommandTools, 'context'>): FloorContext => floorOf({ factoryContext: tools.context })

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** May the caller work on this work order with the permission? (A floor device: only at its own site.) */
export function mayCut(context: FloorContext | OfficeContext, permission: Permission, workOrder: { readonly companyId: string; readonly siteId: string }): boolean {
  if (context.audience === 'floor' && context.siteId !== workOrder.siteId) return false
  return can(actorOf(context), permission, { companyId: workOrder.companyId, siteId: workOrder.siteId })
}

/** The work order the caller cuts for or reads: one it may reach with the permission (else not found). */
export async function cuttingWorkOrder(caller: CommandCaller, workOrderId: string, permission: Permission): Promise<CutHeader> {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'floor' && context.audience !== 'office')) throw new ForbiddenError()
  const workOrder = await caller.withClient((client) => readHeader(client, workOrderId))
  if (!workOrder || !mayCut(context, permission, workOrder)) throw new NotFoundError('Work order not found.')
  return workOrder
}

// ---- views ------------------------------------------------------------------------------------------------------------------

export function entryView(entry: EntryRow, pieces: readonly CutPiece[]) {
  return {
    id: entry.id,
    workOrderId: entry.workOrderId,
    hideId: entry.hideId,
    lotId: entry.lotId,
    uom: entry.uom,
    areaUsed: text(entry.areaUsed),
    baseAreaUsed: text(entry.baseAreaUsed),
    remnantArea: text(entry.remnantArea),
    baseRemnantArea: text(entry.baseRemnantArea),
    reversalOfId: entry.reversalOfId,
    note: entry.note,
    workerId: entry.workerId,
    stationId: entry.stationId,
    deviceId: entry.deviceId,
    clientEventId: entry.clientEventId,
    deviceTime: at(entry.deviceTime),
    serverTime: toUtcIso(entry.serverTime),
    pieces: pieces.filter((piece) => piece.cutLogId === entry.id).map((piece) => ({ workOrderSizeId: piece.cellId, part: piece.part, pieces: piece.pieces })),
  }
}

/** The cells the cutting table shows after a cut: garments of the hide's material cut and still to cut. */
async function cellsAfter(db: Reader, workOrder: CutHeader, material: Material) {
  const cells = await readCells(db, workOrder.id, workOrder.styleId)
  const planned = await readPlannedParts(db, workOrder.id)
  const pieces = await readLivePieces(db, workOrder.id)
  return cells.flatMap((cell) => {
    const parts = partsOf(planned, cell.id, material)
    if (parts.length === 0) return []
    const cut = piecesOf(pieces, cell.id)
    const sets = Math.min(...parts.map((part) => cut.get(part) ?? 0))
    return [{ workOrderSizeId: cell.id, colourwayCode: cell.colourwayCode, size: cell.size, quantity: cell.quantity, cut: sets, toCut: Math.max(0, cell.quantity - sets) }]
  })
}

// ---- the cut ----------------------------------------------------------------------------------------------------------------

export interface CutLineInput {
  readonly workOrderSizeId: string
  readonly sets?: number | undefined
  readonly parts?: readonly { readonly part: string; readonly pieces: number }[] | undefined
}

export interface AreaInput {
  readonly area: string
  readonly uom?: Uom | undefined
}

export interface CutInput {
  /** The scanned tag, or the hide's id: exactly one. */
  readonly code?: string | undefined
  readonly hideId?: string | undefined
  readonly lines: readonly CutLineInput[]
  /** Single parts without Hide done: the area they used. */
  readonly area?: AreaInput | undefined
  /** Hide done: the remnant set aside (with where it goes), or null (the rest is used: pieces and waste). */
  readonly done?: { readonly remnant: (AreaInput & { readonly toLocationId: string }) | null } | undefined
  /** The device's id for this event (A1 §3.8), unique per device. */
  readonly clientEventId: string
  /** When it happened, by the device's clock. */
  readonly occurredAt?: string | undefined
  readonly note?: string | null | undefined
}

export interface CutResult {
  readonly cut: ReturnType<typeof entryView> | null
  /** The hide was issued to the work order by this cut (it was still in stock). */
  readonly issue: IssueResult['issue'] | null
  /** The remnant's RETURN move (Hide done with a remnant). */
  readonly remnant: PostedMove | null
  readonly hide: { readonly id: string; readonly code: string; readonly state: HideState; readonly left: string; readonly closed: boolean }
  readonly cells: Awaited<ReturnType<typeof cellsAfter>>
  /** True when the device sent this event before (its client event id): the entry recorded then, nothing written now. */
  readonly replayed: boolean
}

/** The hide a request names, at the work order's site (another site's is not found). */
async function resolveHide(db: Reader, body: Pick<CutInput, 'code' | 'hideId'>, siteId: string): Promise<HideRow> {
  const named = [body.code, body.hideId].filter((value) => value !== undefined).length
  if (named !== 1) throw new ValidationError('Name the hide once: its scanned tag or its id.', [{ path: 'body', message: 'Exactly one of code, hideId.' }])
  const hide = body.code !== undefined ? await readHideByCode(db, body.code) : await readHideById(db, body.hideId!)
  if (!hide || hide.siteId !== siteId) throw new ValidationError("Scan the hide's tag: this is not a hide of the work order's site.", [{ path: body.code !== undefined ? 'body/code' : 'body/hideId', message: 'Not a hide of this site.' }])
  return hide
}

/** An area as the item's base unit (leather counts in an area unit; m², dm² and ft² convert by fixed factors). */
function baseAreaOf(item: ItemRow, area: AreaInput, path: string): string {
  const uom = area.uom ?? item.baseUom
  if (!['M2', 'DM2', 'FT2'].includes(uom)) throw new ValidationError('An area is given in m², dm² or ft².', [{ path: `${path}/uom`, message: 'M2, DM2 or FT2.' }])
  const base = baseQuantityOf({ quantity: area.area, uom }, unitsOf(item))
  if (base.problem) throw new ValidationError(base.problem.message, [{ path: `${path}/${base.problem.path}`, message: base.problem.message }])
  return base.baseQuantity
}

const material = (hide: HideRow, lot: LotRow): Material => ({ itemId: hide.itemId, itemColourId: lot.itemColourId })

/** The cut INSIDE a command: the locks, the issue when needed, the rules, the entry, the remnant, the hide's state. */
async function cutInCommand(tools: CommandTools, workOrderId: string, body: CutInput, key: string): Promise<CutResult> {
  const context = floorIn(tools)
  const { tx } = tools
  await lockWorkOrderIssues(tx, context.tenantId, workOrderId)
  const workOrder = await readHeader(tx, workOrderId)
  if (!workOrder || !mayCut(context, PRODUCTION_CUT, workOrder)) throw new NotFoundError('Work order not found.')
  const hide = await resolveHide(tx, body, workOrder.siteId)
  await lockHideCuts(tx, context.tenantId, workOrder.siteId, hide.id)
  const lot = (await readLot(tx, hide.lotId))!
  const item = (await readItem(tx, hide.itemId))!
  const first = cuttableRefusal({ workOrder, hide, lot })
  if (first) refused(first)
  // Who it names: the site's floor rules (409 in words, before anything is issued; the trigger checks the same).
  const subject = await floorRecordSubjectFor(tx, { siteId: workOrder.siteId, workerId: context.actorId, stationId: await deviceStationOf(tx, context.deviceId) })
  const createdById = subject.workerId ? context.actorId : null
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined

  // A hide the work order does not hold yet is issued to it by the scan (whole, from wherever it lies: SCM-215, SCM-194).
  let ledger = (await readHideLedger(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id)!
  let issue: IssueResult['issue'] | null = null
  if (ledger.at.lte(0)) {
    issue = (await issueInCommand(tools, workOrder.id, { hideId: hide.id, ...(body.occurredAt ? { occurredAt: body.occurredAt } : {}) }, `${key}:issue`, 'body')).issue
    ledger = (await readHideLedger(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id)!
  }
  const cut = (await readCutTotals(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id) ?? ZERO

  const leather = material(hide, lot)
  const cells = await readCells(tx, workOrder.id, workOrder.styleId)
  const cellOf = new Map(cells.map((cell) => [cell.id, cell]))
  const planned = await readPlannedParts(tx, workOrder.id)
  const pieces = await readLivePieces(tx, workOrder.id)
  const cutCells = new Map<string, CutCell>()
  for (const [index, line] of body.lines.entries()) {
    const cell = cellOf.get(line.workOrderSizeId)
    if (!cell) throw new ValidationError('This is not a cell of the work order.', [{ path: `body/lines/${index}/workOrderSizeId`, message: 'Not a cell of this work order.' }])
    const need = planned.filter((row) => row.cellId === cell.id && row.itemId === leather.itemId && row.itemColourId === leather.itemColourId).reduce((sum, row) => sum.plus(row.baseQuantity), ZERO)
    cutCells.set(cell.id, { id: cell.id, label: cellLabel(cell.colourwayCode, cell.size), quantity: cell.quantity, parts: partsOf(planned, cell.id, leather), need: need.toFixed(4), cut: piecesOf(pieces, cell.id) })
  }
  const remnantIn = body.done?.remnant ?? null
  const decision = cutDecision({
    workOrder,
    hide,
    lot,
    baseUom: item.baseUom,
    atWorkOrder: ledger.at.toFixed(4),
    cut: cut.toFixed(4),
    cells: cutCells,
    lines: body.lines.map((line) => ({ cellId: line.workOrderSizeId, sets: line.sets, parts: line.parts })),
    area: body.area && !body.done ? baseAreaOf(item, body.area, 'body/area') : null,
    done: body.done ? { remnant: remnantIn ? baseAreaOf(item, remnantIn, 'body/done/remnant') : '0' } : null,
    elsewhere: (await readElsewhere(tx, workOrder.siteId, hide.id, workOrder.id)).toFixed(4),
  })
  if (!decision.ok) return refused(decision.refusal)

  let entry: EntryRow | null = null
  if (decision.entry) {
    const id = newId()
    const area = decision.entry.areaUsed
    const remnant = decision.entry.remnant
    await tx.cutLog.create({
      data: {
        id,
        siteId: workOrder.siteId,
        workOrderId: workOrder.id,
        lotId: hide.lotId,
        hideId: hide.id,
        // In the material's base unit (an area unit): the areas are their base areas.
        uom: item.baseUom,
        areaUsed: area,
        baseAreaUsed: area,
        remnantArea: remnant,
        baseRemnantArea: remnant,
        note: body.note?.trim() || null,
        workerId: subject.workerId,
        stationId: subject.stationId,
        deviceId: context.deviceId,
        clientEventId: body.clientEventId,
        deviceTime: occurredAt ?? null,
        serverTime: tools.now,
        createdById,
      },
      select: { id: true },
    })
    if (decision.entry.pieces.length > 0) {
      await tx.cutLogPiece.createMany({
        data: decision.entry.pieces.map((piece) => ({ id: newId(), siteId: workOrder.siteId, workOrderId: workOrder.id, cutLogId: id, workOrderSizeId: piece.cellId, part: piece.part, pieces: piece.pieces, serverTime: tools.now, createdById })),
      })
    }
    entry = (await readEntry(tx, id))!
    tools.audit({
      action: 'production.cut',
      recordType: 'CutLog',
      recordId: id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      after: { workOrderId: workOrder.id, hideId: hide.id, lotId: hide.lotId, uom: item.baseUom, areaUsed: area, remnantArea: remnant, pattern: decision.entry.pattern, pieces: decision.entry.pieces, workerId: subject.workerId, stationId: subject.stationId, clientEventId: body.clientEventId },
    })
  }

  // The remnant goes back to stock AFTER the entry (the trigger's area check counts it at the work order).
  let remnant: PostedMove | null = null
  if (remnantIn && new Dec(decision.remnant).gt(0)) {
    const posted = await postMoves(
      tools,
      [
        {
          siteId: workOrder.siteId,
          reason: 'RETURN',
          itemId: hide.itemId,
          itemColourId: lot.itemColourId,
          lotId: hide.lotId,
          hideId: hide.id,
          toLocationId: remnantIn.toLocationId,
          quantity: remnantIn.area,
          uom: remnantIn.uom ?? item.baseUom,
          workOrderId: workOrder.id,
          reference: workOrder.number,
          note: `Remnant of hide ${hide.code} after cutting.`,
          ...(occurredAt ? { occurredAt } : {}),
          // Found again by the undo of this entry.
          idempotencyKey: entry ? remnantKey(entry.id) : `${key}:remnant`,
        },
      ],
      { key, issuePath: () => 'body/done/remnant' },
    )
    remnant = posted[0] ?? null
  }
  if (decision.hideState !== hide.state) {
    // A used-up hide names its closing entry: this one, or (Hide done used nothing more) the last cut that took what was
    // left. Reversing that entry, and only that one, opens the hide again (the …_production_leftovers_guards triggers).
    const closingCutLogId = decision.hideState === 'CONSUMED' ? (entry?.id ?? (await lastLiveEntryOf(tx, workOrder.siteId, workOrder.id, hide.id))) : null
    await tx.hide.update({ where: { id: hide.id }, data: { state: decision.hideState, closingCutLogId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'production.hideState',
      recordType: 'Hide',
      recordId: hide.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      before: { state: hide.state },
      after: { state: decision.hideState, ...(closingCutLogId ? { closingCutLogId } : {}) },
    })
  }
  const cellsCut = entry ? cellTotals(decision.entry!.pieces) : []
  tools.audit({
    action: decision.entry ? 'production.cut' : 'production.closeHide',
    recordType: 'WorkOrder',
    recordId: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    after: { cutLogId: entry?.id ?? null, hideId: hide.id, baseAreaUsed: decision.entry?.areaUsed ?? '0.0000', baseRemnantArea: decision.remnant, cells: cellsCut, issueId: issue?.id ?? null, remnantMoveId: remnant?.id ?? null, hideState: decision.hideState, closesHide: decision.closes },
  })
  const event = { subject: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId }
  if (entry) {
    tools.emit({
      ...event,
      type: 'production.cut_logged',
      payload: {
        workOrderId: workOrder.id,
        number: workOrder.number,
        cutLogId: entry.id,
        hideId: hide.id,
        lotId: hide.lotId,
        baseAreaUsed: text(entry.baseAreaUsed),
        baseRemnantArea: text(entry.baseRemnantArea),
        cells: cellsCut,
        issueId: issue?.id ?? null,
        closesHide: decision.closes,
        hideState: decision.hideState,
        postedBy: 'FLOOR',
      },
    })
  }
  if (decision.closes) {
    tools.emit({
      ...event,
      type: 'production.hide_closed',
      payload: { workOrderId: workOrder.id, number: workOrder.number, hideId: hide.id, lotId: hide.lotId, cutLogId: entry?.id ?? null, remnantMoveId: remnant?.id ?? null, baseRemnantArea: decision.remnant, hideState: decision.hideState, postedBy: 'FLOOR' },
    })
  }
  return {
    cut: entry ? entryView(entry, await readPieces(tx, [entry.id])) : null,
    issue,
    remnant,
    hide: { id: hide.id, code: hide.code, state: decision.hideState, left: decision.left, closed: decision.closes },
    cells: await cellsAfter(tx, workOrder, leather),
    replayed: false,
  }
}

const cellTotals = (pieces: readonly { readonly cellId: string; readonly pieces: number }[]) => {
  const totals = new Map<string, number>()
  for (const piece of pieces) totals.set(piece.cellId, (totals.get(piece.cellId) ?? 0) + piece.pieces)
  return [...totals.entries()].map(([workOrderSizeId, count]) => ({ workOrderSizeId, pieces: count }))
}

/** The idempotency key of the remnant's RETURN move of an entry: the undo finds it by it. */
export const remnantKey = (cutLogId: string) => `production.cut.remnant:${cutLogId}`

/** The entry a device recorded under this client event id, as the answer to a resent event. */
async function recordedBefore(caller: CommandCaller, context: FloorContext, workOrderId: string, body: CutInput): Promise<CutResult | null> {
  const found = await caller.withClient(async (client) => {
    const row = await client.cutLog.findFirst({ where: { deviceId: context.deviceId, clientEventId: body.clientEventId }, select: { id: true } })
    if (!row) return null
    const entry = (await readEntry(client, row.id))!
    const workOrder = (await readHeader(client, entry.workOrderId))!
    const hide = (await readHideById(client, entry.hideId))!
    const lot = (await readLot(client, hide.lotId))!
    const ledger = (await readHideLedger(client, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id)!
    const cut = (await readCutTotals(client, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id) ?? ZERO
    return { entry, workOrder, hide, pieces: await readPieces(client, [entry.id]), cells: await cellsAfter(client, workOrder, material(hide, lot)), left: Dec.max(ZERO, ledger.at.minus(cut)) }
  })
  if (!found) return null
  const sameHide = body.hideId !== undefined ? body.hideId === found.hide.id : body.code?.trim() === found.hide.code
  if (found.entry.workOrderId !== workOrderId || !sameHide) {
    throw new ConflictError(`This device recorded client event ${body.clientEventId} for another cut; send a new client event id for a new cut.`)
  }
  return {
    cut: entryView(found.entry, found.pieces),
    issue: null,
    remnant: null,
    hide: { id: found.hide.id, code: found.hide.code, state: found.hide.state, left: text(found.left), closed: found.left.isZero() && (found.hide.state === 'REMNANT' || found.hide.state === 'CONSUMED') },
    cells: found.cells,
    replayed: true,
  }
}

/**
 * The site's floor is ready for real work (B-W1-36, B-W1-37), or a 409 in the gate's words. The gate reads the DPIA and
 * the legal basis, which the floor role may not: it runs in the tenant's system context, on a view of the request
 * (`withClient` follows the view's context, as platform/privacy's public notice does).
 */
async function assertFloorReady(caller: CommandCaller, context: FloorContext, siteId: string): Promise<void> {
  const system = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  system.factoryContext = systemContext(context.tenantId, context.requestId)
  const refusal = floorReadyRefusal(await system.withClient((client) => floorReadinessFor(client, siteId, serverClock.now())))
  if (refusal) refused(refusal)
}

/** The floor's cut (and Hide done): one command, offline-safe by the device's client event id. */
export async function logCut(caller: CommandCaller, workOrderId: string, body: CutInput, idempotencyKey?: string): Promise<CutResult> {
  const context = floorOf(caller)
  const workOrder = await cuttingWorkOrder(caller, workOrderId, PRODUCTION_CUT)
  const before = await recordedBefore(caller, context, workOrderId, body)
  if (before) return before
  await assertFloorReady(caller, context, workOrder.siteId)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt)! : undefined
  try {
    const { result } = await command(
      caller,
      { name: 'production.cut', idempotencyKey, input: { workOrderId, ...body }, ...(occurredAt ? { deviceTime: occurredAt } : {}) },
      (tools) => cutInCommand(tools, workOrderId, body, `production.cut:${idempotencyKey ?? `g-${newId()}`}`),
    )
    return result
  } catch (error) {
    // The same event sent twice at once under two keys: the first one's entry is the answer (the unique key refused the second).
    const raced = await recordedBefore(caller, context, workOrderId, body).catch(() => null)
    if (raced) return raced
    throw error
  }
}

// ---- undo and correction ------------------------------------------------------------------------------------------------------

/** Reverses one entry INSIDE the caller's command: the locks, the checks, the mirror entry, and (undo) its remnant's return. */
async function reverseInCommand(tools: CommandTools, original: EntryRow, options: { readonly undo: boolean; readonly reason: string; readonly key: string }) {
  const context = tools.context as FloorContext | OfficeContext
  const { tx } = tools
  await lockWorkOrderIssues(tx, context.tenantId, original.workOrderId)
  const workOrder = (await readHeader(tx, original.workOrderId))!
  await lockHideCuts(tx, context.tenantId, original.siteId, original.hideId)
  const hide = (await readHideById(tx, original.hideId))!
  const reversed = (await tx.cutLog.count({ where: { reversalOfId: original.id } })) > 0
  const facts = { entry: { id: original.id, reversalOfId: original.reversalOfId, reversed }, workOrder, hide, bundles: await readBundlesOf(tx, original.id) }
  // The closing entry of a used-up hide: its reversal opens the hide again (B-W1-40's gap: a wrong closing cut).
  const reopens = closesHide(facts)
  if (options.undo) {
    const floor = context as FloorContext
    const own = original.deviceId === floor.deviceId && (original.createdById === null || original.createdById === floor.actorId)
    const latest = (await latestEntryOf(tx, original.siteId, floor.deviceId)) === original.id
    const refusal = undoRefusal({ ...facts, own, latest })
    if (refusal) refused(refusal)
  } else {
    const refusal = correctionRefusal(facts)
    if (refusal) refused(refusal)
  }
  // The mirror names who the site's rules name: the cutter undoing their own entry, or the entry's own worker or station.
  const subject =
    context.audience === 'floor'
      ? await floorRecordSubjectFor(tx, { siteId: original.siteId, workerId: context.actorId, stationId: await deviceStationOf(tx, context.deviceId) })
      : await floorRecordSubjectFor(tx, { siteId: original.siteId, workerId: original.workerId, stationId: original.stationId })
  const createdById = context.audience === 'office' ? context.actorId : subject.workerId ? context.actorId : null
  const id = newId()
  await tx.cutLog.create({
    data: {
      id,
      siteId: original.siteId,
      workOrderId: original.workOrderId,
      lotId: original.lotId,
      hideId: original.hideId,
      uom: original.uom,
      areaUsed: original.areaUsed,
      baseAreaUsed: original.baseAreaUsed,
      remnantArea: original.remnantArea,
      baseRemnantArea: original.baseRemnantArea,
      reversalOfId: original.id,
      note: options.reason,
      workerId: subject.workerId,
      stationId: subject.stationId,
      deviceId: context.audience === 'floor' ? context.deviceId : null,
      clientEventId: `${options.undo ? 'undo' : 'correct'}:${original.id}`,
      deviceTime: null,
      serverTime: tools.now,
      createdById,
    },
    select: { id: true },
  })
  // The undo of Hide done takes its remnant back to the work order too (while it is still where it went).
  let remnantReturnReversed = false
  if (options.undo) {
    const move = await tx.stockMove.findFirst({ where: { idempotencyKey: remnantKey(original.id) }, select: LEDGER_SELECT })
    if (move && (await tx.stockMove.count({ where: { reversalOfId: move.id } })) === 0) {
      await postMoves(tools, [{ ...reversalOf({ ...move, quantity: move.quantity.toString(), baseQuantity: move.baseQuantity.toString() }, options.reason), uom: move.uom }], { key: `${options.key}:remnant`, issuePath: () => 'body' })
      remnantReturnReversed = true
    }
  }
  // After the mirror (the Hide trigger opens a used-up hide only once its closing entry is reversed).
  const hideState: HideState = stateAfterReversal({ state: hide.state, reopens, remnantReturnReversed })
  if (hideState !== hide.state) {
    await tx.hide.update({ where: { id: hide.id }, data: { state: hideState, ...(reopens ? { closingCutLogId: null } : {}), version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      action: 'production.hideState',
      recordType: 'Hide',
      recordId: hide.id,
      companyId: workOrder.companyId,
      siteId: workOrder.siteId,
      before: { state: hide.state, ...(reopens ? { closingCutLogId: original.id } : {}) },
      after: { state: hideState },
    })
  }
  const action = options.undo ? 'production.undoCut' : 'production.correctCut'
  tools.audit({ action, recordType: 'CutLog', recordId: id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { reversalOfId: original.id, hideId: original.hideId, baseAreaUsed: text(original.baseAreaUsed), remnantReturnReversed }, reason: options.reason })
  tools.audit({ action, recordType: 'WorkOrder', recordId: workOrder.id, companyId: workOrder.companyId, siteId: workOrder.siteId, after: { cutLogId: id, reversedId: original.id, hideId: original.hideId }, reason: options.reason })
  tools.emit({
    type: 'production.cut_reversed',
    subject: workOrder.id,
    companyId: workOrder.companyId,
    siteId: workOrder.siteId,
    payload: {
      workOrderId: workOrder.id,
      number: workOrder.number,
      cutLogId: id,
      reversedId: original.id,
      undo: options.undo,
      hideId: original.hideId,
      baseAreaUsed: text(original.baseAreaUsed),
      remnantReturnReversed,
      hideState,
      postedBy: context.audience === 'floor' ? 'FLOOR' : 'OFFICE',
    },
  })
  const lot = (await readLot(tx, original.lotId))!
  const ledger = (await readHideLedger(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id)!
  const left = Dec.max(ZERO, ledger.at.minus((await readCutTotals(tx, workOrder.siteId, workOrder.id, [hide.id])).get(hide.id) ?? ZERO))
  return {
    reversal: entryView((await readEntry(tx, id))!, []),
    reversedId: original.id,
    remnantReturnReversed,
    hide: { id: hide.id, code: hide.code, state: hideState, left: text(left), closed: false },
    cells: await cellsAfter(tx, workOrder, material(hide, lot)),
  }
}

const UNDO_NOTE = 'Undone by the cutter before the next cut (logged by mistake).'

/** The entry a reversal names, visible to the caller with the permission (else not found). */
async function namedEntry(caller: CommandCaller, cutLogId: string, permission: Permission): Promise<EntryRow> {
  const entry = await caller.withClient((client) => readEntry(client, cutLogId))
  if (!entry) throw new NotFoundError('Cut log entry not found.')
  await cuttingWorkOrder(caller, entry.workOrderId, permission)
  return entry
}

/** The cutter's own last entry on this device, undone before the next one. */
export async function undoCut(caller: CommandCaller, cutLogId: string, idempotencyKey?: string) {
  floorOf(caller)
  const entry = await namedEntry(caller, cutLogId, PRODUCTION_CUT)
  const { result } = await command(caller, { name: 'production.undoCut', idempotencyKey, input: { cutLogId } }, (tools) =>
    reverseInCommand(tools, entry, { undo: true, reason: UNDO_NOTE, key: `production.undoCut:${idempotencyKey ?? `g-${newId()}`}` }),
  )
  return result
}

/** The office's correction of any live entry: a mirror entry, with the reason. */
export async function correctCut(caller: CommandCaller, cutLogId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  officeOf(caller)
  const entry = await namedEntry(caller, cutLogId, PRODUCTION_CUT_CORRECT)
  const reason = body.reason.trim()
  const { result } = await command(caller, { name: 'production.correctCut', idempotencyKey, input: { cutLogId, reason } }, (tools) =>
    reverseInCommand(tools, entry, { undo: false, reason: `Corrected by the office: ${reason}`, key: `production.correctCut:${idempotencyKey ?? `g-${newId()}`}` }),
  )
  return result
}
