import type { Prisma } from '@nexus/factory-db'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import {
  closeDayRefusal,
  daySheetRefusalPath,
  DAY_SHEET_WORDS,
  handOverWindow,
  LEFT_STATUSES,
  MANIFEST_KIND,
  sheetFileName,
  sheetFingerprint,
  sheetTotals,
  inSheetOrder,
  type DaySheetRefusalCode,
  type ManifestSheet,
  type SheetShipment,
} from '@nexus/factory-domain/shipping/manifest/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import { parseDecimal, sum, ZERO } from '@nexus/factory-domain/tax/decimal'
import { command, runCommand, type CommandCaller, type CommandSettings, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { downloadFile, getFile, putGeneratedFile, recordGeneratedFile, type Callers } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { queueDocument } from '../../../platform/print/jobs'
import { manifestPdf } from '../../../platform/print/layouts/manifest'
import { assertMay, officeContextOf } from '../access'

/**
 * The day's close (B-W2b-395; LOG-049; rules factory-domain shipping/manifest; factory-db DispatchManifest and its guard,
 * Shipment.manifestId). Office only; reading is shipping.view, closing shipping.manage on the site's company and site:
 *
 *   end of day   the site's day per carrier: its sheet (open, closed, none yet), the shipments handed over that go on it (or
 *                are on it), those that left after its sheet closed (they go on the next day's), those an open sheet names
 *                that never left (let go at the close), the shipments still packed at the dock today, the totals and whether
 *                it may close now (each refusal in words)
 *   preview      the sheet's PDF as it would close now, marked PREVIEW; stored nowhere
 *   close        "Close the day and print manifests": per carrier the sheet's PDF painted and put in the file store OUTSIDE any
 *                transaction, then ONE command under the sheet's lock: the sheet made when it has none, what never left let
 *                go, the hand-overs put on (the same set as painted, else refused DAY_CHANGED and tried once more), the file,
 *                the MANIFEST document (version 1), closed with when and by whom; event shipping.day_sheet_closed. Then ONE
 *                print job per sheet on the site's A4 printer (print.documents there), unless `print: false`; a print that
 *                cannot be queued is said in words and closes the day all the same
 *   the system   closeDays.ts closes what a person did not, after the site's day ended (closedById null)
 *   one sheet    its shipments and its PDF (a presigned download, the "End-of-day manifest PDF" window)
 *
 * Refusals are 409 `refusal/<CODE>` in words; field problems 400 at their field.
 */

const refused = (code: DaySheetRefusalCode, message: string = DAY_SHEET_WORDS[code]): DomainError => new DomainError('conflict', message, [{ path: daySheetRefusalPath(code), message }])

/** A day at midnight UTC, as a @db.Date column keeps it. */
const dateColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
const dayOfColumn = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

export interface DaySite {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timeZone: string
}

/** The site, the caller allowed `permission` on it (404 out of its reach, 403 without the permission). */
async function siteFor(caller: CommandCaller, siteId: string, permission: typeof SHIPPING_VIEW | typeof SHIPPING_MANAGE): Promise<DaySite> {
  const context = officeContextOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true, name: true, timezone: true } })) : null
  assertMay(context, SHIPPING_VIEW, permission, site ? { companyId: site.companyId, siteId: site.id } : null, 'Site')
  return { id: site!.id, companyId: site!.companyId, code: site!.code, name: site!.name, timeZone: site!.timezone || BUSINESS_TIME_ZONE }
}

const SHIPMENT_SELECT = {
  id: true,
  number: true,
  status: true,
  carrierCode: true,
  partyId: true,
  shipTo: true,
  shippedAt: true,
  manifestId: true,
  parcels: { select: { grossWeightKg: true, trackingNumber: true }, orderBy: { seq: 'asc' } },
  ddts: { where: { cancellations: { none: {} } }, select: { number: true }, take: 1 },
} as const satisfies Prisma.ShipmentSelect

type ShipmentRow = Prisma.ShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>

const SHEET_SELECT = { id: true, companyId: true, siteId: true, carrierCode: true, day: true, closedAt: true, closedById: true, fileId: true, version: true } as const satisfies Prisma.DispatchManifestSelect
type SheetRow = Prisma.DispatchManifestGetPayload<{ select: typeof SHEET_SELECT }>

const leftStatus = (status: string): boolean => (LEFT_STATUSES as readonly string[]).includes(status)

function shipmentOf(row: ShipmentRow, partyNames: ReadonlyMap<string, string>): SheetShipment {
  const shipTo = (row.shipTo ?? {}) as Record<string, unknown>
  const named = typeof shipTo.name === 'string' && shipTo.name.trim() !== '' ? shipTo.name.trim() : null
  const kilograms = sum(row.parcels.map((parcel) => (parcel.grossWeightKg === null ? ZERO : (parseDecimal(parcel.grossWeightKg.toString()) ?? ZERO))))
  return {
    id: row.id,
    number: row.number,
    consignee: named ?? partyNames.get(row.partyId) ?? '',
    city: typeof shipTo.city === 'string' ? shipTo.city : '',
    country: typeof shipTo.country === 'string' ? shipTo.country : '',
    parcels: row.parcels.length,
    weightKg: kilograms.toFixed(3),
    trackingNumbers: row.parcels.flatMap((parcel) => (parcel.trackingNumber ? [parcel.trackingNumber] : [])),
    ddtNumber: row.ddts[0]?.number ?? null,
    shippedAt: row.shippedAt,
  }
}

/** One carrier's facts on a site's day. */
interface CarrierDay {
  readonly carrierCode: string
  readonly sheet: SheetRow | null
  /** On the sheet now and left (a closed sheet: everything on it). */
  readonly onSheet: SheetShipment[]
  /** Left, on no sheet, in the day's window: what the close puts on (or, the sheet closed, what waits for the next day). */
  readonly toAdd: SheetShipment[]
  /** On the open sheet but never left: let go at the close. */
  readonly letGo: { id: string; number: string; status: ShipmentStatus }[]
  /** Packed at the dock now with this carrier, on no sheet (today only). */
  readonly stillPacked: { id: string; number: string; parcels: number }[]
}

/** Every carrier's facts on a site's day (the caller's client or the command's transaction). */
async function readDay(db: CommandTx, site: DaySite, day: BusinessDate, today: BusinessDate, only?: string): Promise<CarrierDay[]> {
  const window = handOverWindow(day, site.timeZone)
  const carrier = only ? { carrierCode: only } : { carrierCode: { not: null } }
  const sheets = await db.dispatchManifest.findMany({ where: { siteId: site.id, day: dateColumn(day), ...(only ? { carrierCode: only } : {}) }, select: SHEET_SELECT })
  const onSheets = sheets.length === 0 ? [] : await db.shipment.findMany({ where: { manifestId: { in: sheets.map((sheet) => sheet.id) } }, select: SHIPMENT_SELECT })
  const left = await db.shipment.findMany({
    where: { siteId: site.id, transportBy: 'CARRIER', ...carrier, status: { in: [...LEFT_STATUSES] }, manifestId: null, shippedAt: { gte: window.from, lt: window.until } },
    select: SHIPMENT_SELECT,
  })
  const packed = day === today ? await db.shipment.findMany({ where: { siteId: site.id, transportBy: 'CARRIER', ...carrier, status: 'PACKED', manifestId: null }, select: SHIPMENT_SELECT }) : []
  const parties = [...new Set([...onSheets, ...left].map((row) => row.partyId))]
  const names = new Map((parties.length === 0 ? [] : await db.party.findMany({ where: { id: { in: parties } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
  const codes = [...new Set([...sheets.map((sheet) => sheet.carrierCode), ...left.map((row) => row.carrierCode!), ...packed.map((row) => row.carrierCode!)])].sort()
  return codes.map((code) => {
    const sheet = sheets.find((row) => row.carrierCode === code) ?? null
    const mine = sheet ? onSheets.filter((row) => row.manifestId === sheet.id) : []
    return {
      carrierCode: code,
      sheet,
      onSheet: inSheetOrder(mine.filter((row) => leftStatus(row.status)).map((row) => shipmentOf(row, names))),
      toAdd: inSheetOrder(left.filter((row) => row.carrierCode === code).map((row) => shipmentOf(row, names))),
      letGo: sheet && sheet.closedAt === null ? mine.filter((row) => !leftStatus(row.status)).map((row) => ({ id: row.id, number: row.number, status: row.status as ShipmentStatus })) : [],
      stillPacked: packed.filter((row) => row.carrierCode === code).map((row) => ({ id: row.id, number: row.number, parcels: row.parcels.length })),
    }
  })
}

/** What the close of one carrier would hold: the sheet's shipments as painted. */
function closingSet(facts: CarrierDay): SheetShipment[] {
  return inSheetOrder([...facts.onSheet, ...facts.toAdd])
}

/** Why one carrier's sheet cannot close now (null: it can). */
function closeRefusal(facts: CarrierDay): { code: DaySheetRefusalCode; message: string } | null {
  if (facts.sheet?.closedAt) return { code: 'ALREADY_CLOSED', message: DAY_SHEET_WORDS.ALREADY_CLOSED }
  if (!facts.sheet && facts.toAdd.length === 0) return { code: 'NOTHING_TO_CLOSE', message: DAY_SHEET_WORDS.NOTHING_TO_CLOSE }
  return null
}

const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))

function shipmentView(row: SheetShipment, day: BusinessDate, timeZone: string) {
  return {
    id: row.id,
    number: row.number,
    consignee: row.consignee,
    city: row.city,
    country: row.country,
    parcels: row.parcels,
    weightKg: row.weightKg,
    trackingNumbers: [...row.trackingNumbers],
    ddtNumber: row.ddtNumber,
    shippedAt: iso(row.shippedAt),
    /** It left on a day before (after that day's sheet had closed). */
    earlier: row.shippedAt !== null && businessDate(row.shippedAt, timeZone) < day,
  }
}

async function documentOf(db: CommandTx, sheetId: string) {
  return db.generatedDocument.findFirst({ where: { recordType: 'DispatchManifest', recordId: sheetId, kind: MANIFEST_KIND }, select: { id: true, version: true, fileId: true }, orderBy: { version: 'desc' } })
}

async function carrierView(db: CommandTx, facts: CarrierDay, day: BusinessDate, site: DaySite) {
  const closed = facts.sheet?.closedAt ? facts.sheet : null
  const shipments = closed ? facts.onSheet : closingSet(facts)
  const refusal = closeRefusal(facts)
  const document = facts.sheet ? await documentOf(db, facts.sheet.id) : null
  return {
    carrierCode: facts.carrierCode,
    carrierName: carrierNameFor('CARRIER', facts.carrierCode) ?? facts.carrierCode,
    sheet: facts.sheet
      ? {
          id: facts.sheet.id,
          state: facts.sheet.closedAt ? ('CLOSED' as const) : ('OPEN' as const),
          closedAt: iso(facts.sheet.closedAt),
          closedBy: facts.sheet.closedAt ? (facts.sheet.closedById ? ('PERSON' as const) : ('SYSTEM' as const)) : null,
          closedById: facts.sheet.closedById,
          fileId: facts.sheet.fileId,
          documentId: document?.id ?? null,
          version: facts.sheet.version,
        }
      : null,
    shipments: shipments.map((row) => shipmentView(row, day, site.timeZone)),
    /** The sheet is closed: these left after it closed and go on the next day's sheet. */
    waiting: closed ? facts.toAdd.map((row) => shipmentView(row, day, site.timeZone)) : [],
    letGo: facts.letGo,
    stillPacked: facts.stillPacked,
    totals: sheetTotals(shipments),
    may: { close: { allowed: refusal === null, refusal } },
  }
}

/** The day asked for (default the site's today), refused when it is to come or too old. */
function dayAsked(asked: BusinessDate | undefined, today: BusinessDate): BusinessDate {
  const day = asked ?? today
  const refusal = closeDayRefusal(day, today)
  if (refusal) throw refused(refusal.code, refusal.message)
  return day
}

/** GET /shipping/end-of-day (see the file's comment). */
export async function endOfDay(caller: CommandCaller, query: { siteId: string; day?: BusinessDate | undefined }) {
  const site = await siteFor(caller, query.siteId, SHIPPING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timeZone)
  const day = dayAsked(query.day, today)
  return caller.withClient(async (db) => {
    const carriers = await readDay(db, site, day, today)
    const views = []
    for (const facts of carriers) views.push(await carrierView(db, facts, day, site))
    return {
      siteId: site.id,
      companyId: site.companyId,
      site: { code: site.code, name: site.name, timeZone: site.timeZone },
      day,
      today,
      carriers: views,
      /** Carriers with something to close now. */
      toClose: views.filter((view) => view.may.close.allowed).map((view) => view.carrierCode),
    }
  })
}

/** The PDF model of a carrier's sheet (the caller's client or the command's transaction). */
async function sheetModel(db: CommandTx, site: DaySite, carrierCode: string, day: BusinessDate, shipments: readonly SheetShipment[], closing: { sheetId: string | null; at: Date | null; bySystem: boolean }): Promise<ManifestSheet> {
  const company = await db.company.findUnique({ where: { id: site.companyId }, select: { legalName: true, tradeName: true } })
  const settings = await db.shippingSettings.findUnique({ where: { id: site.id }, select: { senderAddress: true } })
  const sender = (settings?.senderAddress ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof sender[key] === 'string' && (sender[key] as string).trim() !== '' ? (sender[key] as string).trim() : null)
  const cityLine = [text('postalCode'), text('city'), text('province') ? `(${text('province')})` : null, text('country')].filter((part) => part !== null).join(' ')
  const local = closing.at ? new Intl.DateTimeFormat('sv-SE', { timeZone: site.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(closing.at) : null
  return {
    companyName: company?.legalName ?? company?.tradeName ?? '',
    site: { code: site.code, name: site.name, address: [text('line1'), text('line2'), cityLine === '' ? null : cityLine].filter((line): line is string => line !== null) },
    carrier: { code: carrierCode, name: carrierNameFor('CARRIER', carrierCode) ?? carrierCode },
    day,
    sheetId: closing.sheetId,
    closedAt: local,
    closedBySystem: closing.bySystem,
    preview: closing.at === null,
    shipments,
  }
}

/** GET /shipping/end-of-day/preview: the sheet's PDF as it would close now (PREVIEW; stored nowhere). */
export async function previewSheetPdf(caller: CommandCaller, query: { siteId: string; carrierCode: string; day?: BusinessDate | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const site = await siteFor(caller, query.siteId, SHIPPING_VIEW)
  const today = businessDate(serverClock.now(), site.timeZone)
  const day = dayAsked(query.day, today)
  const model = await caller.withClient(async (db) => {
    const facts = (await readDay(db, site, day, today, query.carrierCode))[0]
    if (!facts) throw refused('NOTHING_TO_CLOSE')
    const closed = facts.sheet?.closedAt ? facts.sheet : null
    return sheetModel(db, site, facts.carrierCode, day, closed ? facts.onSheet : closingSet(facts), { sheetId: facts.sheet?.id ?? null, at: null, bySystem: false })
  })
  return { pdf: await manifestPdf(model), fileName: `preview-${sheetFileName(site.code, query.carrierCode, day)}` }
}

/** What closing one carrier's sheet did. */
export type SheetOutcome =
  | { readonly carrierCode: string; readonly closed: true; readonly manifestId: string; readonly documentId: string; readonly fileId: string; readonly shipments: number; readonly parcels: number; readonly letGo: string[] }
  | { readonly carrierCode: string; readonly closed: false; readonly refusal: { readonly code: DaySheetRefusalCode; readonly message: string } }

const lockSheet = (tx: CommandTx, siteId: string, carrierCode: string, day: BusinessDate) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.day-sheet', ${siteId}::uuid, ${carrierCode}::text, ${day}::text), 0))`

/**
 * Closes one carrier's sheet of a site's day (a person: actorId; the system: null). The PDF is painted and put in the store
 * first; the command re-reads the sheet under its lock and refuses DAY_CHANGED when what it would hold moved meanwhile (one
 * more try then). Shared by the close route and the system's close (closeDays.ts).
 */
export async function closeSheet(
  files: FilesRuntime,
  caller: CommandCaller,
  input: { readonly site: DaySite; readonly carrierCode: string; readonly day: BusinessDate; readonly bySystem: boolean; readonly idempotencyKey?: string | undefined; readonly settings?: CommandSettings | undefined },
): Promise<SheetOutcome> {
  const { site, carrierCode, day } = input
  for (let attempt = 1; ; attempt++) {
    const now = (input.settings?.clock ?? serverClock).now()
    const today = businessDate(now, site.timeZone)
    const read = await caller.withClient(async (db) => {
      const facts = (await readDay(db, site, day, today, carrierCode))[0] ?? null
      if (!facts) return null
      const refusal = closeRefusal(facts)
      if (refusal) return { facts, refusal, model: null }
      const sheetId = facts.sheet?.id ?? newId()
      const shipments = closingSet(facts)
      return { facts, refusal: null, sheetId, shipments, model: await sheetModel(db, site, carrierCode, day, shipments, { sheetId, at: now, bySystem: input.bySystem }) }
    })
    if (!read) return { carrierCode, closed: false, refusal: { code: 'NOTHING_TO_CLOSE', message: DAY_SHEET_WORDS.NOTHING_TO_CLOSE } }
    if (read.refusal) return { carrierCode, closed: false, refusal: read.refusal }
    const { facts, sheetId, shipments, model } = read as { facts: CarrierDay; sheetId: string; shipments: SheetShipment[]; model: ManifestSheet }
    const fingerprint = sheetFingerprint(carrierCode, day, [...shipments.map((row) => row.id), ...facts.letGo.map((row) => `-${row.id}`)])
    const pdf = await manifestPdf(model)
    const prepared = await putGeneratedFile(files, caller, {
      companyId: site.companyId,
      recordType: 'DispatchManifest',
      recordId: sheetId,
      kind: 'DOCUMENT',
      originalName: sheetFileName(site.code, carrierCode, day),
      contentType: 'application/pdf',
      body: pdf,
      visibility: ['OFFICE'],
    })
    const spec: CommandSpec = {
      name: 'shipping.closeDaySheet',
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${carrierCode}:${attempt}` : null,
      input: { siteId: site.id, carrierCode, day, fingerprint },
    }
    try {
      const work = async (tools: CommandTools) => {
        const { tx } = tools
        await lockSheet(tx, site.id, carrierCode, day)
        const again = (await readDay(tx, site, day, businessDate(tools.now, site.timeZone), carrierCode))[0] ?? null
        if (!again || (again.sheet?.closedAt ?? null) !== null) throw refused(again?.sheet?.closedAt ? 'ALREADY_CLOSED' : 'DAY_CHANGED')
        if ((again.sheet?.id ?? sheetId) !== sheetId || sheetFingerprint(carrierCode, day, [...closingSet(again).map((row) => row.id), ...again.letGo.map((row) => `-${row.id}`)]) !== fingerprint) throw refused('DAY_CHANGED')
        const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
        if (!again.sheet) await tx.dispatchManifest.create({ data: { id: sheetId, companyId: site.companyId, siteId: site.id, carrierCode, day: dateColumn(day), createdAt: tools.now, createdById: actorId }, select: { id: true } })
        if (again.letGo.length > 0) await tx.shipment.updateMany({ where: { id: { in: again.letGo.map((row) => row.id) }, manifestId: sheetId }, data: { manifestId: null } })
        const adds = again.toAdd.map((row) => row.id)
        if (adds.length > 0) {
          const { count } = await tx.shipment.updateMany({ where: { id: { in: adds }, manifestId: null }, data: { manifestId: sheetId } })
          if (count !== adds.length) throw refused('DAY_CHANGED')
        }
        const file = await recordGeneratedFile(tools, prepared, { details: { documentType: MANIFEST_KIND, carrierCode, day } })
        const documentId = newId()
        await tx.generatedDocument.create({
          data: { id: documentId, companyId: site.companyId, siteId: site.id, recordType: 'DispatchManifest', recordId: sheetId, kind: MANIFEST_KIND, version: 1, fingerprint, language: 'it', layout: 'manifest', number: null, fileId: file.id, createdAt: tools.now, createdById: actorId },
          select: { id: true },
        })
        // When it closed: the app's clock, never ahead of the database's (its rule refuses a close in the future).
        const databaseNow = (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`)[0]!.now
        const closedAt = tools.now.getTime() > databaseNow.getTime() ? databaseNow : tools.now
        await tx.dispatchManifest.update({ where: { id: sheetId }, data: { closedAt, closedById: actorId, fileId: file.id, version: { increment: 1 } }, select: { id: true } })
        const totals = sheetTotals(shipments)
        tools.audit({
          action: 'shipping.closeDaySheet',
          recordType: 'DispatchManifest',
          recordId: sheetId,
          companyId: site.companyId,
          siteId: site.id,
          after: { carrierCode, day, bySystem: input.bySystem, shipments: shipments.map((row) => row.number), parcels: totals.parcels, weightKg: totals.weightKg, letGo: again.letGo.map((row) => row.number), fileId: file.id, documentId },
        })
        tools.emit({ type: 'shipping.day_sheet_closed', subject: sheetId, companyId: site.companyId, siteId: site.id, payload: { manifestId: sheetId, siteId: site.id, carrierCode, day, shipments: totals.shipments, parcels: totals.parcels, bySystem: input.bySystem } })
        return { manifestId: sheetId, documentId, fileId: file.id, shipments: totals.shipments, parcels: totals.parcels, letGo: again.letGo.map((row) => row.number) }
      }
      const { result } = input.settings ? await runCommand(caller, spec, work, input.settings) : await command(caller, spec, work)
      return { carrierCode, closed: true, ...result }
    } catch (error) {
      const code = error instanceof DomainError ? error.issues?.[0]?.path : undefined
      if (code === daySheetRefusalPath('DAY_CHANGED') && attempt < 2) continue
      if (code === daySheetRefusalPath('ALREADY_CLOSED') || code === daySheetRefusalPath('DAY_CHANGED')) return { carrierCode, closed: false, refusal: { code: code.slice('refusal/'.length) as DaySheetRefusalCode, message: (error as DomainError).message } }
      throw error
    }
  }
}

export interface CloseDayBody {
  readonly siteId: string
  readonly day?: BusinessDate | undefined
  /** Default: every carrier with something to close. */
  readonly carrierCodes?: readonly string[] | undefined
  readonly print?: boolean | undefined
  readonly printerId?: string | undefined
}

/** POST /shipping/end-of-day/close (see the file's comment). */
export async function closeDay(files: FilesRuntime, caller: CommandCaller, body: CloseDayBody, idempotencyKey?: string) {
  const site = await siteFor(caller, body.siteId, SHIPPING_MANAGE)
  const today = businessDate(serverClock.now(), site.timeZone)
  const day = dayAsked(body.day, today)
  const asked = body.carrierCodes ? [...new Set(body.carrierCodes.map((code) => code.trim()))] : null
  if (asked && asked.length === 0) throw new ValidationError('Name at least one carrier, or none for every carrier.', [{ path: 'body/carrierCodes', message: 'At least one carrier.' }])
  const carriers = asked ?? (await caller.withClient(async (db) => (await readDay(db, site, day, today)).filter((facts) => closeRefusal(facts) === null).map((facts) => facts.carrierCode)))
  const outcomes: SheetOutcome[] = []
  for (const carrierCode of carriers) outcomes.push(await closeSheet(files, caller, { site, carrierCode, day, bySystem: false, idempotencyKey }))
  // The print jobs, after the close: a print that cannot be queued says why and the day stays closed.
  const printer = body.print === false ? null : body.printerId ?? (await caller.withClient((db) => db.shippingSettings.findUnique({ where: { id: site.id }, select: { documentPrinterId: true } })))?.documentPrinterId ?? null
  const closed = []
  for (const outcome of outcomes) {
    if (!outcome.closed) {
      closed.push({ ...outcome, printJob: null, printProblem: null })
      continue
    }
    let printJob: { id: string; status: string } | null = null
    let printProblem: string | null = null
    if (body.print !== false) {
      if (!printer) printProblem = 'The site has no document printer: print the manifest from its PDF window.'
      else {
        try {
          const job = await queueDocument(caller, { printerId: printer, fileId: outcome.fileId, copies: 1 }, idempotencyKey ? `${idempotencyKey}:print:${outcome.carrierCode}` : undefined)
          printJob = { id: job.id, status: job.status }
        } catch (error) {
          if (!(error instanceof DomainError)) throw error
          printProblem = `The manifest could not be sent to the printer (${error.message}): print it from its PDF window.`
        }
      }
    }
    closed.push({ ...outcome, printJob, printProblem })
  }
  return { siteId: site.id, day, outcomes: closed }
}

/** GET /shipping/manifests/:manifestId: one sheet, its shipments and its PDF's file. */
export async function getManifest(caller: CommandCaller, manifestId: string) {
  const context = officeContextOf(caller)
  const sheet = isUuid(manifestId) ? await caller.withClient((db) => db.dispatchManifest.findUnique({ where: { id: manifestId }, select: SHEET_SELECT })) : null
  assertMay(context, SHIPPING_VIEW, SHIPPING_VIEW, sheet ? { companyId: sheet.companyId, siteId: sheet.siteId } : null, 'Day sheet')
  const site = await siteFor(caller, sheet!.siteId, SHIPPING_VIEW)
  const day = dayOfColumn(sheet!.day)
  return caller.withClient(async (db) => {
    const rows = await db.shipment.findMany({ where: { manifestId: sheet!.id }, select: SHIPMENT_SELECT })
    const names = new Map((rows.length === 0 ? [] : await db.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.partyId))] } }, select: { id: true, legalName: true, tradeName: true } })).map((row) => [row.id, row.tradeName ?? row.legalName]))
    const shipments = inSheetOrder(rows.map((row) => shipmentOf(row, names)))
    const document = await documentOf(db, sheet!.id)
    return {
      manifest: {
        id: sheet!.id,
        siteId: sheet!.siteId,
        companyId: sheet!.companyId,
        site: { code: site.code, name: site.name },
        carrierCode: sheet!.carrierCode,
        carrierName: carrierNameFor('CARRIER', sheet!.carrierCode) ?? sheet!.carrierCode,
        day,
        state: sheet!.closedAt ? ('CLOSED' as const) : ('OPEN' as const),
        closedAt: iso(sheet!.closedAt),
        closedBy: sheet!.closedAt ? (sheet!.closedById ? ('PERSON' as const) : ('SYSTEM' as const)) : null,
        closedById: sheet!.closedById,
        fileId: sheet!.fileId,
        documentId: document?.id ?? null,
        version: sheet!.version,
        shipments: shipments.map((row) => shipmentView(row, day, site.timeZone)),
        totals: sheetTotals(shipments),
      },
    }
  })
}

/** GET /shipping/manifests/:manifestId/pdf: the closed sheet's PDF, a presigned download (files.read on the file too). */
export async function downloadManifestPdf(files: FilesRuntime, callers: Callers, manifestId: string) {
  const { manifest } = await getManifest(callers.caller, manifestId)
  if (!manifest.fileId) throw refused('NOT_CLOSED')
  return { file: await getFile(callers.caller, manifest.fileId), download: await downloadFile(files, callers, manifest.fileId) }
}
