import type { Prisma } from '@nexus/factory-db'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { MACHINE_RECORD } from '@nexus/factory-domain/plant/machines/documents'
import { MACHINE_TAG_KIND } from '@nexus/factory-domain/plant/machines/tag'
import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { MachineStatus } from '@nexus/factory-domain/plant/rules'
import { dateOf, dayOf, dueStateOf } from '@nexus/factory-domain/plant/statutory/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeOf, scopeOf, type PlantContext } from '../access'
import { classBrief, locksOf, machineViews, MACHINE_COLUMNS, wordsOf, type MachineRow, type Reader } from '../store'

/**
 * The register's depth (B-W2b-136; design plant.machines tiles "Checks overdue" and "No CE declaration on file", columns
 * "Next check", "CE on file", "Tag printed", section "Status wall"), office reads with plant.view, each machine checked by
 * the scope of the caller's grants:
 *
 *   GET /plant/machines/depth?siteId=&ids=      the two tiles over the machines in use, and for the machines named (the
 *                                               page on screen) their CE declaration, manuals, next statutory check and
 *                                               newest tag sent to a label printer
 *   GET /plant/machines/attention?need=CE|CHECKS the machines in use without a CE declaration on file, or with a
 *                                               statutory check overdue (the tiles as filters), asset number order, pages
 *   GET /plant/machines/wall?siteId=            every machine in use as a tile, by line: asset number, status, since
 *
 * "In use" = not RETIRED. A machine with no plan has no next check; a CE declaration counts only once AVAILABLE.
 */

type DepthReader = Reader & Pick<CommandTx, 'machineCheckPlan' | 'printJob'>

const inUse = (context: PlantContext, siteId: string | undefined): Prisma.MachineWhereInput => ({
  AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, siteId ? { siteId } : {}, { status: { not: 'RETIRED' } }],
})

/** The machines (of those named) with an available CE declaration, and their available manuals. */
async function documentsOf(db: DepthReader, ids: readonly string[]): Promise<{ ce: Set<string>; manuals: Map<string, number> }> {
  const ce = new Set<string>()
  const manuals = new Map<string, number>()
  if (ids.length === 0) return { ce, manuals }
  const rows = await db.storedFile.groupBy({
    by: ['recordId', 'category'],
    where: { recordType: MACHINE_RECORD, recordId: { in: [...ids] }, status: 'AVAILABLE', category: { in: ['MACHINE_CE', 'MANUAL'] } },
    _count: { _all: true },
  })
  for (const row of rows) {
    if (row.category === 'MACHINE_CE') ce.add(row.recordId)
    else manuals.set(row.recordId, row._count._all)
  }
  return { ce, manuals }
}

/** The machines (ids) with an ACTIVE check plan due before today. */
async function overdueOf(db: DepthReader, where: Prisma.MachineWhereInput, today: string): Promise<string[]> {
  const rows = await db.machineCheckPlan.findMany({ where: { status: 'ACTIVE', nextDueOn: { lt: dateOf(today) }, machine: where }, distinct: ['machineId'], select: { machineId: true } })
  return rows.map((row) => row.machineId)
}

export async function machineDepth(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly ids?: readonly string[] | undefined }) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const db = client as unknown as DepthReader
    const where = inUse(context, query.siteId)
    const machines = await db.machine.findMany({ where, select: { id: true } })
    const all = machines.map((row) => row.id)
    const withCe = all.length === 0 ? new Set<string>() : (await documentsOf(db, all)).ce
    const overdue = await overdueOf(db, where, today)
    const named = query.ids && query.ids.length > 0 ? (await db.machine.findMany({ where: { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, { id: { in: [...query.ids] } }] }, select: { id: true } })).map((row) => row.id) : []
    const docs = await documentsOf(db, named)
    const plans = named.length === 0 ? [] : await db.machineCheckPlan.findMany({
      where: { status: 'ACTIVE', machineId: { in: named } },
      orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }],
      select: { id: true, machineId: true, nextDueOn: true, status: true, checkType: { select: { code: true, labelIt: true, labelEn: true, labelI18n: true } } },
    })
    const jobs = named.length === 0 ? [] : await db.printJob.findMany({
      where: { recordType: MACHINE_RECORD, recordId: { in: named }, labelKind: MACHINE_TAG_KIND },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, recordId: true, status: true, createdAt: true, printedAt: true },
    })
    return {
      tiles: { checksOverdue: overdue.length, noCe: all.filter((id) => !withCe.has(id)).length },
      machines: named.map((id) => {
        const plan = plans.find((row) => row.machineId === id) ?? null
        const job = jobs.find((row) => row.recordId === id) ?? null
        const due = plan ? dueStateOf({ status: plan.status, nextDueOn: dayOf(plan.nextDueOn) }, today) : null
        return {
          id,
          ceOnFile: docs.ce.has(id),
          manuals: docs.manuals.get(id) ?? 0,
          nextCheck: plan && due ? { planId: plan.id, nextDueOn: dayOf(plan.nextDueOn), state: due.state, days: due.days, checkType: { code: plan.checkType.code, labelIt: plan.checkType.labelIt, labelEn: plan.checkType.labelEn, labelI18n: wordsOf(plan.checkType.labelI18n) } } : null,
          tag: job ? { state: job.status, jobId: job.id, at: toUtcIso(job.createdAt), printedAt: job.printedAt ? toUtcIso(job.printedAt) : null } : null,
        }
      }),
      today,
    }
  })
}

const SORT: Prisma.MachineOrderByWithRelationInput[] = [{ assetNumber: 'asc' }, { id: 'asc' }]

export async function machinesNeeding(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly need: 'CE' | 'CHECKS'; readonly cursor?: string | undefined; readonly limit: number }) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const db = client as unknown as DepthReader
    const where = inUse(context, query.siteId)
    let picked: Prisma.MachineWhereInput
    if (query.need === 'CHECKS') picked = { id: { in: await overdueOf(db, where, today) } }
    else {
      const all = (await db.machine.findMany({ where, select: { id: true } })).map((row) => row.id)
      picked = { id: { notIn: [...(await documentsOf(db, all)).ce] } }
    }
    let after: Prisma.MachineWhereInput = {}
    if (query.cursor) {
      const last = await db.machine.findUnique({ where: { id: query.cursor }, select: { assetNumber: true, id: true } })
      if (last) after = { OR: [{ assetNumber: { gt: last.assetNumber } }, { assetNumber: last.assetNumber, id: { gt: last.id } }] }
    }
    const rows = (await db.machine.findMany({ where: { AND: [where, picked, after] }, orderBy: SORT, take: query.limit + 1, select: MACHINE_COLUMNS })) as MachineRow[]
    const page = rows.slice(0, query.limit)
    return { machines: await machineViews(db, page, context), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** The most tiles one wall draws (a hall of machines; the rest is said). */
const WALL_MAX = 1000

export async function statusWall(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const db = client as unknown as DepthReader
    const rows = (await db.machine.findMany({ where: inUse(context, query.siteId), orderBy: SORT, take: WALL_MAX + 1, select: MACHINE_COLUMNS })) as MachineRow[]
    const page = rows.slice(0, WALL_MAX)
    const locks = await locksOf(db, page.map((row) => row.id))
    type Tile = { id: string; assetNumber: string; siteCode: string; class: ReturnType<typeof classBrief>; station: { id: string; code: string; name: string } | null; status: MachineStatus; statusSince: string; locked: boolean }
    const groups = new Map<string, { line: { id: string; code: string; name: string } | null; siteCode: string; machines: Tile[] }>()
    const counts = { RUNNING: 0, DOWN: 0, UNDER_MAINTENANCE: 0, DO_NOT_USE: 0, locked: 0 }
    for (const row of page) {
      const line = row.station?.line ?? null
      const key = line ? `line:${line.id}` : `site:${row.siteId}`
      if (!groups.has(key)) groups.set(key, { line: line ? { id: line.id, code: line.code, name: line.name } : null, siteCode: row.site.code, machines: [] })
      const locked = locks.has(row.id)
      const status = row.status as MachineStatus
      if (status !== 'RETIRED') counts[status] += 1
      if (locked) counts.locked += 1
      groups.get(key)!.machines.push({
        id: row.id,
        assetNumber: row.assetNumber,
        siteCode: row.site.code,
        class: classBrief(row.machineClass),
        station: row.station ? { id: row.station.id, code: row.station.code, name: row.station.name } : null,
        status,
        statusSince: toUtcIso(row.statusSince),
        locked,
      })
    }
    const lines = [...groups.values()].sort((a, b) => (a.siteCode === b.siteCode ? (a.line ? (b.line ? a.line.code.localeCompare(b.line.code) : -1) : b.line ? 1 : 0) : a.siteCode.localeCompare(b.siteCode)))
    return { lines, counts, truncated: rows.length > WALL_MAX, at: toUtcIso(serverClock.now()) }
  })
}
