import type { Uom } from '@nexus/factory-db'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import {
  WRITE_OFF_COMMAND,
  WRITE_OFF_REASON_LIST,
  WRITE_OFF_RECORD,
  writeOffGroupOf,
  writeOffLineProblems,
  writeOffNote,
  writeOffOf,
  writeOffReasonProblem,
} from '@nexus/factory-domain/inventory/ledger/write-off'
import { INVENTORY_SCRAP, INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { availabilityOf } from '@nexus/factory-domain/inventory/reservations/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { completeUpload, listFiles, requestUpload } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { readHides, readItems, readLots, readSiteStock } from '../issue/store'
import { ReservationRefusedError } from '../reservations/reserve'
import { demandWords, lockReservations, readDemands, readKeyFacts, reserveKeyOf, type ReserveKey } from '../reservations/store'
import { mayAt, officeContextOf, seesCost, siteFor } from './access'
import { completeKeys, LEDGER_SELECT, postMoves, type MoveDraft } from './post-moves'

/**
 * Write-off (B-W2a-11; SCM-193; design warehouse.moves › Write off, warehouse.hides › Scrap N hides): stock that is
 * damaged, expired, obsolete or lost leaves the site, with a WRITE_OFF reason code of the tenant (ReasonCode) and the
 * person's note, and afterwards its photos. Office, inventory.scrap at the site. ONE command():
 *
 *   the reason code (active; one that needs detail needs the note) → the lines (a hide whole from every location holding
 *   it; a lot or untracked material by quantity from one location) → the reserve lock of each item and colour (a hide an
 *   ACTIVE reservation holds is refused in words: release it first) → postMoves: SCRAP moves, note `<CODE>: <note>`,
 *   keys `inventory.writeOff:<Idempotency-Key>:<n>`, valued in the command (the lot's cost, else the standard cost) →
 *   each hide SCRAPPED (final: the …_production_leftovers_guards trigger) → the write-off's audit row (record
 *   `StockWriteOff`, id = its first move's) and `inventory.written_off`.
 *
 * The answer says which keys it leaves over-reserved (a quantity a reservation held: the reservation stays, the stock
 * screens show it). Photos: POST /inventory/write-offs/:writeOffId/photos (the upload, PHOTO files of the record
 * `StockWriteOff`, office only), then …/photos/:fileId/complete; inventory.scrap and files.upload over the company.
 * "To the scrap location" in the design has no place kind: a SCRAP move leaves the site's stock (to nobody).
 */

export interface WriteOffLineInput {
  readonly hideId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | null | undefined
  readonly lotId?: string | null | undefined
  readonly fromLocationId?: string | undefined
  readonly quantity?: string | undefined
  readonly uom?: Uom | undefined
  readonly baseQuantity?: string | undefined
}

export interface WriteOffInput {
  readonly siteId: string
  readonly reasonCode: string
  readonly note?: string | null | undefined
  readonly reference?: string | null | undefined
  readonly lines: readonly WriteOffLineInput[]
}

const prefixed = (path: string) => `body/${path}`

/** The reason code of the tenant's WRITE_OFF list, checked. */
async function reasonOf(tools: CommandTools, code: string, note: string | null | undefined) {
  const row = await tools.tx.reasonCode.findFirst({ where: { list: WRITE_OFF_REASON_LIST, code }, select: { code: true, active: true, needsDetail: true, labelEn: true } })
  const problem = writeOffReasonProblem(row, note)
  if (problem) throw new ValidationError(problem.message, [{ path: prefixed(problem.path), message: problem.message }])
  return row!
}

export async function writeOff(caller: CommandCaller, body: WriteOffInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_SCRAP, 'body/siteId')
  const shape = writeOffLineProblems(body.lines)
  if (shape.length > 0) throw new ValidationError(shape[0]!.message, shape.map((issue) => ({ path: prefixed(issue.path), message: issue.message })))
  const withCost = seesCost(context)
  const { result } = await command(caller, { name: 'inventory.writeOff', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const reason = await reasonOf(tools, body.reasonCode, body.note)
    const note = writeOffNote(reason.code, body.note)

    // A hide goes whole, from every location of the site that holds it.
    const hides = await readHides(tx, body.lines.flatMap((line) => (line.hideId && isUuid(line.hideId) ? [line.hideId] : [])))
    // A lot alone names its material.
    const lots = await readLots(tx, body.lines.flatMap((line) => (!line.hideId && !line.itemId && line.lotId && isUuid(line.lotId) ? [line.lotId] : [])))
    const drafts: MoveDraft[] = []
    const lineOf: number[] = []
    for (const [index, line] of body.lines.entries()) {
      if (line.hideId) {
        const hide = hides.get(line.hideId)
        if (!hide || hide.siteId !== site.id) throw new ValidationError('Not a hide of this site.', [{ path: prefixed(`lines/${index}/hideId`), message: 'Not a hide of this site.' }])
        const held = await readSiteStock(tx, site.id, { itemIds: [hide.itemId], hideId: hide.id })
        if (held.length === 0) throw new ConflictError(`Hide ${hide.code} is not in stock at this site (${hide.state}): only stock in a location is written off.`)
        for (const balance of held) {
          drafts.push({ siteId: site.id, reason: 'SCRAP', itemId: hide.itemId, lotId: hide.lotId, hideId: hide.id, fromLocationId: balance.locationId, quantity: quantityText(balance.onHand), note, reference: body.reference ?? null })
          lineOf.push(index)
        }
      } else {
        const itemId = line.itemId ?? (line.lotId ? lots.get(line.lotId)?.itemId : undefined)
        if (!itemId) throw new ValidationError('Name the material.', [{ path: prefixed(`lines/${index}/itemId`), message: 'Name the material, its lot, or a hide.' }])
        drafts.push({
          siteId: site.id,
          reason: 'SCRAP',
          itemId,
          ...(line.itemColourId !== undefined ? { itemColourId: line.itemColourId } : {}),
          ...(line.lotId !== undefined ? { lotId: line.lotId } : {}),
          hideId: null,
          fromLocationId: line.fromLocationId!,
          quantity: line.quantity!,
          ...(line.uom ? { uom: line.uom } : {}),
          ...(line.baseQuantity ? { baseQuantity: line.baseQuantity } : {}),
          note,
          reference: body.reference ?? null,
        })
        lineOf.push(index)
      }
    }

    // The reserve lock of each item and colour, then: a hide an ACTIVE reservation holds is not written off.
    const keyed = await completeKeys(tx, drafts)
    const keys = new Map<string, ReserveKey>(keyed.map((draft) => {
      const key = { siteId: site.id, itemId: draft.itemId, itemColourId: draft.itemColourId }
      return [reserveKeyOf(key), key]
    }))
    await lockReservations(tx, context.tenantId, [...keys.values()])
    const hideIds = [...hides.keys()]
    if (hideIds.length > 0) {
      const holding = await tx.reservation.findMany({ where: { hideId: { in: hideIds }, status: 'ACTIVE' }, select: { id: true, hideId: true, workOrderId: true, salesOrderLineId: true } })
      if (holding.length > 0) {
        const demands = await readDemands(tx, holding, { withOrders: true })
        const issues = holding.map((row) => {
          const index = body.lines.findIndex((line) => line.hideId === row.hideId)
          return { path: prefixed(`lines/${index}/hideId`), message: `Hide ${hides.get(row.hideId!)?.code} is reserved for ${demandWords(row, demands)}: release that reservation first.` }
        })
        throw new ReservationRefusedError(issues.length === 1 ? issues[0]!.message : `${issues.length} hides are reserved: release their reservations first.`, issues)
      }
    }

    const key = `${WRITE_OFF_COMMAND}:${idempotencyKey ?? `g-${newId()}`}`
    const moves = await postMoves(tools, keyed, { key, issuePath: (index) => prefixed(`lines/${lineOf[index]}`) })
    for (const hide of hides.values()) {
      await tx.hide.update({ where: { id: hide.id }, data: { state: 'SCRAPPED', version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'inventory.hideState', recordType: 'Hide', recordId: hide.id, companyId: site.companyId, siteId: site.id, before: { state: hide.state }, after: { state: 'SCRAPPED' }, reason: note })
    }

    // What the write-off leaves over-reserved (the stock screens show it; the reservations stay).
    const overReserved = []
    for (const entry of keys.values()) {
      const facts = await readKeyFacts(tx, entry, { withOrders: true })
      const figures = availabilityOf(facts.stock, facts.reservations)
      if (figures.overReserved) overReserved.push({ itemId: entry.itemId, itemColourId: entry.itemColourId, available: quantityText(figures.available), reserved: quantityText(figures.reserved) })
    }

    const writeOffId = moves[0]!.id
    tools.audit({
      action: 'inventory.writeOff',
      recordType: WRITE_OFF_RECORD,
      recordId: writeOffId,
      companyId: site.companyId,
      siteId: site.id,
      after: { reasonCode: reason.code, moveIds: moves.map((move) => move.id), hideIds, lines: body.lines.length },
      reason: note,
    })
    tools.emit({
      type: 'inventory.written_off',
      subject: writeOffId,
      companyId: site.companyId,
      siteId: site.id,
      payload: {
        writeOffId,
        reasonCode: reason.code,
        moveIds: moves.map((move) => move.id),
        itemIds: [...new Set(moves.map((move) => move.itemId))],
        hideIds,
        lotIds: [...new Set(moves.flatMap((move) => (move.lotId ? [move.lotId] : [])))],
      },
    })
    const values = withCost ? await valuesOf(tools.tx, moves.map((move) => move.id)) : null
    return {
      writeOff: {
        id: writeOffId,
        siteId: site.id,
        reasonCode: reason.code,
        reasonLabel: reason.labelEn,
        note: body.note?.trim() || null,
        reference: body.reference?.trim() || null,
        moves,
        hideIds,
        ...(withCost ? { values: asMoney('cost', values!) } : {}),
      },
      overReserved,
    }
  })
  return result
}

/**
 * The value leaving stock per currency (minor units, positive), from the moves' valuations (a move out of stock is
 * valued negative); `valued` of `moves` have a value.
 */
async function valuesOf(db: Pick<CommandTools['tx'], 'stockValuation'>, moveIds: readonly string[]) {
  const rows = await db.stockValuation.findMany({ where: { moveId: { in: [...moveIds] } }, select: { moveId: true, valueAmount: true, currency: true } })
  const per = new Map<string, number>()
  for (const row of rows) per.set(row.currency, (per.get(row.currency) ?? 0) - row.valueAmount)
  return { valued: rows.length, moves: moveIds.length, byCurrency: [...per.entries()].map(([currency, amount]) => ({ currency, amount: asMoney('cost', amount) })) }
}

// ---- the write-off record and its photos -----------------------------------------------------------------------------------

/** The write-off a caller may see by its id (its first move's), with every move of it. */
async function writeOffMoves(caller: CommandCaller, writeOffId: string, permission: typeof INVENTORY_STOCK_VIEW | typeof INVENTORY_SCRAP) {
  const context = officeContextOf(caller)
  const first = isUuid(writeOffId) ? await caller.withClient((client) => client.stockMove.findUnique({ where: { id: writeOffId }, select: LEDGER_SELECT })) : null
  const group = first ? writeOffGroupOf(first.idempotencyKey) : null
  if (!first || !group || !writeOffOf(first) || !first.idempotencyKey.endsWith(':1') || !mayAt(context, permission, first)) throw new NotFoundError('Write-off not found.')
  const moves = await caller.withClient((client) => client.stockMove.findMany({ where: { siteId: first.siteId, reason: 'SCRAP', idempotencyKey: { startsWith: `${group}:` } }, select: LEDGER_SELECT, orderBy: { id: 'asc' } }))
  return { context, first, moves: moves.filter((move) => writeOffGroupOf(move.idempotencyKey) === group) }
}

/** GET /inventory/write-offs/:writeOffId: its reason, its moves (names, reversals), its photos and (cost grain) its value. */
export async function writeOffRecord(caller: CommandCaller, writeOffId: string) {
  const { context, first, moves } = await writeOffMoves(caller, writeOffId, INVENTORY_STOCK_VIEW)
  const parsed = writeOffOf(first)!
  return caller.withClient(async (client) => {
    const reason = await client.reasonCode.findFirst({ where: { list: WRITE_OFF_REASON_LIST, code: parsed.reasonCode }, select: { labelEn: true, labelIt: true } })
    const items = await readItems(client, [...new Set(moves.map((move) => move.itemId))])
    const hides = await readHides(client, moves.flatMap((move) => (move.hideId ? [move.hideId] : [])))
    const lots = new Map((await client.lot.findMany({ where: { id: { in: moves.flatMap((move) => (move.lotId ? [move.lotId] : [])) } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot]))
    const locations = new Map((await client.location.findMany({ where: { id: { in: moves.flatMap((move) => (move.fromLocationId ? [move.fromLocationId] : [])) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const reversals = new Map((await client.stockMove.findMany({ where: { reversalOfId: { in: moves.map((move) => move.id) } }, select: { id: true, reversalOfId: true } })).map((row) => [row.reversalOfId!, row.id]))
    const user = first.createdById ? await client.user.findUnique({ where: { id: first.createdById }, select: { id: true, displayName: true } }) : null
    const photos = (await listFiles(caller, { recordType: WRITE_OFF_RECORD, recordId: first.id })).filter((file) => file.kind === 'PHOTO')
    const withCost = seesCost(context)
    return {
      writeOff: {
        id: first.id,
        companyId: first.companyId,
        siteId: first.siteId,
        reasonCode: parsed.reasonCode,
        reasonLabel: reason ? { en: reason.labelEn, it: reason.labelIt } : null,
        note: parsed.note,
        reference: first.reference,
        occurredAt: toUtcIso(first.occurredAt),
        createdBy: user ? { id: user.id, name: user.displayName } : null,
        moves: moves.map((move) => ({
          id: move.id,
          item: { id: move.itemId, code: items.get(move.itemId)?.code ?? '', name: items.get(move.itemId)?.name ?? '', baseUom: items.get(move.itemId)?.baseUom ?? move.uom },
          itemColourId: move.itemColourId,
          lot: move.lotId ? (lots.get(move.lotId) ?? null) : null,
          hide: move.hideId ? { id: move.hideId, code: hides.get(move.hideId)?.code ?? '', state: hides.get(move.hideId)?.state ?? 'SCRAPPED' } : null,
          from: move.fromLocationId ? (locations.get(move.fromLocationId) ?? null) : null,
          quantity: move.quantity.toFixed(4),
          uom: move.uom,
          baseQuantity: move.baseQuantity.toFixed(4),
          reversedById: reversals.get(move.id) ?? null,
        })),
        photos: photos.map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, status: file.status, createdAt: file.createdAt })),
        ...(withCost ? { values: asMoney('cost', await valuesOf(client, moves.map((move) => move.id))) } : {}),
      },
    }
  })
}

export interface PhotoUpload {
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
}

/** May the caller add photos to this write-off: inventory.scrap at its site and files.upload over its company. */
async function mayAddPhotos(caller: CommandCaller, writeOffId: string) {
  const { context, first } = await writeOffMoves(caller, writeOffId, INVENTORY_SCRAP)
  if (!can(actorOf(context), FILES_UPLOAD, { companyId: first.companyId, siteId: first.siteId })) throw new ForbiddenError(`Adding a photo needs ${FILES_UPLOAD} over the company.`)
  return first
}

/** POST /inventory/write-offs/:writeOffId/photos: a PHOTO of the write-off (record StockWriteOff), then the presigned PUT. */
export async function announcePhoto(caller: CommandCaller, writeOffId: string, body: PhotoUpload, idempotencyKey?: string) {
  const first = await mayAddPhotos(caller, writeOffId)
  return requestUpload(
    processFiles(),
    caller,
    { companyId: first.companyId, recordType: WRITE_OFF_RECORD, recordId: first.id, kind: 'PHOTO', originalName: body.originalName, contentType: body.contentType, sizeBytes: body.sizeBytes, sha256: body.sha256 },
    idempotencyKey,
    { viaModule: true },
  )
}

/** POST /inventory/write-offs/:writeOffId/photos/:fileId/complete: the store's check → AVAILABLE (or QUARANTINED). */
export async function completePhoto(caller: CommandCaller, writeOffId: string, fileId: string, idempotencyKey?: string) {
  const first = await mayAddPhotos(caller, writeOffId)
  const file = isUuid(fileId) ? await caller.withClient((client) => client.storedFile.findFirst({ where: { id: fileId, recordType: WRITE_OFF_RECORD, recordId: first.id, kind: 'PHOTO' }, select: { id: true } })) : null
  if (!file) throw new NotFoundError('Photo not found.')
  return { file: await completeUpload(processFiles(), caller, fileId, idempotencyKey, { viaModule: true }) }
}

