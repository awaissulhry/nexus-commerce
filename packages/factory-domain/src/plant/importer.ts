import { cell } from '../imports/cells'
import { defineImporter, diffPlan, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../imports/importer'
import { ASSET_NUMBER, normalAssetNumber, PLANT_LIMITS, type MachineStatus } from './rules'

/**
 * The machines import (B-W2b-25; the B-W2a-53 gap: Plant › Machines & tools ⋯ "Import machines", pop:import; the register
 * of B-W2a-35, QHS-162): a sheet of machines and equipment, one per row, keyed by the asset number on its QR tag. A new
 * asset number registers a machine at a site, RUNNING, as `POST /plant/machines` does; a known one changes the cells the
 * row gives (a blank cell is "not given", never "clear it"), as `PATCH /plant/machines/:id` does.
 *
 *   asset number                    the key; 1 to 40 letters, digits, dots, slashes, hyphens, underscores (normalised
 *                                   to upper case, as the tag prints it); unique in the group
 *   site, class                     the site's code and the machine class's code: needed for a new machine; a machine
 *                                   never moves to another site (its tag, requests and jobs are the site's)
 *   make, model, serial number,     its facts (texts up to 120 characters; the year 1900 to 2100)
 *   year
 *   station, work centre            where it stands: codes of its site's stations and work centres
 *   supplier                        who sold it: a party's code with the supplier role
 *   purchase cost                   what it cost, in the company's currency (the cost grain: the engine refuses a sheet
 *                                   that maps it for a person without it)
 *   note
 *
 * Not by import: the status (a machine moves through reports, jobs and sign-safe), retiring one, a machine of another
 * company than the job's. A retired machine takes only a new note. The adapter (apps/factory-api modules/plant/machines/
 * import.ts) loads each machine with its codes (`$status`, `$foreign` beside the columns), checks the codes a row names
 * against the database (`check`) and writes one planned row with its audit row and event.
 */

export const MACHINE_IMPORTER_KEY = 'plant.machines'

export const machinesImporter = defineImporter({
  key: MACHINE_IMPORTER_KEY,
  label: 'Machines and equipment',
  description: 'Machines and tools of a site with their asset number (the QR tag), class, place, facts, supplier and cost.',
  columns: {
    assetNumber: { label: 'Asset number', aliases: ['matricola', 'numero cespite', 'cespite', 'asset', 'asset tag', 'tag', 'codice macchina'], required: true, type: cell.code({ max: 40, upper: true }), description: 'The number on its QR tag.' },
    site: { label: 'Site', aliases: ['site code', 'sito', 'stabilimento', 'sede'], type: cell.code({ max: 40, upper: true }), description: "The site's code; needed for a new machine." },
    machineClass: { label: 'Class', aliases: ['classe', 'tipo macchina', 'machine class', 'class code', 'tipo'], type: cell.code({ max: 40, upper: true }), description: "The machine class's code; needed for a new machine." },
    make: { label: 'Make', aliases: ['marca', 'costruttore', 'produttore', 'brand', 'manufacturer'], type: cell.text({ max: PLANT_LIMITS.short }) },
    modelName: { label: 'Model', aliases: ['modello', 'model name'], type: cell.text({ max: PLANT_LIMITS.short }) },
    serialNumber: { label: 'Serial number', aliases: ['numero di serie', 'matricola costruttore', 'serial', 's/n'], type: cell.text({ max: PLANT_LIMITS.short }) },
    year: { label: 'Year', aliases: ['anno', 'anno di costruzione', 'year built'], type: cell.integer({ min: 1900, max: 2100 }) },
    station: { label: 'Station', aliases: ['postazione', 'station code'], type: cell.code({ max: 40, upper: true }), description: "A station of its site, by code." },
    workCentre: { label: 'Work centre', aliases: ['centro di lavoro', 'reparto', 'work center', 'work centre code'], type: cell.code({ max: 40, upper: true }), description: 'A work centre of its site, by code.' },
    supplier: { label: 'Supplier', aliases: ['fornitore', 'supplier code', 'codice fornitore'], type: cell.code({ max: 24, upper: true }), description: "A party's code with the supplier role." },
    purchaseCost: { label: 'Purchase cost', aliases: ['costo di acquisto', 'costo', 'valore', 'purchase price', 'cost'], type: cell.decimal({ precision: 14, scale: 3, min: '0' }), grain: 'cost', description: "In the company's currency." },
    note: { label: 'Note', aliases: ['nota', 'note', 'osservazioni'], type: cell.text({ max: PLANT_LIMITS.note }) },
  },
  keyColumns: ['assetNumber'],
  batchSize: 100,
  validateRow(values) {
    const issues: RowIssue[] = []
    if (typeof values.assetNumber === 'string' && !ASSET_NUMBER.test(normalAssetNumber(values.assetNumber))) {
      issues.push({ column: 'assetNumber', message: 'An asset number is 1 to 40 letters, digits, dots, slashes, hyphens and underscores (it is printed on the QR tag).' })
    }
    return issues
  },
  plan: (values, existing) => planMachineRow(values, existing),
})

/** A machine as the import sees it: its columns' values (codes), its status and whether it is another company's. */
export interface ImportedMachine {
  readonly columns: Readonly<Record<string, string | number | null>>
  readonly status: MachineStatus
  /** Of another company than the job's. */
  readonly foreign: boolean
}

const STATUS = '$status'
const FOREIGN = '$foreign'

export function importRecordValues(machine: ImportedMachine): RecordValues {
  return { ...machine.columns, [STATUS]: machine.status, [FOREIGN]: machine.foreign }
}

const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

/** What one row does (the importer's `plan`): see the module comment. */
export function planMachineRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = (['site', 'machineClass'] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) return refused(missing.map((name) => ({ column: name, message: `${machinesImporter.columns[name].label} is needed for a new machine.` })))
    return diffPlan(machinesImporter, values, null)
  }
  if (existing.values[FOREIGN] === true) return refused([{ column: 'assetNumber', message: "This asset number is another company's machine: import it with that company." }])
  if (values.site !== undefined && values.site !== existing.values.site) {
    return refused([{ column: 'site', message: `This machine stands at ${String(existing.values.site)}: a machine never moves to another site (register the other site's machine with its own tag).` }])
  }
  const plan = diffPlan(machinesImporter, values, existing)
  if (plan.action === 'UPDATE' && existing.values[STATUS] === 'RETIRED' && Object.keys(plan.after).some((column) => column !== 'note')) {
    return refused([{ message: `Machine ${String(existing.values.assetNumber)} is retired: only its note changes.` }])
  }
  return plan
}
