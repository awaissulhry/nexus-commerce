import { bySubjectIn, defineIndexer, idWhere } from '../indexer'

/**
 * Maintenance jobs (modules/plant; plant.view; opens in Plant › Maintenance jobs): by number, the machine's asset number,
 * make and model and serial number. Scope as the jobs list: company and site. NEVER the technician it is assigned to or
 * who handed it back (workers, Statuto art. 4), and never the problem's or the work's words (people's words). Made,
 * changed, assigned and moved re-read it; a machine changed re-indexes its jobs.
 */
export default defineIndexer({
  recordType: 'MaintenanceJob',
  area: 'plant',
  viewPermission: 'plant.view',
  on: {
    'maintenance_job.created': 'subject',
    'maintenance_job.changed': 'subject',
    'maintenance_job.assigned': 'subject',
    'maintenance_job.moved': 'subject',
    'machine.changed': bySubjectIn((tx, machineId, take) => tx.maintenanceJob.findMany({ where: { machineId }, select: { id: true }, orderBy: { id: 'asc' }, take })),
  },
  async read(tx, filter, take) {
    const rows = await tx.maintenanceJob.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, companyId: true, siteId: true, number: true, status: true, machine: { select: { assetNumber: true, make: true, modelName: true, serialNumber: true } } },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.number,
      title: [row.machine.make, row.machine.modelName].filter(Boolean).join(' ') || row.machine.assetNumber,
      subtitle: row.machine.assetNumber,
      status: row.status,
      words: [row.machine.serialNumber],
    }))
  },
})
