import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PLANT_REPORT } from '@nexus/factory-domain/plant/permissions'
import { normalAssetNumber } from '@nexus/factory-domain/plant/rules'
import type { CommandCaller } from '../../../core/command'
import { assertMay, floorOf, scopeOf, type PlantContext } from '../access'
import { stationWordsAt } from '../checks'
import { openRequestsOf } from '../requests/requests'
import { machineCard, machineViews, readMachine, symptomBrief, MACHINE_FLOOR_COLUMNS, type MachineRow, type Reader } from '../store'

/**
 * The station's machine screens (B-W2a-35; QHS-178; design floor.machine SCR-179 "Which machine?", "What is wrong?"):
 * floor only, plant.report at the device's own site (every floor role). Nothing here names a person or a cost.
 *
 *   GET /plant/floor/machines[?code=]     the tablet's station, its machines as tiles (each with the symptoms of its
 *                                         class and of every class), the scanned tag's machine at this site in any state
 *                                         (`found`), and the station's banner in words (H1: a machine marked do-not-use)
 *   GET /plant/floor/machines/:machineId  one machine: its card (now, the open job, the last three jobs, the repeat-failure
 *                                         hint), its symptoms, its open requests and the station's banner
 *
 * The report itself is POST /plant/requests (../requests); a technician's My jobs is GET /plant/floor/jobs (../jobs).
 */

async function symptomsFor(client: Reader, classIds: readonly string[]) {
  const rows = await client.machineSymptom.findMany({
    where: { active: true, OR: [{ classId: null }, { classId: { in: [...classIds] } }] },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, classId: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, unsafe: true, needsDetail: true, active: true },
  })
  return (classId: string) => rows.filter((row) => row.classId === null || row.classId === classId).map(symptomBrief)
}

async function withSymptoms(client: Reader, context: PlantContext, rows: readonly MachineRow[]) {
  const views = await machineViews(client, rows, context)
  const symptoms = await symptomsFor(client, [...new Set(rows.map((row) => row.classId))])
  return views.map((view) => ({ ...view, symptoms: symptoms(view.class.id) }))
}

/** GET /plant/floor/machines. */
export async function floorMachines(caller: CommandCaller, query: { readonly code?: string | undefined }) {
  const context = floorOf(caller)
  return caller.withClient(async (client) => {
    const device = await client.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true, station: { select: { id: true, code: true, name: true } } } })
    const stationId = device?.stationId ?? null
    const scope = scopeOf(context, PLANT_REPORT) as Prisma.MachineWhereInput
    const rows = stationId ? ((await client.machine.findMany({ where: { AND: [scope, { stationId, status: { not: 'RETIRED' } }] }, orderBy: [{ assetNumber: 'asc' }], select: MACHINE_FLOOR_COLUMNS })) as MachineRow[]) : []
    const scanned = query.code ? ((await client.machine.findFirst({ where: { AND: [scope, { assetNumber: normalAssetNumber(query.code) }] }, select: MACHINE_FLOOR_COLUMNS })) as MachineRow | null) : null
    const [machines, found] = [await withSymptoms(client, context, rows), scanned ? (await withSymptoms(client, context, [scanned]))[0]! : null]
    return {
      station: device?.station ? { id: device.station.id, code: device.station.code, name: device.station.name } : null,
      machines,
      found,
      words: await stationWordsAt(client, stationId, scanned?.id),
    }
  })
}

/** GET /plant/floor/machines/:machineId. */
export async function floorMachine(caller: CommandCaller, machineId: string) {
  const context = floorOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const machine = isUuid(machineId) ? await readMachine(client, context, machineId) : null
    if (!machine) throw new NotFoundError('No such machine at this site.')
    assertMay(context, PLANT_REPORT, machine, 'Machine')
    const device = await client.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true } })
    const symptoms = await symptomsFor(client, [machine.classId])
    return {
      card: (await machineCard(client, context, machine.id, now, { lastJobs: 3 }))!,
      symptoms: symptoms(machine.classId),
      openRequests: await openRequestsOf(client, context, machine.id, now),
      words: await stationWordsAt(client, device?.stationId ?? machine.stationId, machine.id),
    }
  })
}
