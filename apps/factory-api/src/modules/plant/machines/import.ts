import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { fromMinorUnits, isCurrencyCode, minorPlaces, toMinorUnits } from '@nexus/factory-domain/core/money'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { RowIssue } from '@nexus/factory-domain/imports/importer'
import { PLANT_MACHINES_MANAGE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { importRecordValues, machinesImporter } from '@nexus/factory-domain/plant/importer'
import { normalAssetNumber, type MachineStatus } from '@nexus/factory-domain/plant/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { mayWrite } from '../../product/materials/store'
import { auditedMachine } from '../store'

/**
 * The machines import's adapter (B-W2b-25; platform/imports; factory-domain plant/importer.ts `machinesImporter`, key
 * `plant.machines`; the B-W2a-53 gap: Plant › Machines & tools ⋯ "Import machines"): the dry run's plan is the domain's;
 * this loads the machines the asset numbers find (any company: the number is unique in the group; another company's is a
 * row error), checks the codes each row names, and writes one planned row inside the batch's command with its audit row
 * (`plant.importMachine`, the cost marked) and its event, as the register's routes do (machines.ts):
 *
 *   a new machine     at the row's site (of the job's company, ACTIVE), RUNNING since now, with its class (active), its
 *                     place (a station and a work centre of that site, ACTIVE), its supplier (a SUPPLIER party) and cost
 *                     (the company's currency, minor units); `machine.registered`
 *   a known machine   the row's changed facts, its row locked first (the plant's one lock order), its version moved;
 *                     `machine.changed` with the fields' names
 *
 * Running and applying it needs plant.machines.manage, seeing its plans plant.view (the engine checks both against the job's
 * company); each row's site must be one the person keeps machines at (can() with the company and site); a job for every
 * company needs plant.machines.manage over every company. The purchase cost column carries the cost grain.
 */

const ACTION = 'plant.importMachine'

/** Stops the batch: a code the row names changed since the dry run. */
class ImportRowRefused extends ApiError {
  constructor(assetNumber: string, detail: string) {
    super('conflict', `The import row for machine ${assetNumber} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  assetNumber: true,
  classId: true,
  make: true,
  modelName: true,
  serialNumber: true,
  year: true,
  stationId: true,
  workCentreId: true,
  supplierId: true,
  purchaseCost: true,
  note: true,
  status: true,
  version: true,
} as const satisfies Prisma.MachineSelect
type Row = Prisma.MachineGetPayload<{ select: typeof COLUMNS }>

const text = (value: CellValue | undefined): string | undefined => (value === undefined ? undefined : String(value))
const currencyOf = (currency: string | null | undefined): string => (currency && isCurrencyCode(currency) ? currency : 'EUR')
const costText = (amount: number | null, currency: string): string | null => (amount === null ? null : decimalText(fromMinorUnits(amount, currencyOf(currency)).toFixed()))

/** The codes the machines name, one query per kind. */
async function codesOf(client: CommandTx, rows: readonly Row[]) {
  const ids = (pick: (row: Row) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const byId = (list: readonly { id: string; code: string }[]) => new Map(list.map((entry) => [entry.id, entry.code]))
  return {
    sites: byId(await client.site.findMany({ where: { id: { in: ids((row) => row.siteId) } }, select: { id: true, code: true } })),
    classes: byId(await client.machineClass.findMany({ where: { id: { in: ids((row) => row.classId) } }, select: { id: true, code: true } })),
    stations: byId(await client.station.findMany({ where: { id: { in: ids((row) => row.stationId) } }, select: { id: true, code: true } })),
    centres: byId(await client.workCentre.findMany({ where: { id: { in: ids((row) => row.workCentreId) } }, select: { id: true, code: true } })),
    suppliers: byId(await client.party.findMany({ where: { id: { in: ids((row) => row.supplierId) } }, select: { id: true, code: true } })),
    currencies: new Map((await client.company.findMany({ where: { id: { in: ids((row) => row.companyId) } }, select: { id: true, currency: true } })).map((entry) => [entry.id, entry.currency])),
  }
}

/** The site, place, class and supplier codes a row names, resolved on the row's site (null where a code finds nothing fitting). */
interface Resolved {
  readonly site: { readonly id: string; readonly code: string; readonly companyId: string; readonly status: string; readonly currency: string } | null
  readonly issues: RowIssue[]
  readonly classId?: string
  readonly stationId?: string
  readonly workCentreId?: string
  readonly supplierId?: string
}

/**
 * What a row's codes find, with the problems in words: the site (the machine's own for a known one) of the job's company,
 * ACTIVE and kept by the person; a class (active when newly chosen); a station and a work centre of that site, ACTIVE; a
 * SUPPLIER party.
 */
async function resolve(client: CommandTx, row: { readonly values: Readonly<Record<string, CellValue>> }, machine: Row | null, scope: ImportScope, actor: Actor | null): Promise<Resolved> {
  const issues: RowIssue[] = []
  const siteCode = text(row.values.site)
  const siteRow = machine
    ? await client.site.findUnique({ where: { id: machine.siteId }, select: { id: true, code: true, companyId: true, status: true } })
    : siteCode
      ? await client.site.findFirst({ where: { code: siteCode, ...(scope.companyId ? { companyId: scope.companyId } : {}) }, select: { id: true, code: true, companyId: true, status: true } })
      : null
  if (!siteRow) {
    issues.push({ column: 'site', message: `Site ${siteCode ?? ''} is not a site of the import's company.` })
    return { site: null, issues }
  }
  if (!machine && siteRow.status !== 'ACTIVE') issues.push({ column: 'site', message: `Site ${siteRow.code} is archived.` })
  if (actor && !can(actor, PLANT_MACHINES_MANAGE, { companyId: siteRow.companyId, siteId: siteRow.id })) {
    issues.push({ column: 'site', message: `Machines of site ${siteRow.code} are kept by a role with plant.machines.manage there.` })
  }
  const company = await client.company.findUnique({ where: { id: siteRow.companyId }, select: { currency: true } })
  const site = { ...siteRow, currency: currencyOf(company?.currency) }
  const out: { classId?: string; stationId?: string; workCentreId?: string; supplierId?: string } = {}

  const classCode = text(row.values.machineClass)
  if (classCode !== undefined) {
    const found = await client.machineClass.findFirst({ where: { code: classCode }, select: { id: true, active: true } })
    if (!found) issues.push({ column: 'machineClass', message: `No machine class ${classCode} in the group's list.` })
    else if (!found.active && found.id !== machine?.classId) issues.push({ column: 'machineClass', message: `Class ${classCode} is retired: pick an active one.` })
    else out.classId = found.id
  }
  const stationCode = text(row.values.station)
  if (stationCode !== undefined) {
    const found = await client.station.findFirst({ where: { siteId: site.id, code: stationCode }, select: { id: true, status: true } })
    if (!found) issues.push({ column: 'station', message: `Site ${site.code} has no station ${stationCode}.` })
    else if (found.status !== 'ACTIVE') issues.push({ column: 'station', message: `Station ${stationCode} is archived.` })
    else out.stationId = found.id
  }
  const centreCode = text(row.values.workCentre)
  if (centreCode !== undefined) {
    const found = await client.workCentre.findFirst({ where: { siteId: site.id, code: centreCode }, select: { id: true, status: true } })
    if (!found) issues.push({ column: 'workCentre', message: `Site ${site.code} has no work centre ${centreCode}.` })
    else if (found.status !== 'ACTIVE') issues.push({ column: 'workCentre', message: `Work centre ${centreCode} is archived.` })
    else out.workCentreId = found.id
  }
  const supplierCode = text(row.values.supplier)
  if (supplierCode !== undefined) {
    const found = await client.party.findFirst({ where: { code: supplierCode }, select: { id: true, roles: true } })
    if (!found) issues.push({ column: 'supplier', message: `No party ${supplierCode}.` })
    else if (!found.roles.includes('SUPPLIER')) issues.push({ column: 'supplier', message: `${supplierCode} is not a supplier.` })
    else out.supplierId = found.id
  }
  const cost = text(row.values.purchaseCost)
  if (cost !== undefined && (cost.split('.')[1] ?? '').replace(/0+$/, '').length > minorPlaces(site.currency as never)) {
    issues.push({ column: 'purchaseCost', message: `At most ${minorPlaces(site.currency as never)} decimals in ${site.currency}.` })
  }
  return { site, issues, ...out }
}

const toMinor = (value: string, currency: string): number => toMinorUnits(value, currencyOf(currency))

export const machinesImportAdapter = Object.freeze({
  importer: machinesImporter,
  permission: PLANT_MACHINES_MANAGE,
  viewPermission: PLANT_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PLANT_MACHINES_MANAGE, null)) {
      return [{ path: 'companyId', message: 'A machines import for every company needs plant.machines.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async check(client, rows, scope, actor) {
    const machines = new Map((await client.machine.findMany({ where: { assetNumber: { in: rows.map((row) => normalAssetNumber(String(row.key.assetNumber))) } }, select: COLUMNS })).map((row) => [row.assetNumber, row]))
    const out: RowIssue[][] = []
    // One row after another: a transaction runs one query at a time.
    for (const row of rows as readonly CheckRow[]) {
      const machine = machines.get(normalAssetNumber(String(row.key.assetNumber))) ?? null
      // Another company's machine, and a new one without its site or class: the plan's to refuse (a row this check
      // refuses is an error with these issues only).
      if ((machine && scope.companyId !== null && machine.companyId !== scope.companyId) || (!machine && (row.values.site === undefined || row.values.machineClass === undefined))) {
        out.push([])
        continue
      }
      out.push((await resolve(client, row, machine, scope, actor)).issues)
    }
    return out
  },

  async load(client, keys, scope) {
    const rows = await client.machine.findMany({ where: { assetNumber: { in: keys.map((key) => normalAssetNumber(String(key.assetNumber))) } }, select: COLUMNS })
    const codes = await codesOf(client, rows)
    return rows.map((row) => ({
      id: row.id,
      values: importRecordValues({
        columns: {
          assetNumber: row.assetNumber,
          site: codes.sites.get(row.siteId) ?? null,
          machineClass: codes.classes.get(row.classId) ?? null,
          make: row.make,
          modelName: row.modelName,
          serialNumber: row.serialNumber,
          year: row.year,
          station: row.stationId === null ? null : (codes.stations.get(row.stationId) ?? null),
          workCentre: row.workCentreId === null ? null : (codes.centres.get(row.workCentreId) ?? null),
          supplier: row.supplierId === null ? null : (codes.suppliers.get(row.supplierId) ?? null),
          purchaseCost: costText(row.purchaseCost, codes.currencies.get(row.companyId) ?? 'EUR'),
          note: row.note,
        },
        status: row.status as MachineStatus,
        foreign: scope.companyId !== null && row.companyId !== scope.companyId,
      }),
    }))
  },

  async write(tools, row, scope) {
    const { tx, now, context } = tools
    const values = row.values
    const assetNumber = normalAssetNumber(String(row.key.assetNumber))
    // Who may keep machines at the row's site was checked with the person who applies, in this same batch (`check`): the
    // write runs in the worker's system context, so it checks only what the codes find now.
    const actor = null

    if (row.action === 'CREATE') {
      if (await tx.machine.findFirst({ where: { assetNumber }, select: { id: true } })) throw new ImportRowRefused(assetNumber, 'the asset number was taken since')
      const found = await resolve(tx, row, null, scope, actor)
      if (!found.site || found.issues.length > 0 || found.classId === undefined) throw new ImportRowRefused(assetNumber, found.issues.map((issue) => issue.message).join(' ') || 'its class is missing')
      const site = found.site
      const id = newId()
      const data: Prisma.MachineUncheckedCreateInput = {
        id,
        companyId: site.companyId,
        siteId: site.id,
        assetNumber,
        classId: found.classId,
        make: text(values.make) ?? null,
        modelName: text(values.modelName) ?? null,
        serialNumber: text(values.serialNumber) ?? null,
        year: typeof values.year === 'number' ? values.year : null,
        stationId: found.stationId ?? null,
        workCentreId: found.workCentreId ?? null,
        supplierId: found.supplierId ?? null,
        purchaseCost: values.purchaseCost === undefined ? null : toMinor(String(values.purchaseCost), site.currency),
        status: 'RUNNING',
        statusSince: now,
        note: text(values.note) ?? null,
        createdAt: now,
        updatedAt: now,
        createdById: context.audience === 'office' ? context.actorId : null,
      }
      await tx.machine.create({ data, select: { id: true } })
      tools.audit({
        action: ACTION,
        recordType: 'Machine',
        recordId: id,
        companyId: site.companyId,
        siteId: site.id,
        after: auditedMachine({ ...data, make: data.make ?? null, modelName: data.modelName ?? null, serialNumber: data.serialNumber ?? null, year: data.year ?? null, stationId: data.stationId ?? null, workCentreId: data.workCentreId ?? null, note: data.note ?? null, status: 'RUNNING' }),
      })
      tools.emit({ type: 'machine.registered', subject: id, companyId: site.companyId, siteId: site.id, payload: { machineId: id, assetNumber, classId: found.classId, stationId: data.stationId ?? null, workCentreId: data.workCentreId ?? null } })
      return { recordId: id }
    }

    const recordId = row.recordId!
    // The machine row first (the plant's lock order), then what it names.
    await tx.$queryRaw`SELECT "id" FROM "Machine" WHERE "id" = ${recordId}::uuid FOR UPDATE`
    const current = await tx.machine.findUniqueOrThrow({ where: { id: recordId }, select: COLUMNS })
    if (scope.companyId !== null && current.companyId !== scope.companyId) throw new ImportRowRefused(assetNumber, 'it belongs to another company')
    if (current.status === 'RETIRED' && Object.keys(values).some((column) => column !== 'note')) throw new ImportRowRefused(assetNumber, 'it was retired: only its note changes')
    const found = await resolve(tx, row, current, scope, actor)
    if (found.issues.length > 0) throw new ImportRowRefused(assetNumber, found.issues.map((issue) => issue.message).join(' '))
    const currency = found.site?.currency ?? 'EUR'
    const next: Partial<Record<keyof Row, unknown>> = {}
    if (found.classId !== undefined) next.classId = found.classId
    if (values.make !== undefined) next.make = String(values.make)
    if (values.modelName !== undefined) next.modelName = String(values.modelName)
    if (values.serialNumber !== undefined) next.serialNumber = String(values.serialNumber)
    if (values.year !== undefined) next.year = Number(values.year)
    if (found.stationId !== undefined) next.stationId = found.stationId
    if (found.workCentreId !== undefined) next.workCentreId = found.workCentreId
    if (found.supplierId !== undefined) next.supplierId = found.supplierId
    if (values.purchaseCost !== undefined) next.purchaseCost = toMinor(String(values.purchaseCost), currency)
    if (values.note !== undefined) next.note = String(values.note)
    const fields = Object.keys(next).filter((field) => next[field as keyof Row] !== current[field as keyof Row])
    if (fields.length === 0) return { recordId }
    const data = Object.fromEntries(fields.map((field) => [field, next[field as keyof Row]])) as Prisma.MachineUncheckedUpdateInput
    // command() bumps only the record it guards (the import job): the machine's version moves here.
    await tx.machine.update({ where: { id: recordId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = { ...current, ...data } as Row
    tools.audit({ action: ACTION, recordType: 'Machine', recordId, companyId: current.companyId, siteId: current.siteId, before: auditedMachine(current), after: auditedMachine(after) })
    tools.emit({ type: 'machine.changed', subject: recordId, companyId: current.companyId, siteId: current.siteId, payload: { machineId: recordId, assetNumber: current.assetNumber, fields } })
    return { recordId }
  },
} satisfies ImportAdapter)
