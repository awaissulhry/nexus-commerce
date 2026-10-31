import { defineIndexer, idWhere } from '../indexer'

/**
 * Machines (modules/plant; plant.view; opens in Plant › Machines): by asset number, make and model, serial number, its
 * class (its code and its Italian and English words, so either language finds it), the station and work centre it
 * stands at. Scope as the machines list: company and site. NEVER its purchase cost.
 * Registered, changed and its status moved (down, under maintenance, do not use, running again, retired) re-read it.
 */
export default defineIndexer({
  recordType: 'Machine',
  area: 'plant',
  viewPermission: 'plant.view',
  on: {
    'machine.registered': 'subject',
    'machine.changed': 'subject',
    'machine.status_changed': 'subject',
  },
  async read(tx, filter, take) {
    const rows = await tx.machine.findMany({
      where: idWhere(filter),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        companyId: true,
        siteId: true,
        assetNumber: true,
        make: true,
        modelName: true,
        serialNumber: true,
        status: true,
        machineClass: { select: { code: true, labelIt: true, labelEn: true } },
        station: { select: { code: true } },
        workCentre: { select: { code: true } },
      },
    })
    return rows.map((row) => ({
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      partyId: null,
      number: row.assetNumber,
      // Its make and model; a machine without them by its class's code (the number stays its name otherwise).
      title: [row.make, row.modelName].filter(Boolean).join(' ') || row.machineClass.code,
      subtitle: row.station?.code ?? row.workCentre?.code ?? null,
      status: row.status,
      words: [row.serialNumber, row.machineClass.code, row.machineClass.labelIt, row.machineClass.labelEn, row.workCentre?.code],
    }))
  },
})
