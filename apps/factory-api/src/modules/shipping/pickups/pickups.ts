import type { Prisma } from '@nexus/factory-db'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CarrierAddress } from '@nexus/factory-domain/ports/carrier'
import { accountProblems, carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_PICKUPS_BOOK } from '@nexus/factory-domain/shipping/pickups/permissions'
import {
  bookingProblems,
  comesOn,
  isTestPickup,
  moveProblems,
  moveRefusal,
  pickupRefusalPath,
  pickupViaOf,
  pickupWindow,
  PICKUP_WORDS,
  readyTimeOf,
  testPickupReference,
  weekdaysInOrder,
  type PickupMove,
  type PickupRefusalCode,
  type PickupStatus,
  type PickupVia,
} from '@nexus/factory-domain/shipping/pickups/rules'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { ShippingAddress } from '@nexus/factory-domain/shipping/settings'
import { parseDecimal, sum, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { GatewayCallFailed } from '../../../platform/gateway/gateway'
import { assertMay, mayOn, officeContextOf } from '../access'
import { carrierProblem } from '../labels/carrier'
import { carrierAccountIdOf } from '../labels/store'
import { processPickups } from './runtime'

/**
 * Carrier pickups (B-W2b-395; LOG-048; rules factory-domain shipping/pickups; factory-db PickupRequest and its guard). Office
 * only; reading is shipping.view, every write shipping.pickups.book on the site's company and site:
 *
 *   list      the pickups of a site (or every site the reader sees), newest first; with `day`, those that come that day
 *             (one-offs of that day, a failed one too; recurring ones on their weekdays), by ready time
 *   draft     what the "Book a pickup" pop-up starts with: the site's address, the selection's parcels, pallets and weight,
 *             a ready time, which ways are open (Sendcloud, the TEST pickup of test mode, phone) and the pickups already
 *             coming that day for the carrier
 *   book      PHONE: ONE command keeps it CONFIRMED with the note (and the carrier's reference when given). SENDCLOUD on a
 *             site in test mode: ONE command keeps it CONFIRMED with the TEST pickup's reference (nothing sent). SENDCLOUD on
 *             a live site: the company's usable connection checked first (409 NO_CONNECTION in words, nothing kept), then
 *             ONE command keeps it REQUESTED, then the gateway call (outside any transaction), then ONE command keeps the
 *             answer: CONFIRMED with Sendcloud's reference, or FAILED with why in words (the request stays, visible)
 *   move      confirmed by hand (REQUESTED), failed with why (REQUESTED, CONFIRMED), called off (REQUESTED, CONFIRMED;
 *             Sendcloud is told first for a pickup it booked; when it cannot be, the call-off still stands and the answer
 *             says to call the carrier); ONE command on the request (its version)
 *
 * Refusals are 409 `refusal/<CODE>` in words; field problems 400 at their field.
 */

const PICKUP_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  carrierCode: true,
  readyAt: true,
  parcels: true,
  pallets: true,
  address: true,
  repeatWeekdays: true,
  status: true,
  providerReference: true,
  errorWords: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
  site: { select: { code: true, name: true, timezone: true } },
} as const satisfies Prisma.PickupRequestSelect

type PickupRow = Prisma.PickupRequestGetPayload<{ select: typeof PICKUP_SELECT }>

const refused = (code: PickupRefusalCode, message: string): never => {
  throw new DomainError('conflict', message, [{ path: pickupRefusalPath(code), message }])
}

const zoneOf = (row: { site: { timezone: string | null } }): string => row.site.timezone || BUSINESS_TIME_ZONE

const allowance = (refusal: { code: PickupRefusalCode; message: string } | null) => ({ allowed: refusal === null, refusal })

/** The ready instant of a request on a day (a recurring one's time of day on that day). */
function readyOn(row: PickupRow, day: BusinessDate | null): Date {
  if (day === null || row.repeatWeekdays.length === 0) return row.readyAt
  const zone = zoneOf(row)
  const first = businessDate(row.readyAt, zone)
  const offset = row.readyAt.getTime() - businessDayRange(first, zone).start.getTime()
  return new Date(businessDayRange(day, zone).start.getTime() + offset)
}

function rowView(row: PickupRow, day: BusinessDate | null = null) {
  const status = row.status as PickupStatus
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    site: { code: row.site.code, name: row.site.name },
    carrierCode: row.carrierCode,
    carrierName: carrierNameFor('CARRIER', row.carrierCode) ?? row.carrierCode,
    readyAt: toUtcIso(row.readyAt),
    readyTime: readyTimeOf(readyOn(row, day), zoneOf(row)),
    parcels: row.parcels,
    pallets: row.pallets,
    address: (row.address ?? {}) as Record<string, unknown>,
    repeatWeekdays: weekdaysInOrder(row.repeatWeekdays),
    recurring: row.repeatWeekdays.length > 0,
    status,
    via: pickupViaOf(row),
    test: isTestPickup(row.providerReference),
    providerReference: row.providerReference,
    errorWords: row.errorWords,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    may: { confirm: allowance(moveRefusal(status, 'CONFIRMED')), fail: allowance(moveRefusal(status, 'FAILED')), cancel: allowance(moveRefusal(status, 'CANCELLED')) },
  }
}

const detailView = (row: PickupRow) => ({ ...rowView(row), createdById: row.createdById })

/** The site, the caller allowed `permission` on it (404 out of its reach, 403 without the permission). */
async function siteFor(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_VIEW | typeof SHIPPING_PICKUPS_BOOK) {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true, name: true, timezone: true } })) : null
  assertMay(context, SHIPPING_VIEW, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return { ...site!, timeZone: site!.timezone || BUSINESS_TIME_ZONE }
}

async function pickupFor(caller: CommandCaller, pickupId: string, permission: typeof SHIPPING_VIEW | typeof SHIPPING_PICKUPS_BOOK): Promise<PickupRow> {
  const context = officeContextOf(caller)
  const row = isUuid(pickupId) ? await caller.withClient((client) => client.pickupRequest.findUnique({ where: { id: pickupId }, select: PICKUP_SELECT })) : null
  assertMay(context, SHIPPING_VIEW, permission, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Pickup')
  return row!
}

/** GET /shipping/pickups/:pickupId. */
export async function getPickup(caller: CommandCaller, pickupId: string) {
  return { pickup: detailView(await pickupFor(caller, pickupId, SHIPPING_VIEW)) }
}

export interface ListPickupsQuery {
  readonly siteId?: string | undefined
  readonly status?: PickupStatus | undefined
  readonly carrierCode?: string | undefined
  readonly day?: BusinessDate | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const cursorOf = (row: PickupRow): string => Buffer.from(`${row.readyAt.toISOString()}|${row.id}`).toString('base64url')
function parseCursor(cursor: string | undefined): { readyAt: Date; id: string } | null {
  if (!cursor) return null
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  const readyAt = new Date(at ?? '')
  if (!id || !isUuid(id) || Number.isNaN(readyAt.getTime())) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Expected a cursor this list gave.' }])
  return { readyAt, id }
}

/** GET /shipping/pickups. */
export async function listPickups(caller: CommandCaller, query: ListPickupsQuery) {
  const context = officeContextOf(caller)
  if (query.siteId) await siteFor(caller, query.siteId, SHIPPING_VIEW)
  if (query.day && (query.from || query.to)) throw new ValidationError('Ask for one day, or a range of days, not both.', [{ path: 'querystring/day', message: 'Not with from or to.' }])
  const where: Prisma.PickupRequestWhereInput = {
    ...(query.siteId ? { siteId: query.siteId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.carrierCode ? { carrierCode: query.carrierCode } : {}),
  }
  const seen = (row: PickupRow) => mayOn(context, SHIPPING_VIEW, { companyId: row.companyId, siteId: row.siteId })
  if (query.day) {
    const day = query.day
    // A recurring pickup comes on its weekdays from its first day on; a one-off on its own day (a site's zone is at most 14
    // hours from UTC: the rows read are then kept by the site's own day).
    const utc = businessDayRange(day, 'UTC')
    const around = { start: new Date(utc.start.getTime() - 14 * 3_600_000), end: new Date(utc.end.getTime() + 14 * 3_600_000) }
    const rows = await caller.withClient((client) =>
      client.pickupRequest.findMany({
        where: { ...where, status: query.status ?? { not: 'CANCELLED' }, OR: [{ repeatWeekdays: { isEmpty: true }, readyAt: { gte: around.start, lt: around.end } }, { repeatWeekdays: { isEmpty: false }, readyAt: { lt: around.end } }] },
        select: PICKUP_SELECT,
        take: 500,
      }),
    )
    const coming = rows.filter((row) => seen(row) && comesOn({ readyAt: row.readyAt, repeatWeekdays: row.repeatWeekdays, status: row.status as PickupStatus }, day, zoneOf(row)))
    const sorted = coming.sort((a, b) => readyOn(a, day).getTime() - readyOn(b, day).getTime() || a.id.localeCompare(b.id))
    return { pickups: sorted.slice(0, query.limit).map((row) => rowView(row, day)), nextCursor: null }
  }
  const after = parseCursor(query.cursor)
  const range: Prisma.DateTimeFilter = {}
  if (query.from) range.gte = businessDayRange(query.from).start
  if (query.to) range.lt = businessDayRange(query.to).end
  const rows = await caller.withClient((client) =>
    client.pickupRequest.findMany({
      where: {
        ...where,
        ...(query.from || query.to ? { readyAt: range } : {}),
        ...(after ? { OR: [{ readyAt: { lt: after.readyAt } }, { readyAt: after.readyAt, id: { lt: after.id } }] } : {}),
      },
      select: PICKUP_SELECT,
      orderBy: [{ readyAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    }),
  )
  // The page is the rows read up to the limit, those out of the reader's grants left out; the next one starts after them.
  const page = rows.slice(0, query.limit).filter(seen)
  return { pickups: page.map((row) => rowView(row)), nextCursor: rows.length > query.limit ? cursorOf(rows[query.limit - 1]!) : null }
}

/** The company's Sendcloud connection for the site's pickups, and why it cannot be used (null: it can). */
async function connectionOf(db: CommandTx, site: { id: string; companyId: string }, settingsAccountId: string | null) {
  const accountId = await carrierAccountIdOf(db, { companyId: site.companyId, siteId: site.id, integrationAccountId: null }, settingsAccountId)
  const account = accountId ? await db.integrationAccount.findUnique({ where: { id: accountId }, select: { id: true, provider: true, companyId: true, mode: true, status: true } }) : null
  const problems = accountProblems(account, site.companyId, processPickups().environment)
  return { accountId: account?.id ?? null, problem: problems.length > 0 ? `${PICKUP_WORDS.NO_CONNECTION} ${problems.map((problem) => problem.message).join(' ')}` : null }
}

const settingsOf = (db: CommandTx, siteId: string) => db.shippingSettings.findUnique({ where: { id: siteId }, select: { senderAddress: true, testMode: true, integrationAccountId: true, defaultCarrierCode: true } })

/** The next half hour from now (the pop-up's first ready time). */
const nextHalfHour = (now: Date): Date => new Date(Math.ceil((now.getTime() + 60_000) / 1_800_000) * 1_800_000)

/** GET /shipping/pickups/draft: what the "Book a pickup" pop-up starts with. */
export async function pickupDraft(caller: CommandCaller, query: { siteId: string; carrierCode?: string | undefined; shipmentIds?: string | undefined }) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, SHIPPING_VIEW)
  const asked = [...new Set((query.shipmentIds ?? '').split(',').map((part) => part.trim()).filter((part) => part !== ''))]
  if (asked.length > 100 || asked.some((value) => !isUuid(value))) throw new ValidationError('Expected at most 100 shipment ids, comma-separated.', [{ path: 'querystring/shipmentIds', message: 'Expected at most 100 shipment ids, comma-separated.' }])
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const settings = await settingsOf(db, site.id)
    const shipments = asked.length === 0 ? [] : await db.shipment.findMany({ where: { id: { in: asked } }, select: { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, transportBy: true, carrierCode: true } })
    const parcels = shipments.length === 0 ? [] : await db.parcel.findMany({ where: { shipmentId: { in: shipments.map((row) => row.id) } }, select: { shipmentId: true, grossWeightKg: true, packagingType: { select: { kind: true } } } })
    const taken: { id: string; number: string; parcels: number; pallets: number }[] = []
    const skipped: { id: string; number: string | null; words: string }[] = []
    for (const id of asked) {
      const shipment = shipments.find((row) => row.id === id)
      if (!shipment || !mayOn(context, SHIPPING_VIEW, shipment)) skipped.push({ id, number: null, words: 'Not found.' })
      else if (shipment.siteId !== site.id) skipped.push({ id, number: shipment.number, words: 'It leaves from another site: book its pickup there.' })
      else if (shipment.transportBy !== 'CARRIER') skipped.push({ id, number: shipment.number, words: 'It does not travel with a carrier (our van or the customer collecting).' })
      else if (shipment.status !== 'DRAFT' && shipment.status !== 'PACKED') skipped.push({ id, number: shipment.number, words: `It is ${shipment.status}: only shipments still at the dock are collected.` })
      else {
        const own = parcels.filter((parcel) => parcel.shipmentId === id)
        const pallets = own.filter((parcel) => parcel.packagingType?.kind === 'PALLET').length
        taken.push({ id, number: shipment.number, parcels: own.length - pallets, pallets })
      }
    }
    const own = parcels.filter((parcel) => taken.some((row) => row.id === parcel.shipmentId))
    const weighed = own.every((parcel) => parcel.grossWeightKg !== null) ? sum(own.map((parcel) => parseDecimal(parcel.grossWeightKg!.toString()) ?? ZERO)) : null
    const carriers = [...new Set(shipments.filter((row) => taken.some((item) => item.id === row.id)).map((row) => row.carrierCode).filter((code): code is string => code !== null))]
    const carrierCode = query.carrierCode?.trim() || (carriers.length === 1 ? carriers[0]! : null) || settings?.defaultCarrierCode || null
    const testMode = settings?.testMode ?? true
    const connection = !testMode ? await connectionOf(db, site, settings?.integrationAccountId ?? null) : { accountId: null, problem: null }
    const noAddress = settings ? null : { code: 'NO_SETTINGS' as const, message: PICKUP_WORDS.NO_SETTINGS }
    const today = businessDate(now, site.timeZone)
    const coming = carrierCode
      ? (await db.pickupRequest.findMany({ where: { siteId: site.id, carrierCode, status: { not: 'CANCELLED' }, readyAt: { lt: businessDayRange(today, site.timeZone).end } }, select: PICKUP_SELECT, take: 200 })).filter((row) =>
          comesOn({ readyAt: row.readyAt, repeatWeekdays: row.repeatWeekdays, status: row.status as PickupStatus }, today, site.timeZone),
        )
      : []
    const sendcloudRefusal = noAddress ?? (connection.problem ? { code: 'NO_CONNECTION' as const, message: connection.problem } : null)
    return {
      siteId: site.id,
      companyId: site.companyId,
      site: { code: site.code, name: site.name, timeZone: site.timeZone },
      address: (settings?.senderAddress ?? null) as Record<string, unknown> | null,
      carrierCode,
      carrierName: carrierCode ? carrierNameFor('CARRIER', carrierCode) : null,
      parcels: taken.reduce((total, row) => total + row.parcels, 0),
      pallets: taken.reduce((total, row) => total + row.pallets, 0),
      weightKg: weighed === null || own.length === 0 ? null : weighed.toFixed(3),
      readyAt: toUtcIso(nextHalfHour(now)),
      shipments: taken,
      skipped,
      testMode,
      vias: {
        SENDCLOUD: { ...allowance(sendcloudRefusal), test: testMode, recurring: false },
        PHONE: { ...allowance(null), recurring: true },
      },
      alreadyToday: coming.map((row) => rowView(row, today)),
    }
  })
}

export interface BookPickupBody {
  readonly siteId: string
  readonly via: PickupVia
  readonly carrierCode: string
  readonly readyAt: string
  readonly parcels: number
  readonly pallets: number
  readonly address?: ShippingAddress | null | undefined
  readonly repeatWeekdays?: readonly string[] | undefined
  readonly note?: string | null | undefined
  readonly providerReference?: string | null | undefined
  readonly weightKg?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The address as kept on the request: its filled fields, trimmed. */
function addressJson(address: ShippingAddress): Prisma.InputJsonObject {
  const kept: Record<string, string> = {}
  for (const key of ['name', 'line1', 'line2', 'postalCode', 'city', 'province', 'country', 'phone', 'email'] as const) {
    const value = blank(address[key])
    if (value !== null) kept[key] = value
  }
  return kept
}

function carrierAddressOf(address: ShippingAddress): CarrierAddress {
  const text = (value: string | null | undefined) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  return { name: address.name.trim(), companyName: null, line1: address.line1.trim(), line2: text(address.line2), postalCode: address.postalCode.trim(), city: address.city.trim(), province: text(address.province), country: address.country.trim(), phone: text(address.phone), email: text(address.email) }
}

function changed(tools: CommandTools, row: { id: string; companyId: string; siteId: string; carrierCode: string; readyAt: Date; repeatWeekdays: readonly string[]; note: string | null }, status: PickupStatus) {
  tools.emit({
    type: 'shipping.pickup_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { pickupId: row.id, siteId: row.siteId, carrierCode: row.carrierCode, status, via: pickupViaOf(row), readyAt: toUtcIso(row.readyAt), recurring: row.repeatWeekdays.length > 0 },
  })
}

/** POST /shipping/pickups (see the file's comment). */
export async function bookPickup(caller: CommandCaller, body: BookPickupBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, SHIPPING_PICKUPS_BOOK)
  const now = serverClock.now()
  const booking = {
    via: body.via,
    carrierCode: body.carrierCode.trim(),
    readyAt: new Date(body.readyAt),
    parcels: body.parcels,
    pallets: body.pallets,
    address: body.address ?? null,
    repeatWeekdays: body.repeatWeekdays ?? [],
    note: body.note === undefined ? null : body.note,
    providerReference: body.providerReference === undefined ? null : body.providerReference,
    weightKg: blank(body.weightKg),
  }
  const problems = bookingProblems(booking, now)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The pickup is not valid.', problems)
  const facts = await caller.withClient(async (db) => {
    const settings = await settingsOf(db, site.id)
    const testMode = settings?.testMode ?? true
    const connection = body.via === 'SENDCLOUD' && !testMode ? await connectionOf(db, site, settings?.integrationAccountId ?? null) : null
    return { settings, testMode, connection }
  })
  const address = (booking.address ?? facts.settings?.senderAddress ?? null) as ShippingAddress | null
  if (address === null) refused('NO_SETTINGS', PICKUP_WORDS.NO_SETTINGS)
  if (facts.connection?.problem) refused('NO_CONNECTION', facts.connection.problem)
  const test = body.via === 'SENDCLOUD' && facts.testMode
  const live = body.via === 'SENDCLOUD' && !facts.testMode
  const asked = {
    companyId: site.companyId,
    siteId: site.id,
    carrierCode: booking.carrierCode,
    readyAt: booking.readyAt,
    parcels: booking.parcels,
    pallets: booking.pallets,
    address: addressJson(address!),
    repeatWeekdays: weekdaysInOrder(booking.repeatWeekdays),
    note: body.via === 'PHONE' ? booking.note!.trim() : null,
  }

  const { result, replayed } = await command(caller, { name: 'shipping.bookPickup', idempotencyKey, input: body }, async (tools) => {
    const id = newId()
    const status: PickupStatus = live ? 'REQUESTED' : 'CONFIRMED'
    const providerReference = test ? testPickupReference(id) : body.via === 'PHONE' ? blank(booking.providerReference) : null
    await tools.tx.pickupRequest.create({ data: { id, ...asked, status, providerReference, createdById: context.actorId }, select: { id: true } })
    tools.audit({
      action: 'shipping.bookPickup',
      recordType: 'PickupRequest',
      recordId: id,
      companyId: site.companyId,
      siteId: site.id,
      after: { via: body.via, test, status, carrierCode: asked.carrierCode, readyAt: toUtcIso(asked.readyAt), parcels: asked.parcels, pallets: asked.pallets, repeatWeekdays: asked.repeatWeekdays, providerReference, weightKg: booking.weightKg },
    })
    changed(tools, { id, ...asked }, status)
    return { id }
  })
  const pickupId = result.id
  if (live && !replayed) {
    const row = await caller.withClient((db) => db.pickupRequest.findUniqueOrThrow({ where: { id: pickupId }, select: PICKUP_SELECT }))
    const window = pickupWindow(row.readyAt, zoneOf(row))
    let answer: { providerReference: string } | null = null
    let words: string | null = null
    try {
      answer = await processPickups().book(caller, facts.connection!.accountId!, pickupId, {
        carrierCode: row.carrierCode,
        address: carrierAddressOf(address!),
        readyFrom: toUtcIso(window.from),
        readyUntil: toUtcIso(window.until),
        parcels: row.parcels,
        pallets: row.pallets,
        weightKg: booking.weightKg,
        reference: `PU-${pickupId.slice(-8).toUpperCase()}`,
      })
    } catch (error) {
      words = carrierProblem(error)
      // Unknown outcome: the call may have reached the carrier.
      if (error instanceof GatewayCallFailed && error.kind !== 'provider_error') words = `${words} The carrier may have booked it all the same: check with the carrier before booking again.`
    }
    await command(caller, { name: 'shipping.pickupAnswered', ...(idempotencyKey ? { idempotencyKey: `${idempotencyKey}:answer` } : {}), input: { pickupId, answered: answer !== null } }, async (tools) => {
      const current = await tools.tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "PickupRequest" WHERE id = ${pickupId}::uuid FOR UPDATE`
      const still = current[0]?.status === 'REQUESTED'
      const to: PickupStatus = answer ? 'CONFIRMED' : 'FAILED'
      if (still) {
        await tools.tx.pickupRequest.update({
          where: { id: pickupId },
          data: answer ? { status: to, providerReference: answer.providerReference.slice(0, 100), version: { increment: 1 } } : { status: to, errorWords: (words ?? 'Sendcloud did not book the pickup.').slice(0, 2000), version: { increment: 1 } },
          select: { id: true },
        })
        changed(tools, row, to)
      }
      tools.audit({
        action: 'shipping.pickupAnswered',
        recordType: 'PickupRequest',
        recordId: pickupId,
        companyId: row.companyId,
        siteId: row.siteId,
        before: { status: current[0]?.status ?? null },
        after: { status: still ? to : (current[0]?.status ?? null), providerReference: answer?.providerReference ?? null, errorWords: answer ? null : words, kept: still },
      })
      return { to }
    })
  }
  return { pickup: detailView(await caller.withClient((db) => db.pickupRequest.findUniqueOrThrow({ where: { id: pickupId }, select: PICKUP_SELECT }))), replayed }
}

export interface MovePickupBody {
  readonly version?: number | undefined
  readonly status: PickupMove
  readonly providerReference?: string | null | undefined
  readonly words?: string | null | undefined
}

/** POST /shipping/pickups/:pickupId/status (see the file's comment). */
export async function movePickup(caller: CommandCaller, pickupId: string, body: MovePickupBody, idempotencyKey?: string) {
  const row = await pickupFor(caller, pickupId, SHIPPING_PICKUPS_BOOK)
  const input = { status: body.status, providerReference: body.providerReference ?? null, words: body.words ?? null }
  const state = moveRefusal(row.status as PickupStatus, body.status)
  if (state) refused(state.code, state.message)
  const problems = moveProblems(input, row.providerReference)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  // The version first: Sendcloud is never told of a call-off that then fails on a stale version.
  if (body.version !== undefined && body.version !== row.version) throw new StaleVersionError('PickupRequest', row.id, row.version, body.version)
  // A call-off of a pickup Sendcloud booked: Sendcloud is told first (outside any transaction).
  let carrier: { told: boolean; words: string | null } | null = null
  const booked = body.status === 'CANCELLED' && pickupViaOf(row) === 'SENDCLOUD' && row.providerReference !== null && !isTestPickup(row.providerReference)
  if (booked) {
    const settings = await caller.withClient((db) => settingsOf(db, row.siteId))
    const connection = await caller.withClient((db) => connectionOf(db, { id: row.siteId, companyId: row.companyId }, settings?.integrationAccountId ?? null))
    if (connection.problem || !connection.accountId) carrier = { told: false, words: `Sendcloud could not be told (${connection.problem ?? 'no connection'}): call the carrier to call the pickup off.` }
    else {
      try {
        const outcome = await processPickups().cancel(caller, connection.accountId, row.id, row.providerReference!)
        carrier = outcome === 'CANCELLED' ? { told: true, words: null } : { told: false, words: "Sendcloud's pickup call-off is not wired yet: call the carrier to call the pickup off." }
      } catch (error) {
        carrier = { told: false, words: `Sendcloud could not be told (${carrierProblem(error)}): call the carrier to call the pickup off.` }
      }
    }
  }
  const words = blank(input.words)
  await command(caller, { name: 'shipping.movePickup', idempotencyKey, input: { pickupId, ...body }, record: { type: 'PickupRequest', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const current = await tools.tx.pickupRequest.findUniqueOrThrow({ where: { id: row.id }, select: PICKUP_SELECT })
    const again = moveRefusal(current.status as PickupStatus, body.status)
    if (again) refused(again.code, again.message)
    const data: Prisma.PickupRequestUpdateInput = { status: body.status }
    if (body.status === 'FAILED') data.errorWords = words!
    const reference = blank(input.providerReference)
    if (body.status === 'CONFIRMED' && reference !== null && current.providerReference === null) data.providerReference = reference
    await tools.tx.pickupRequest.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({
      action: 'shipping.movePickup',
      recordType: 'PickupRequest',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: current.status, providerReference: current.providerReference },
      after: { status: body.status, providerReference: data.providerReference ?? current.providerReference, words, carrierTold: carrier?.told ?? null },
    })
    changed(tools, current, body.status)
    return { status: body.status }
  })
  return { pickup: detailView(await caller.withClient((db) => db.pickupRequest.findUniqueOrThrow({ where: { id: row.id }, select: PICKUP_SELECT }))), carrier }
}
