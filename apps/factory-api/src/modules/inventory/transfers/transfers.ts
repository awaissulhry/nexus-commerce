import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { AddLineBody, CancelBody, CreateBody, ListQuery, OptionSite, StockList, TransferList, TransferOptions, TransferView, UpdateBody, UpdateLineBody } from '@nexus/factory-domain/inventory/transfers/contracts'
import { INVENTORY_TRANSFERS_MANAGE } from '@nexus/factory-domain/inventory/transfers/permissions'
import {
  draftProblems,
  IN_TRANSIT_STATUSES,
  isOpenTransfer,
  lineProblems,
  openDifference,
  problem,
  quantityOut,
  TRANSFER_DDT_REASONS,
  TRANSFER_LIMITS,
  TRANSFER_TRANSPORT,
  typedQuantity,
  type ItemTracking,
  type TransferProblem,
  type TransferStatus,
} from '@nexus/factory-domain/inventory/transfers/rules'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { officeContextOf } from '../ledger/access'
import {
  balancesAt,
  dayOf,
  decOf,
  invalid,
  keyText,
  LINE_SELECT,
  managesFrom,
  managesTo,
  mayAt,
  mustManage,
  recordView,
  refuse,
  rowView,
  TRANSFER_SELECT,
  today,
  toDay,
  visibleSites,
  visibleTransfer,
  type Reader,
  type TransferRowData,
} from './store'

/**
 * Transfers between sites, the draft and the reads (B-W2b-326; SCM-219; design warehouse.transfers): the list with its
 * tiles, one transfer, what the New transfer dialog offers, the stock picker of a draft's lines, and the draft's commands
 * (create, edit, lines added, changed and removed, cancel). The ship and the receipt are ship.ts and receive.ts. Every write
 * is ONE command() on the transfer's version (a line's own version for a line's cell); the database's guards hold the same
 * rules as the last word (factory-db warehouse-depth guards). Office only.
 */

export function transferChanged(
  tools: Pick<CommandTools, 'emit'>,
  row: Pick<TransferRowData, 'id' | 'number' | 'companyId' | 'fromSiteId' | 'toSiteId' | 'toCompanyId'>,
  change: 'CREATED' | 'EDITED' | 'LINES' | 'SHIPPED' | 'RECEIVED' | 'SETTLED' | 'PRINTED' | 'CANCELLED',
  status: TransferStatus,
  previousStatus: TransferStatus | null,
  extra: { readonly ddtNumber?: string | null; readonly lineId?: string | null; readonly resolution?: 'ADJUSTMENT' | 'CARRIER_CLAIM' | 'SENT_BACK' | null } = {},
): void {
  tools.emit({
    type: 'inventory.transfer_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.fromSiteId,
    payload: {
      transferId: row.id,
      number: row.number,
      change,
      status,
      previousStatus,
      fromSiteId: row.fromSiteId,
      toSiteId: row.toSiteId,
      toCompanyId: row.toCompanyId,
      ddtNumber: extra.ddtNumber ?? null,
      lineId: extra.lineId ?? null,
      resolution: extra.resolution ?? null,
    },
  })
}

/** The record as the caller sees it now. */
export async function transferRecord(caller: CommandCaller, transferId: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => recordView(client, context, await visibleTransfer(client, context, transferId)))
}

// ---- the list -----------------------------------------------------------------------------------------------------------

const LIST_LINES = { select: { shippedQuantity: true, receivedQuantity: true, differenceReasonCode: true, resolvedAt: true } } as const

/** The transfers the caller sees (either end), newest first, with the tiles' counts over all of them. */
export async function listTransfers(caller: CommandCaller, query: ListQuery): Promise<TransferList> {
  const context = officeContextOf(caller)
  const day = today()
  return caller.withClient(async (client) => {
    const sites = (await visibleSites(client, context)).map((site) => site.id)
    const scope: Prisma.TransferOrderWhereInput = { OR: [{ fromSiteId: { in: sites } }, { toSiteId: { in: sites } }] }
    // Differences waiting to be settled: candidates by their lines, then the figures (a reason, not settled, short).
    const candidates = await client.transferOrder.findMany({
      where: { AND: [scope, { lines: { some: { differenceReasonCode: { not: null }, resolvedAt: null } } }] },
      select: { id: true, lines: LIST_LINES },
    })
    const withDifferences = candidates.filter((row) => row.lines.some((line) => openDifference({ shippedQuantity: line.shippedQuantity?.toString() ?? null, receivedQuantity: line.receivedQuantity.toString(), inTransit: '0', differenceReasonCode: line.differenceReasonCode, resolvedAt: line.resolvedAt ? toUtcIso(line.resolvedAt) : null }))).map((row) => row.id)
    const inTransit: Prisma.TransferOrderWhereInput = { status: { in: [...IN_TRANSIT_STATUSES] } }
    const arriving: Prisma.TransferOrderWhereInput = { status: { in: [...IN_TRANSIT_STATUSES] }, expectedOn: toDay(day) }
    const counts = {
      IN_TRANSIT: await client.transferOrder.count({ where: { AND: [scope, inTransit] } }),
      ARRIVING_TODAY: await client.transferOrder.count({ where: { AND: [scope, arriving] } }),
      WITH_DIFFERENCES: withDifferences.length,
      ALL: await client.transferOrder.count({ where: scope }),
    }
    const q = query.q?.trim()
    const where: Prisma.TransferOrderWhereInput = {
      AND: [
        scope,
        query.tile === 'IN_TRANSIT' ? inTransit : query.tile === 'ARRIVING_TODAY' ? arriving : query.tile === 'WITH_DIFFERENCES' ? { id: { in: withDifferences } } : {},
        query.status ? { status: query.status } : {},
        query.fromSiteId ? { fromSiteId: query.fromSiteId } : {},
        query.toSiteId ? { toSiteId: query.toSiteId } : {},
        q
          ? {
              OR: [
                { number: { contains: q, mode: 'insensitive' } },
                { ddtNumber: { contains: q, mode: 'insensitive' } },
                { fromSite: { code: { contains: q, mode: 'insensitive' } } },
                { toSite: { code: { contains: q, mode: 'insensitive' } } },
                { lines: { some: { OR: [{ item: { code: { contains: q, mode: 'insensitive' } } }, { lot: { code: { contains: q, mode: 'insensitive' } } }, { hide: { code: { contains: q, mode: 'insensitive' } } }] } } },
              ],
            }
          : {},
      ],
    }
    const limit = query.limit ?? TRANSFER_LIMITS.list
    const rows = await client.transferOrder.findMany({ where, select: { ...TRANSFER_SELECT, lines: LIST_LINES }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    return {
      rows: rows.slice(0, limit).map((row) => rowView(row, row.lines, day)),
      counts,
      complete: rows.length <= limit,
      today: day,
    }
  })
}

// ---- what New transfer offers -------------------------------------------------------------------------------------------

/** The sites the caller may send from or receive at (and every active site of the tenant as a destination), their places. */
export async function transferOptions(caller: CommandCaller): Promise<TransferOptions> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      select: { id: true, code: true, name: true, status: true, companyId: true, company: { select: { legalName: true, tradeName: true } } },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    })
    const places = await client.location.findMany({
      where: { siteId: { in: sites.map((site) => site.id) }, status: 'ACTIVE' },
      select: { id: true, siteId: true, code: true, name: true, kind: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    })
    const options: OptionSite[] = sites.map((site) => {
      const scope = { companyId: site.companyId, siteId: site.id }
      const own = places.filter((place) => place.siteId === site.id)
      const send = mayAt(context, INVENTORY_TRANSFERS_MANAGE, scope)
      return {
        id: site.id,
        code: site.code,
        name: site.name,
        companyId: site.companyId,
        companyName: site.company.tradeName ?? site.company.legalName,
        active: site.status === 'ACTIVE',
        send,
        receive: send,
        transitPlaces: own.filter((place) => place.kind === 'TRANSIT').map(({ id, code, name }) => ({ id, code, name })),
        places: own.filter((place) => place.kind !== 'TRANSIT').map(({ id, code, name }) => ({ id, code, name })),
      }
    })
    return { sites: options, ddtReasons: [...TRANSFER_DDT_REASONS], transport: [...TRANSFER_TRANSPORT] }
  })
}

// ---- the stock picker ------------------------------------------------------------------------------------------------------

const PICKER_ROWS = 300

/** What the sending site holds (not on its transit places), less what this draft's lines take already. */
export async function transferStock(caller: CommandCaller, transferId: string, query: { readonly locationId?: string | undefined; readonly q?: string | undefined }): Promise<StockList> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    if (!mayAt(context, INVENTORY_STOCK_VIEW, { companyId: row.companyId, siteId: row.fromSiteId })) throw new NotFoundError('Transfer not found.')
    const q = query.q?.trim()
    const matches: Prisma.StockMoveWhereInput = q
      ? { OR: [{ item: { code: { contains: q, mode: 'insensitive' } } }, { item: { name: { contains: q, mode: 'insensitive' } } }, { lot: { code: { contains: q, mode: 'insensitive' } } }, { hide: { code: { contains: q, mode: 'insensitive' } } }] }
      : {}
    const balances = await balancesAt(client, row.fromSiteId, query.locationId ? { AND: [matches, { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] }] } : matches)
    const lines = await client.transferLine.findMany({ where: { transferId: row.id }, select: { itemId: true, itemColourId: true, lotId: true, hideId: true, fromLocationId: true, baseQuantity: true } })
    const onLines = new Map<string, Decimal>()
    for (const line of lines) {
      const place = line.fromLocationId ?? row.fromLocationId
      if (!place) continue
      const key = keyText({ locationId: place, itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })
      onLines.set(key, (onLines.get(key) ?? ZERO).plus(decOf(line.baseQuantity)))
    }
    const entries = [...balances.entries()].filter(([, quantity]) => quantity.greaterThan(ZERO)).map(([key, quantity]) => {
      const [locationId, itemId, colour, lot, hide] = key.split('|') as [string, string, string, string, string]
      return { key, locationId, itemId, itemColourId: colour === '-' ? null : colour, lotId: lot === '-' ? null : lot, hideId: hide === '-' ? null : hide, quantity }
    })
    const placeRows = await client.location.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.locationId))] } }, select: { id: true, code: true, name: true, kind: true, status: true } })
    const placeOf = new Map(placeRows.map((place) => [place.id, place]))
    const shown = entries.filter((entry) => {
      const place = placeOf.get(entry.locationId)
      return place && place.kind !== 'TRANSIT' && place.status === 'ACTIVE' && (!query.locationId || entry.locationId === query.locationId)
    })
    const items = await client.item.findMany({ where: { id: { in: [...new Set(shown.map((entry) => entry.itemId))] } }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } })
    const colours = await client.itemColour.findMany({ where: { id: { in: shown.flatMap((entry) => (entry.itemColourId ? [entry.itemColourId] : [])) } }, select: { id: true, code: true, name: true } })
    const lots = await client.lot.findMany({ where: { id: { in: shown.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])) } }, select: { id: true, code: true, qualityStatus: true } })
    const hides = await client.hide.findMany({ where: { id: { in: shown.flatMap((entry) => (entry.hideId ? [entry.hideId] : [])) } }, select: { id: true, code: true } })
    const by = <Row extends { id: string }>(rows: readonly Row[]) => new Map(rows.map((one) => [one.id, one]))
    const itemOf = by(items)
    const colourOf = by(colours)
    const lotOf = by(lots)
    const hideOf = by(hides)
    const sorted = shown
      .map((entry) => ({ entry, item: itemOf.get(entry.itemId)!, place: placeOf.get(entry.locationId)! }))
      .sort((a, b) => a.item.code.localeCompare(b.item.code) || a.place.code.localeCompare(b.place.code) || a.entry.key.localeCompare(b.entry.key))
    return {
      rows: sorted.slice(0, PICKER_ROWS).map(({ entry, item, place }) => {
        const taken = onLines.get(entry.key) ?? ZERO
        const lot = entry.lotId ? lotOf.get(entry.lotId) : undefined
        return {
          location: { id: place.id, code: place.code, name: place.name },
          item: { id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking },
          colour: entry.itemColourId ? (colourOf.get(entry.itemColourId) ?? null) : null,
          lot: lot ? { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus } : null,
          hide: entry.hideId ? (hideOf.get(entry.hideId) ?? null) : null,
          onHand: quantityOut(entry.quantity),
          onLines: quantityOut(taken),
          available: quantityOut(Dec.max(ZERO, entry.quantity.minus(taken))),
          refusal: lot && (lot.qualityStatus === 'BLOCKED' || lot.qualityStatus === 'REJECTED') ? 'LOT_NOT_SENT' : null,
        }
      }),
      truncated: sorted.length > PICKER_ROWS,
    }
  })
}

// ---- the draft ------------------------------------------------------------------------------------------------------------

/** A place of a site, active and not a transit place (when named). */
async function usablePlace(client: Reader, siteId: string, locationId: string | null | undefined, path: string): Promise<string | null> {
  if (!locationId) return null
  const place = await client.location.findUnique({ where: { id: locationId }, select: { siteId: true, kind: true, status: true } })
  if (!place || place.siteId !== siteId) throw new ValidationError('The place is not one of the site.', [{ path: `body/${path}`, message: 'Not a place of this site.' }])
  if (place.kind === 'TRANSIT' || place.status !== 'ACTIVE') refuse([problem('PLACE_NOT_USABLE')])
  return locationId
}

/** The transit place: the one named (a TRANSIT place of the sending site, active), else the site's only one. */
async function transitPlace(client: Reader, siteId: string, toSiteCode: string, named: string | undefined): Promise<string> {
  const transit = await client.location.findMany({ where: { siteId, kind: 'TRANSIT', status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  if (named) {
    if (!transit.some((place) => place.id === named)) refuse([problem('NOT_A_TRANSIT_PLACE')])
    return named
  }
  if (transit.length === 0) refuse([problem('NO_TRANSIT_PLACE')])
  if (transit.length === 1) return transit[0]!.id
  // One per route: the one that names the receiving site, else ask.
  const route = transit.filter((place) => place.code.toUpperCase().includes(toSiteCode.toUpperCase()))
  if (route.length === 1) return route[0]!.id
  throw new ValidationError('The sending site has several transit places: name the one these goods travel on.', [{ path: 'body/transitLocationId', message: `Name one of ${transit.map((place) => place.code).join(', ')}.` }])
}

/** A number from the sending company's series, or why there is none (409 in words). */
async function numberOf(tools: CommandTools, companyId: string, kind: 'TRANSFER' | 'DDT', record: { readonly type: string; readonly id: string; readonly date: string }) {
  try {
    return await allocateNumber(tools, { companyId, kind }, record)
  } catch (error) {
    if (error instanceof NotFoundError) refuse([problem(kind === 'TRANSFER' ? 'NO_TRANSFER_SERIES' : 'NO_DDT_SERIES', `${problem(kind === 'TRANSFER' ? 'NO_TRANSFER_SERIES' : 'NO_DDT_SERIES').message} (${error.message})`)])
    throw error
  }
}
export { numberOf as transferNumberOf }

/** inventory.transfers.manage at the sending site: a draft from one site to another (or another company's site). */
export async function createTransfer(caller: CommandCaller, body: CreateBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const facts = await caller.withClient(async (client) => {
    const from = await client.site.findUnique({ where: { id: body.fromSiteId }, select: { id: true, companyId: true, code: true, status: true } })
    const to = await client.site.findUnique({ where: { id: body.toSiteId }, select: { id: true, companyId: true, code: true, status: true } })
    if (!from || !mayAt(context, INVENTORY_STOCK_VIEW, { companyId: from.companyId, siteId: from.id })) throw new NotFoundError('Site not found.')
    if (!to) throw new NotFoundError('The receiving site was not found.')
    mustManage(context, { companyId: from.companyId, fromSiteId: from.id, toCompanyId: to.companyId, toSiteId: to.id }, 'from')
    const first = draftProblems({ fromSiteId: from.id, toSiteId: to.id, fromActive: from.status === 'ACTIVE', toActive: to.status === 'ACTIVE', shipOn: body.shipOn ?? null, expectedOn: body.expectedOn ?? null })
    refuse(first.refusals)
    invalid(first.fields)
    const transitLocationId = await transitPlace(client, from.id, to.code, body.transitLocationId)
    const fromLocationId = await usablePlace(client, from.id, body.fromLocationId, 'fromLocationId')
    const toLocationId = await usablePlace(client, to.id, body.toLocationId, 'toLocationId')
    return { from, to, transitLocationId, fromLocationId, toLocationId }
  })
  const id = newId()
  await command(caller, { name: 'inventory.transfers.create', idempotencyKey, input: body }, async (tools) => {
    const number = await numberOf(tools, facts.from.companyId, 'TRANSFER', { type: 'TransferOrder', id, date: today(tools.now) })
    const row = await tools.tx.transferOrder.create({
      data: {
        id,
        companyId: facts.from.companyId,
        number: number.formatted,
        fromSiteId: facts.from.id,
        fromLocationId: facts.fromLocationId,
        toCompanyId: facts.to.companyId,
        toSiteId: facts.to.id,
        toLocationId: facts.toLocationId,
        transitLocationId: facts.transitLocationId,
        shipOn: body.shipOn ? toDay(body.shipOn) : null,
        expectedOn: body.expectedOn ? toDay(body.expectedOn) : null,
        note: body.note?.trim() || null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true, number: true, companyId: true, fromSiteId: true, toSiteId: true, toCompanyId: true },
    })
    tools.audit({
      recordType: 'TransferOrder',
      recordId: id,
      companyId: row.companyId,
      siteId: row.fromSiteId,
      after: { number: row.number, fromSiteId: row.fromSiteId, toCompanyId: row.toCompanyId, toSiteId: row.toSiteId, transitLocationId: facts.transitLocationId, fromLocationId: facts.fromLocationId, toLocationId: facts.toLocationId, shipOn: body.shipOn ?? null, expectedOn: body.expectedOn ?? null },
    })
    transferChanged(tools, row, 'CREATED', 'DRAFT', null)
    return { id }
  })
  return transferRecord(caller, id)
}

/** Its header: while a draft every field (the sender); once it left the expected day, the receiving place, the tracking and the note (either end); closed: the note. */
export async function updateTransfer(caller: CommandCaller, transferId: string, body: UpdateBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const before = await caller.withClient((client) => visibleTransfer(client, context, transferId))
  const status = before.status as TransferStatus
  const draft = status === 'DRAFT'
  if (draft) mustManage(context, before, 'from')
  else if (!managesFrom(context, before) && !managesTo(context, before)) mustManage(context, before, 'from')
  const draftOnly = (['transitLocationId', 'fromLocationId', 'shipOn'] as const).filter((field) => body[field] !== undefined)
  const openOnly = (['expectedOn', 'toLocationId', 'trackingRef', 'trackingUrl'] as const).filter((field) => body[field] !== undefined)
  if (!draft && draftOnly.length > 0) refuse([problem('NOT_DRAFT', `Once it left, ${draftOnly.join(', ')} never change.`)])
  if (!isOpenTransfer(status) && openOnly.length > 0) refuse([problem('NOT_IN_TRANSIT', `The transfer is ${status}: only its note changes.`)])
  const checked = await caller.withClient(async (client) => {
    const toSite = await client.site.findUnique({ where: { id: before.toSiteId }, select: { code: true } })
    return {
      transitLocationId: body.transitLocationId !== undefined ? await transitPlace(client, before.fromSiteId, toSite?.code ?? '', body.transitLocationId) : undefined,
      fromLocationId: body.fromLocationId !== undefined ? await usablePlace(client, before.fromSiteId, body.fromLocationId, 'fromLocationId') : undefined,
      toLocationId: body.toLocationId !== undefined ? await usablePlace(client, before.toSiteId, body.toLocationId, 'toLocationId') : undefined,
    }
  })
  const shipOn = body.shipOn !== undefined ? body.shipOn : dayOf(before.shipOn)
  const expectedOn = body.expectedOn !== undefined ? body.expectedOn : dayOf(before.expectedOn)
  if (shipOn && expectedOn && expectedOn < shipOn) invalid([{ path: 'expectedOn', message: 'It is expected not before it leaves.' }])
  await command(caller, { name: 'inventory.transfers.edit', idempotencyKey, input: { transferId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const data: Prisma.TransferOrderUncheckedUpdateInput = {}
    if (checked.transitLocationId !== undefined) data.transitLocationId = checked.transitLocationId
    if (checked.fromLocationId !== undefined) data.fromLocationId = checked.fromLocationId
    if (checked.toLocationId !== undefined) data.toLocationId = checked.toLocationId
    if (body.shipOn !== undefined) data.shipOn = body.shipOn ? toDay(body.shipOn) : null
    if (body.expectedOn !== undefined) data.expectedOn = body.expectedOn ? toDay(body.expectedOn) : null
    if (body.note !== undefined) data.note = body.note?.trim() || null
    if (body.trackingRef !== undefined) data.trackingRef = body.trackingRef?.trim() || null
    if (body.trackingUrl !== undefined) data.trackingUrl = body.trackingUrl?.trim() || null
    await tools.tx.transferOrder.update({ where: { id: transferId }, data, select: { id: true } })
    const { version: _version, ...after } = body
    tools.audit({ recordType: 'TransferOrder', recordId: transferId, companyId: before.companyId, siteId: before.fromSiteId, before: { transitLocationId: before.transitLocationId, fromLocationId: before.fromLocationId, toLocationId: before.toLocationId, shipOn: dayOf(before.shipOn), expectedOn: dayOf(before.expectedOn), note: before.note, trackingRef: before.trackingRef, trackingUrl: before.trackingUrl }, after })
    transferChanged(tools, before, 'EDITED', status, status)
    return { id: transferId }
  })
  return transferRecord(caller, transferId)
}

// ---- lines -------------------------------------------------------------------------------------------------------------------

/** The stock key a line names, checked against the sending site: the item, its tracking, the lot (its colour) and the hide. */
async function lineFacts(client: Reader, row: TransferRowData, body: { itemId: string; itemColourId?: string | null | undefined; lotId?: string | null | undefined; hideId?: string | null | undefined }) {
  const item = await client.item.findUnique({ where: { id: body.itemId }, select: { id: true, code: true, tracking: true, baseUom: true, status: true } })
  if (!item) throw new ValidationError('The material was not found.', [{ path: 'body/itemId', message: 'Not a material of the library.' }])
  let lot: { id: string; itemColourId: string | null; qualityStatus: string } | null = null
  if (body.lotId) {
    lot = await client.lot.findFirst({ where: { id: body.lotId, siteId: row.fromSiteId, itemId: item.id }, select: { id: true, itemColourId: true, qualityStatus: true } })
    if (!lot) throw new ValidationError('The lot is not a lot of this material at the sending site.', [{ path: 'body/lotId', message: 'Not a lot of this material at the sending site.' }])
  }
  let hide: { id: string; lotId: string } | null = null
  if (body.hideId) {
    hide = await client.hide.findFirst({ where: { id: body.hideId, siteId: row.fromSiteId, itemId: item.id }, select: { id: true, lotId: true } })
    if (!hide) throw new ValidationError('The hide is not a hide of this material at the sending site.', [{ path: 'body/hideId', message: 'Not a hide of this material at the sending site.' }])
    if (!lot) lot = await client.lot.findFirst({ where: { id: hide.lotId }, select: { id: true, itemColourId: true, qualityStatus: true } })
    if (lot && hide.lotId !== lot.id) throw new ValidationError('The hide is of another lot.', [{ path: 'body/hideId', message: 'The hide is of another lot.' }])
  }
  const colour = lot ? lot.itemColourId : (body.itemColourId ?? null)
  if (lot && body.itemColourId !== undefined && body.itemColourId !== lot.itemColourId) throw new ValidationError("A lot travels in its own colour.", [{ path: 'body/itemColourId', message: "The lot's colour is another one." }])
  if (!lot && colour) {
    const found = await client.itemColour.findFirst({ where: { id: colour, itemId: item.id }, select: { id: true } })
    if (!found) throw new ValidationError('The colour is not one of the material.', [{ path: 'body/itemColourId', message: 'Not a colour of this material.' }])
  }
  return { item: { ...item, tracking: item.tracking as ItemTracking }, lot, hide, colour }
}

/** Where a hide lies at the site now (its one place with stock), or null. */
async function hidePlace(client: Reader, siteId: string, itemId: string, hideId: string): Promise<{ locationId: string; quantity: Decimal } | null> {
  const balances = await balancesAt(client, siteId, { itemId, hideId })
  for (const [key, quantity] of balances) if (quantity.greaterThan(ZERO)) return { locationId: key.split('|')[0]!, quantity }
  return null
}

async function lineCheck(client: Reader, row: TransferRowData, facts: Awaited<ReturnType<typeof lineFacts>>, place: string | null, quantity: Decimal, skipLineId: string | null): Promise<TransferProblem[]> {
  const balances = place ? await balancesAt(client, row.fromSiteId, { itemId: facts.item.id }) : null
  const available = place && balances ? (balances.get(keyText({ locationId: place, itemId: facts.item.id, itemColourId: facts.colour, lotId: facts.lot?.id ?? null, hideId: facts.hide?.id ?? null })) ?? ZERO) : null
  // This draft's other lines of the same key take from the same place.
  const others = await client.transferLine.findMany({ where: { transferId: row.id, itemId: facts.item.id, itemColourId: facts.colour, lotId: facts.lot?.id ?? null, hideId: facts.hide?.id ?? null, ...(skipLineId ? { id: { not: skipLineId } } : {}) }, select: { fromLocationId: true, baseQuantity: true } })
  const taken = others.filter((other) => (other.fromLocationId ?? row.fromLocationId) === place).reduce((sum, other) => sum.plus(decOf(other.baseQuantity)), ZERO)
  const hideElsewhere = facts.hide
    ? (await client.transferLine.count({ where: { hideId: facts.hide.id, transfer: { status: 'DRAFT' }, ...(skipLineId ? { id: { not: skipLineId } } : {}) } })) > 0
    : false
  return lineProblems({ tracking: facts.item.tracking, lotId: facts.lot?.id ?? null, hideId: facts.hide?.id ?? null, lotStatus: facts.lot?.qualityStatus ?? null, quantity, available: available === null ? null : Dec.max(ZERO, available.minus(taken)), hideElsewhere })
}

/** A line of a draft (from the stock picker): its material, lot and hide, where it is picked and how much (a hide: whole). */
export async function addLine(caller: CommandCaller, transferId: string, body: AddLineBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const checked = await caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    mustManage(context, row, 'from')
    if (row.status !== 'DRAFT') refuse([problem('NOT_DRAFT')])
    const count = await client.transferLine.count({ where: { transferId } })
    if (count >= TRANSFER_LIMITS.lines) refuse([problem('TOO_MANY_LINES')])
    const facts = await lineFacts(client, row, body)
    let place = (await usablePlace(client, row.fromSiteId, body.fromLocationId, 'fromLocationId')) ?? row.fromLocationId
    let quantity = body.quantity !== undefined ? typedQuantity(body.quantity) : null
    if (facts.hide) {
      const lies = await hidePlace(client, row.fromSiteId, facts.item.id, facts.hide.id)
      if (!place && lies) place = lies.locationId
      if (quantity === null && lies && lies.locationId === place) quantity = lies.quantity
    }
    if (quantity === null) invalid([{ path: 'quantity', message: 'How much: a quantity above 0 in the base unit, at most 4 decimals.' }])
    refuse(await lineCheck(client, row, facts, place, quantity!, null))
    const last = await client.transferLine.findFirst({ where: { transferId }, select: { seq: true }, orderBy: { seq: 'desc' } })
    return { row, facts, place: body.fromLocationId === undefined && !facts.hide ? null : place, quantity: quantity!, seq: (last?.seq ?? 0) + 10 }
  })
  await command(caller, { name: 'inventory.transfers.addLine', idempotencyKey, input: { transferId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const lineId = newId()
    const quantity = quantityOut(checked.quantity)
    await tools.tx.transferLine.create({
      data: {
        id: lineId,
        transferId,
        fromSiteId: checked.row.fromSiteId,
        toSiteId: checked.row.toSiteId,
        seq: checked.seq,
        itemId: checked.facts.item.id,
        itemColourId: checked.facts.colour,
        lotId: checked.facts.lot?.id ?? null,
        hideId: checked.facts.hide?.id ?? null,
        fromLocationId: checked.place,
        quantity,
        uom: checked.facts.item.baseUom,
        baseQuantity: quantity,
        note: body.note?.trim() || null,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'inventory.transfers.addLine', recordType: 'TransferLine', recordId: lineId, companyId: checked.row.companyId, siteId: checked.row.fromSiteId, after: { transferId, seq: checked.seq, itemId: checked.facts.item.id, itemColourId: checked.facts.colour, lotId: checked.facts.lot?.id ?? null, hideId: checked.facts.hide?.id ?? null, fromLocationId: checked.place, quantity } })
    transferChanged(tools, checked.row, 'LINES', 'DRAFT', 'DRAFT')
    return { id: lineId }
  })
  return transferRecord(caller, transferId)
}

/** A draft line's cell (autosave per cell): the quantity, the place it is picked from, its note; on the line's version. */
export async function updateLine(caller: CommandCaller, transferId: string, lineId: string, body: UpdateLineBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const checked = await caller.withClient(async (client) => {
    const row = await visibleTransfer(client, context, transferId)
    mustManage(context, row, 'from')
    if (row.status !== 'DRAFT') refuse([problem('NOT_DRAFT')])
    const line = isUuid(lineId) ? await client.transferLine.findFirst({ where: { id: lineId, transferId }, select: LINE_SELECT }) : null
    if (!line) throw new NotFoundError('Line not found.')
    const facts = await lineFacts(client, row, { itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })
    const place = body.fromLocationId !== undefined ? await usablePlace(client, row.fromSiteId, body.fromLocationId, 'fromLocationId') : line.fromLocationId
    const quantity = body.quantity !== undefined ? typedQuantity(body.quantity) : decOf(line.baseQuantity)
    if (quantity === null) invalid([{ path: 'quantity', message: 'How much: a quantity above 0 in the base unit, at most 4 decimals.' }])
    refuse(await lineCheck(client, row, facts, place ?? row.fromLocationId, quantity!, line.id))
    return { row, line, place, quantity: quantity! }
  })
  await command(caller, { name: 'inventory.transfers.editLine', idempotencyKey, input: { transferId, lineId, ...body }, record: { type: 'TransferLine', id: lineId, expectedVersion: body.version } }, async (tools) => {
    const quantity = quantityOut(checked.quantity)
    const data: Prisma.TransferLineUncheckedUpdateInput = {}
    if (body.quantity !== undefined) Object.assign(data, { quantity, baseQuantity: quantity })
    if (body.fromLocationId !== undefined) data.fromLocationId = checked.place
    if (body.note !== undefined) data.note = body.note?.trim() || null
    await tools.tx.transferLine.update({ where: { id: lineId }, data, select: { id: true } })
    tools.audit({
      action: 'inventory.transfers.editLine',
      recordType: 'TransferLine',
      recordId: lineId,
      companyId: checked.row.companyId,
      siteId: checked.row.fromSiteId,
      before: { quantity: quantityOut(decOf(checked.line.baseQuantity)), fromLocationId: checked.line.fromLocationId, note: checked.line.note },
      after: { ...(body.quantity !== undefined ? { quantity } : {}), ...(body.fromLocationId !== undefined ? { fromLocationId: checked.place } : {}), ...(body.note !== undefined ? { note: body.note } : {}) },
    })
    transferChanged(tools, checked.row, 'LINES', 'DRAFT', 'DRAFT')
    return { id: lineId }
  })
  return transferRecord(caller, transferId)
}

/** A draft line removed (on the transfer's version). */
export async function removeLine(caller: CommandCaller, transferId: string, lineId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => visibleTransfer(client, context, transferId))
  mustManage(context, row, 'from')
  if (row.status !== 'DRAFT') refuse([problem('NOT_DRAFT')])
  await command(caller, { name: 'inventory.transfers.removeLine', idempotencyKey, input: { transferId, lineId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    const line = isUuid(lineId) ? await tools.tx.transferLine.findFirst({ where: { id: lineId, transferId }, select: { id: true, seq: true, itemId: true, lotId: true, hideId: true, baseQuantity: true } }) : null
    if (!line) throw new NotFoundError('Line not found.')
    await tools.tx.transferLine.delete({ where: { id: lineId }, select: { id: true } })
    tools.audit({ action: 'inventory.transfers.removeLine', recordType: 'TransferLine', recordId: lineId, companyId: row.companyId, siteId: row.fromSiteId, before: { transferId, seq: line.seq, itemId: line.itemId, lotId: line.lotId, hideId: line.hideId, quantity: quantityOut(decOf(line.baseQuantity)) } })
    transferChanged(tools, row, 'LINES', 'DRAFT', 'DRAFT')
    return { id: lineId }
  })
  return transferRecord(caller, transferId)
}

/** A draft cancelled, with why (it never left). */
export async function cancelTransfer(caller: CommandCaller, transferId: string, body: CancelBody, idempotencyKey?: string): Promise<TransferView> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => visibleTransfer(client, context, transferId))
  mustManage(context, row, 'from')
  if (row.status !== 'DRAFT') refuse([problem('NOT_DRAFT')])
  await command(caller, { name: 'inventory.transfers.cancel', idempotencyKey, input: { transferId, ...body }, record: { type: 'TransferOrder', id: transferId, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.transferOrder.update({ where: { id: transferId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim() }, select: { id: true } })
    tools.audit({ recordType: 'TransferOrder', recordId: transferId, companyId: row.companyId, siteId: row.fromSiteId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason: body.reason.trim() })
    transferChanged(tools, row, 'CANCELLED', 'CANCELLED', 'DRAFT')
    return { id: transferId }
  })
  return transferRecord(caller, transferId)
}

export { managesTo }
