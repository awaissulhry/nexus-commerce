import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_SCAN } from '@nexus/factory-domain/production/scans/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorOf } from '../scans/access'
import type { Reader } from '../scans/store'
import { departmentLooks } from './store'

/**
 * POST /floor/session/department (owb- order workflow, S5 fl1; LF _owb-fl-common.md § 2 settle 2, § 3 "fl1"; lead 88's yes to
 * web B's ask: an optional `stationId`): a phone's "where am I". The worker picks a department; the session keeps it
 * (FloorSession.departmentId) with the station it takes (FloorSession.stationId): an ACTIVE station of the device's site
 * whose work centre has the department's kind — one: taken; several: none taken yet, `choose` lists their names once and the
 * phone sends the pick again with `stationId`; none: none taken (the phone says "This department has no station at this site.
 * Ask the office to add one."). Both end with the session (a new session starts with none).
 *
 * Scans never read the session's station (settle 2: they keep the device's); help calls read it (server B's calls/store).
 * Floor, production.scan, the device's own session at its own site; the department one of the factory's open departments (of
 * the site's company, or of the whole factory). One command, audited (floor.session.pickDepartment), never a name.
 */

export interface PickInput {
  readonly departmentId: string
  readonly stationId?: string | undefined
}

export async function pickDepartment(caller: CommandCaller, body: PickInput, idempotencyKey?: string) {
  const context = floorOf(caller)
  if (!holds(actorOf(context), PRODUCTION_SCAN)) throw new ForbiddenError('A department is picked on a floor device signed in to scan.')
  const facts = await caller.withClient(async (db: Reader) => {
    const department = await db.department.findUnique({ where: { id: body.departmentId }, select: { id: true, companyId: true, status: true, workCentreKind: true } })
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    if (!site || !department || department.status !== 'ACTIVE' || (department.companyId !== null && department.companyId !== site.companyId)) {
      throw new NotFoundError('This is not one of the factory’s open departments: pick another one.')
    }
    const look = (await departmentLooks(db)).find((entry) => entry.id === department.id)!
    const centres = await db.workCentre.findMany({ where: { siteId: context.siteId, kind: department.workCentreKind }, select: { id: true } })
    const stations = centres.length === 0 ? [] : await db.station.findMany({ where: { siteId: context.siteId, status: 'ACTIVE', workCentreId: { in: centres.map((centre) => centre.id) } }, select: { id: true, name: true }, orderBy: [{ code: 'asc' }] })
    const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { currentSessionId: true } })
    return { look, companyId: site.companyId, stations, sessionId: device?.currentSessionId ?? null }
  })
  if (!facts.sessionId) throw new ForbiddenError('Sign in on this device first.')
  if (body.stationId !== undefined && !facts.stations.some((station) => station.id === body.stationId)) {
    throw new ValidationError('Pick one of this department’s stations at this site.', [{ path: 'body/stationId', message: 'Not an active station of this department at this site.' }])
  }
  const station = body.stationId !== undefined ? facts.stations.find((entry) => entry.id === body.stationId)! : facts.stations.length === 1 ? facts.stations[0]! : null
  const choose = station === null && facts.stations.length > 1 ? facts.stations : []
  const minute = Math.floor(serverClock.now().getTime() / 60_000)
  const sessionId = facts.sessionId
  await command(
    caller,
    { name: 'floor.session.pickDepartment', idempotencyKey: idempotencyKey ?? `${context.deviceId}.department.${body.departmentId}.${station?.id ?? 'none'}.${minute}`, input: body },
    async (tools) => {
      await tools.tx.floorSession.update({ where: { id: sessionId }, data: { departmentId: facts.look.id, stationId: station?.id ?? null }, select: { id: true } })
      tools.audit({ action: 'floor.session.pickDepartment', recordType: 'FloorSession', recordId: sessionId, companyId: facts.companyId, siteId: context.siteId, after: { departmentId: facts.look.id, stationId: station?.id ?? null } })
      return { sessionId }
    },
  )
  return { department: facts.look, station: station ? { id: station.id, name: station.name } : null, choose: choose.map((entry) => ({ id: entry.id, name: entry.name })) }
}
