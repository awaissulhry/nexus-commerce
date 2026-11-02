import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { versionStateOf } from '@nexus/factory-domain/people/piecerates/rates'
import { PEOPLE_PIECERATES_VIEW } from '@nexus/factory-domain/people/piecerates/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeOf } from './access'
import { versionRowOf, VERSION_SELECT } from './store'

/**
 * The employee record's Pay tab, "Rates published and read" (B-W2b-62; design people.employees rec:Employee/pay sec:rates-read;
 * c.c. art. 2101 c.3): one person's proof that they saw the rates before work started: each publication to one of their floor
 * sign-ins, with their own reading (when, on the floor or on paper, on which device). Inside one record, no rate and no
 * figure: what the version's own record shows of them, for the same permission.
 */
export async function employeePublications(caller: CommandCaller, employeeId: string) {
  const context = officeOf(caller)
  const person = isUuid(employeeId) ? await caller.withClient((db) => db.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!person || !can(actorOf(context), PEOPLE_PIECERATES_VIEW, { companyId: person.companyId, siteId: person.siteId })) throw new NotFoundError('Person not found.')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const workers = await db.worker.findMany({ where: { employeeId }, select: { id: true } })
    const workerIds = workers.map((row) => row.id)
    const rows = workerIds.length === 0 ? [] : await db.ratePublication.findMany({ where: { status: 'PUBLISHED', workerIds: { hasSome: workerIds } }, select: { id: true, versionId: true, publishedAt: true, onFloor: true, printed: true }, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }], take: 100 })
    const versions = rows.length === 0 ? [] : await db.pieceRateVersion.findMany({ where: { id: { in: rows.map((row) => row.versionId) } }, select: VERSION_SELECT })
    const versionById = new Map(versions.map((row) => [row.id, row]))
    const tables = versions.length === 0 ? [] : await db.pieceRateTable.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.tableId))] } }, select: { id: true, code: true, name: true } })
    const tableById = new Map(tables.map((row) => [row.id, row]))
    const receipts = rows.length === 0 ? [] : await db.rateAcknowledgement.findMany({ where: { publicationId: { in: rows.map((row) => row.id) }, employeeId }, select: { publicationId: true, channel: true, serverTime: true, deviceId: true }, orderBy: { serverTime: 'asc' } })
    const deviceIds = [...new Set(receipts.flatMap((row) => (row.deviceId ? [row.deviceId] : [])))]
    const devices = deviceIds.length === 0 ? [] : await db.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, name: true } })
    const deviceById = new Map(devices.map((row) => [row.id, row.name]))
    return {
      employeeId,
      publications: rows.flatMap((row) => {
        const version = versionById.get(row.versionId)
        const table = version ? tableById.get(version.tableId) : undefined
        if (!version || !table) return []
        const rules = versionRowOf(version)
        const read = receipts.find((receipt) => receipt.publicationId === row.id) ?? null
        return [
          {
            id: row.id,
            versionId: version.id,
            versionNo: version.versionNo,
            table: { code: table.code, name: table.name },
            state: versionStateOf(rules, today).state,
            effectiveFrom: rules.effectiveFrom,
            publishedAt: toUtcIso(row.publishedAt),
            onFloor: row.onFloor,
            printed: row.printed,
            read: read ? { at: toUtcIso(read.serverTime), channel: read.channel as 'DEVICE' | 'PAPER', device: read.deviceId ? (deviceById.get(read.deviceId) ?? null) : null } : null,
          },
        ]
      }),
    }
  })
}
