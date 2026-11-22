import type { Prisma } from '@nexus/factory-db'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { lateDaysOf } from '@nexus/factory-domain/files/asks'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { myWorkOrders } from '../dispatch/mywork-messages'
import { customerCodesOf } from '../dispatch/world'
import { floorOf, systemView } from '../scans/access'
import type { Reader } from '../scans/store'

/**
 * B-OF-034 (order files tab; 13-backend §2; Owner D2; worker privacy W1, Statuto art. 4) — the office's asks for files on the tablet.
 *
 *   GET /production/floor-notes/asks   the OPEN asks of the tablet's own site addressed to the signed-in worker's live team (Worker →
 *                                      employee → TeamMember today), one of their live floor roles at the site (WorkerRole, not
 *                                      ended), or whoever works a step of a work order the station's queue or the person's day holds
 *                                      (My work's own list, dispatch/mywork-messages.ts `myWorkOrders`)
 *
 * The floor role reads no asks, teams or roles: after the floor's checks (production.scan at the device's site) the list is read through
 * the tenant's system view, as My work's messages are. What goes back: the ask's words (a floor ask is never priced nor body data:
 * the database refuses those), its kind, due day and how late (the site's day), the work order and its step, the customer's CODE, the
 * newest reason it was asked again and the last chase. Never a worker id or name, never a count per person, never "seen": nothing is
 * written. `answerableAsk` is the same filter for the note that answers one (./notes.ts).
 */

export const FLOOR_ASKS_MAX = 50

const FLOOR_ASK_COLUMNS = {
  id: true,
  siteId: true,
  salesOrderId: true,
  workOrderId: true,
  workOrderOperationId: true,
  words: true,
  fileKind: true,
  addressee: true,
  addresseeRoleId: true,
  addresseeTeamId: true,
  dueOn: true,
  status: true,
  lastReason: true,
  lastChasedAt: true,
  createdAt: true,
} as const
type FloorAskRow = Prisma.FileAskGetPayload<{ select: typeof FLOOR_ASK_COLUMNS }>

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

/** The teams the worker is in today and their live floor roles at the site (read as the system: the floor reads no People). */
async function whoTheWorkerIs(db: Reader, context: FloorContext, today: BusinessDate): Promise<{ readonly teamIds: string[]; readonly roleIds: string[] }> {
  const worker = await db.worker.findUnique({ where: { id: context.actorId }, select: { employeeId: true } })
  const day = new Date(`${today}T00:00:00.000Z`)
  const teamIds = worker?.employeeId
    ? (await db.teamMember.findMany({ where: { employeeId: worker.employeeId, siteId: context.siteId, since: { lte: day }, OR: [{ until: null }, { until: { gte: day } }] }, select: { teamId: true } })).map((row) => row.teamId)
    : []
  const roleIds = (await db.workerRole.findMany({ where: { siteId: context.siteId, workerId: context.actorId, endedAt: null }, select: { roleId: true } })).map((row) => row.roleId)
  return { teamIds: [...new Set(teamIds)], roleIds: [...new Set(roleIds)] }
}

/** The site's day (its time zone). */
async function siteDay(db: Reader, siteId: string, now: Date): Promise<BusinessDate> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { timezone: true } })
  return site ? businessDate(now, site.timezone) : businessDate(now)
}

/** GET /production/floor-notes/asks */
export async function floorAsks(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  const { numbers } = await myWorkOrders(caller, context, now)
  return systemView(caller).withClient(async (db: Reader) => {
    const today = await siteDay(db, context.siteId, now)
    const { teamIds, roleIds } = await whoTheWorkerIs(db, context, today)
    const rows = await db.fileAsk.findMany({
      where: {
        siteId: context.siteId,
        status: 'OPEN',
        OR: [
          { addressee: 'FLOOR_TEAM', addresseeTeamId: { in: teamIds } },
          { addressee: 'FLOOR_ROLE', addresseeRoleId: { in: roleIds } },
          { addressee: 'STEP', workOrderId: { in: [...numbers.keys()] } },
        ],
      },
      select: FLOOR_ASK_COLUMNS,
      orderBy: [{ dueOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: FLOOR_ASKS_MAX,
    })
    const workOrderIds = [...new Set(rows.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
    const stepIds = [...new Set(rows.flatMap((row) => (row.workOrderOperationId ? [row.workOrderOperationId] : [])))]
    const orders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds }, siteId: context.siteId }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const steps = new Map((stepIds.length > 0 ? await db.workOrderOperation.findMany({ where: { id: { in: stepIds } }, select: { id: true, seq: true, name: true } }) : []).map((row) => [row.id, row]))
    const customers = await customerCodesOf(db, workOrderIds)
    const asks = rows.flatMap((row: FloorAskRow) => {
      const number = row.workOrderId ? orders.get(row.workOrderId) : undefined
      if (!row.workOrderId || number === undefined) return []
      const step = row.workOrderOperationId ? steps.get(row.workOrderOperationId) : undefined
      return [
        {
          askId: row.id,
          words: row.words,
          fileKind: row.fileKind as 'DOCUMENT' | 'PHOTO' | 'ATTACHMENT',
          dueOn: dayOf(row.dueOn),
          lateDays: lateDaysOf(dayOf(row.dueOn), today),
          workOrder: { id: row.workOrderId, number },
          step: step ? { id: step.id, seq: step.seq, name: step.name } : null,
          customer: customers.get(row.workOrderId) ?? null,
          askedAgain: row.lastReason,
          chasedAt: row.lastChasedAt ? toUtcIso(row.lastChasedAt) : null,
        },
      ]
    })
    return { asOf: toUtcIso(now), asks }
  })
}

/**
 * The ask a floor note names, when this tablet may answer it with that note: OPEN, a floor ask of its own site and of THIS work order
 * (and of the note's step when both name one), addressed to the worker's team, one of their floor roles, or a step of this work order
 * (the work order in hand); null otherwise (closed meanwhile, another tablet's, unknown): the note then posts as any note.
 */
export async function answerableAsk(caller: CommandCaller, context: FloorContext, askId: string, workOrderId: string, operationId: string | null, now: Date): Promise<FloorAskRow | null> {
  return systemView(caller).withClient(async (db: Reader) => {
    const row = await db.fileAsk.findFirst({ where: { id: askId, siteId: context.siteId, workOrderId, status: 'OPEN' }, select: FLOOR_ASK_COLUMNS })
    if (!row) return null
    if (row.workOrderOperationId && operationId && row.workOrderOperationId !== operationId) return null
    if (row.addressee === 'STEP') return row
    const { teamIds, roleIds } = await whoTheWorkerIs(db, context, await siteDay(db, context.siteId, now))
    if (row.addressee === 'FLOOR_TEAM') return row.addresseeTeamId && teamIds.includes(row.addresseeTeamId) ? row : null
    if (row.addressee === 'FLOOR_ROLE') return row.addresseeRoleId && roleIds.includes(row.addresseeRoleId) ? row : null
    return null
  })
}
