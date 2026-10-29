import type { Prisma } from '@nexus/factory-db'
import { PRINT_MANAGE, PRINT_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import type { StationPrinterView } from './contract'
import { contextOf, readPrinter } from './printers'

/**
 * The station label printer (MES-184; A2 Admin › Devices & printers): a station names the label printer of its site
 * where the floor devices at it print their bundle tickets when they name no printer (modules/production/bundles).
 * Listed by every audience that prints (a floor device: its own site's stations, row-level security), set by
 * print.manage over the station's company and site: a label printer (LABEL_ZPL) of the station's site that is not
 * archived (the …_production_leftovers_guards Station trigger holds the same), or none. ONE command on the station
 * (its version), audited before and after.
 */

const STATION_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, status: true, labelPrinterId: true, version: true, updatedAt: true } as const satisfies Prisma.StationSelect
type StationRow = Prisma.StationGetPayload<{ select: typeof STATION_SELECT }>

export function stationPrinterView(row: StationRow): StationPrinterView {
  return { id: row.id, companyId: row.companyId, siteId: row.siteId, code: row.code, name: row.name, status: row.status, labelPrinterId: row.labelPrinterId, version: row.version, updatedAt: toUtcIso(row.updatedAt) }
}

/** The stations the caller may see (print.view), with their label printer, by site and code. */
export async function listStationPrinters(caller: CommandCaller, query: { readonly siteId?: string | undefined }): Promise<StationPrinterView[]> {
  const context = contextOf(caller)
  const where: Prisma.StationWhereInput = {
    AND: [scopeWhere(actorOf(context), PRINT_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.StationWhereInput, query.siteId ? { siteId: query.siteId } : {}],
  }
  const rows = await caller.withClient((client) => client.station.findMany({ where, select: STATION_SELECT, orderBy: [{ siteId: 'asc' }, { code: 'asc' }], take: 500 }))
  return rows.map(stationPrinterView)
}

export interface SetStationPrinter {
  /** A label printer of the station's site; null: none (the site's only label printer then, if it has one). */
  readonly printerId: string | null
  readonly version: number
}

/** print.setStationPrinter: the station's label printer, or none. The same printer again changes nothing. */
export async function setStationPrinter(caller: CommandCaller, stationId: string, input: SetStationPrinter, idempotencyKey?: string) {
  const context = contextOf(caller)
  const station = isUuid(stationId) ? await caller.withClient((client) => client.station.findUnique({ where: { id: stationId }, select: STATION_SELECT })) : null
  const scope = station ? { companyId: station.companyId, siteId: station.siteId } : null
  if (!station || !scope || !can(actorOf(context), PRINT_VIEW, scope)) throw new NotFoundError('Station not found.')
  if (!can(actorOf(context), PRINT_MANAGE, scope)) throw new ForbiddenError()
  if (input.printerId !== null) {
    const printer = await readPrinter(caller, input.printerId)
    if (printer.siteId !== station.siteId || printer.kind !== 'LABEL_ZPL') {
      throw new ValidationError('A station prints its tickets on a label printer of its own site.', [{ path: 'body/printerId', message: "Pick a label printer of the station's site, or null for none." }])
    }
    if (printer.status === 'ARCHIVED') throw new ValidationError(`Printer ${printer.code} is archived: pick a printer in use.`, [{ path: 'body/printerId', message: 'Pick a printer that is not archived.' }])
  }
  if (station.labelPrinterId === input.printerId) return { station: stationPrinterView(station), changed: false }
  const { result } = await command(
    caller,
    { name: 'print.setStationPrinter', idempotencyKey, input: { stationId, ...input }, record: { type: 'Station', id: stationId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.station.update({ where: { id: stationId }, data: { labelPrinterId: input.printerId }, select: STATION_SELECT })
      audit({ recordType: 'Station', recordId: stationId, ...scope, before: { labelPrinterId: station.labelPrinterId }, after: { labelPrinterId: row.labelPrinterId } })
      return { station: stationPrinterView(row), changed: true }
    },
  )
  return result
}
