import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { UOMS, type Uom } from '../units/units'
import { formatColourList, mergeColours, parseColourList, type ColourFields } from './colours'
import {
  changeMaterial,
  ITEM_KINDS,
  ITEM_SOURCINGS,
  ITEM_TRACKINGS,
  newMaterial,
  standardCostProblems,
  TANNAGES,
  type MaterialFields,
  type MaterialInput,
  type MaterialPatch,
  type MaterialStatus,
} from './rules'

/**
 * The material import (features PRD-040 → PLT-176, PRD-028, PRD-030, PRD-032, GAP-006): a sheet of materials, one per
 * row, keyed by our article code. A new code makes a material; a known one changes the cells the row gives (a blank
 * cell is "not given", never "clear it"). The dry run applies every material rule (./rules), so a row that would break
 * one is an error in the review, never a failed apply.
 *
 *   code, name, kind, make or buy, tracking         the material
 *   stock / purchase / consumption unit + factors   PRD-030: factors only where the units do not derive them
 *   supplier article code, leather fields, PPE      PRD-028
 *   Cr VI test and limit                            REACH Annex XVII entry 47 (a limit exactly with a test, ≤ 3 mg/kg)
 *   colours                                         PRD-032: `NER=Nero|T-0001; ROS=Rosso`; added or renamed, never removed
 *   standard cost                                   GAP-006: per stock unit, in the material's currency (EUR for a new
 *                                                   one); the cost grain to import it and to see it in the review
 *
 * Not by import: the base unit of an existing material (its page checks its BOM lines and converts its cost), the
 * company (the job's company is the materials' company: a code of another company's material is an error), archived
 * materials (reactivate first), the default supplier, the composition and free attributes (the material page).
 *
 * The adapter (apps/factory-api modules/product/materials/importer.ts) loads each material as `importRecord()` values:
 * the columns' current values plus `$record`, the whole material as JSON, which the plan needs for the rules on what
 * the sheet leaves out. Only the columns ever reach a stored plan row.
 */

const UOM_ALIASES: Readonly<Record<string, Uom>> = {
  pz: 'PCS', pezzo: 'PCS', pezzi: 'PCS', pc: 'PCS', pcs: 'PCS', piece: 'PCS', pieces: 'PCS', nr: 'PCS',
  paio: 'PAIR', paia: 'PAIR', pair: 'PAIR', pairs: 'PAIR',
  kit: 'SET', serie: 'SET',
  mt: 'M', metro: 'M', metri: 'M', metre: 'M', metres: 'M', meter: 'M', meters: 'M',
  millimetro: 'MM', millimetri: 'MM', centimetro: 'CM', centimetri: 'CM',
  mq: 'M2', 'm²': 'M2', 'metro quadro': 'M2', 'metri quadri': 'M2', 'square metre': 'M2', sqm: 'M2',
  dmq: 'DM2', 'dm²': 'DM2', 'decimetro quadro': 'DM2', 'decimetri quadri': 'DM2',
  'ft²': 'FT2', sqft: 'FT2', 'sq ft': 'FT2', 'piede quadro': 'FT2', 'piedi quadri': 'FT2', 'square foot': 'FT2', 'square feet': 'FT2',
  chilo: 'KG', chilogrammo: 'KG', chilogrammi: 'KG', kilogram: 'KG', gr: 'G', grammo: 'G', grammi: 'G', gram: 'G',
  lt: 'L', litro: 'L', litri: 'L', litre: 'L',
  pelle: 'HIDE', pelli: 'HIDE', hides: 'HIDE', 'mezza pelle': 'SIDE', 'mezze pelli': 'SIDE', mezzena: 'SIDE', sides: 'SIDE',
  rotolo: 'ROLL', rotoli: 'ROLL', rolls: 'ROLL', cono: 'CONE', coni: 'CONE', rocca: 'CONE', cones: 'CONE',
  scatola: 'BOX', scatole: 'BOX', confezione: 'BOX', boxes: 'BOX',
}
const unitCell = () => cell.oneOf(UOMS, UOM_ALIASES)

const KIND_ALIASES = {
  pelle: 'LEATHER', pellame: 'LEATHER', tessuto: 'TEXTILE', fabric: 'TEXTILE', fodera: 'LINING', membrana: 'MEMBRANE',
  imbottitura: 'PADDING', ovatta: 'PADDING', filo: 'THREAD', accessorio: 'TRIM', accessori: 'TRIM', minuteria: 'HARDWARE',
  protezione: 'PROTECTOR', protettore: 'PROTECTOR', etichetta: 'LABEL', imballo: 'PACKAGING', imballaggio: 'PACKAGING',
  componente: 'COMPONENT', semilavorato: 'COMPONENT',
} as const satisfies Record<string, (typeof ITEM_KINDS)[number]>
const SOURCING_ALIASES = { acquisto: 'BUY', comprato: 'BUY', produzione: 'MAKE', prodotto: 'MAKE', entrambi: 'MAKE_OR_BUY', 'make or buy': 'MAKE_OR_BUY' } as const
const TRACKING_ALIASES = { nessuna: 'NONE', nessuno: 'NONE', lotto: 'LOT', 'per lotto': 'LOT', 'per pelle': 'HIDE', 'pelle per pelle': 'HIDE', seriale: 'SERIAL', matricola: 'SERIAL' } as const
const TANNAGE_ALIASES = { cromo: 'CHROME', 'al cromo': 'CHROME', vegetale: 'VEGETABLE', 'senza cromo': 'CHROME_FREE', 'chrome free': 'CHROME_FREE', 'metal free': 'CHROME_FREE', mista: 'COMBINATION', misto: 'COMBINATION' } as const

export const MATERIAL_IMPORTER_KEY = 'product.materials'

export const materialImporter = defineImporter({
  key: MATERIAL_IMPORTER_KEY,
  label: 'Materials',
  description: 'Materials, trims and protectors with their units, colours, Cr VI settings and standard cost.',
  columns: {
    code: { label: 'Code', aliases: ['codice', 'codice articolo', 'article code', 'articolo'], required: true, type: cell.code({ upper: true, max: 40 }) },
    name: { label: 'Name', aliases: ['nome', 'descrizione', 'description'], type: cell.text({ max: 200 }), description: 'Needed for a new material.' },
    kind: { label: 'Kind', aliases: ['tipo', 'type', 'categoria'], type: cell.oneOf(ITEM_KINDS, KIND_ALIASES), description: 'Needed for a new material.' },
    sourcing: { label: 'Make or buy', aliases: ['sourcing', 'approvvigionamento', 'acquisto o produzione'], type: cell.oneOf(ITEM_SOURCINGS, SOURCING_ALIASES) },
    tracking: { label: 'Tracking', aliases: ['tracciabilita', 'tracciatura', 'rintracciabilita'], type: cell.oneOf(ITEM_TRACKINGS, TRACKING_ALIASES) },
    baseUom: { label: 'Stock unit', aliases: ['base unit', 'unita di magazzino', 'um', 'unita di misura'], type: unitCell(), description: 'Needed for a new material; not changed by an import.' },
    purchaseUom: { label: 'Purchase unit', aliases: ['unita di acquisto', 'um acquisto'], type: unitCell() },
    purchaseFactor: { label: 'Purchase factor', aliases: ['fattore acquisto', 'conversione acquisto'], type: cell.decimal({ precision: 18, scale: 8 }), description: 'Stock units in one purchase unit, when the units do not say it.' },
    consumptionUom: { label: 'Consumption unit', aliases: ['unita di consumo', 'um consumo'], type: unitCell() },
    consumptionFactor: { label: 'Consumption factor', aliases: ['fattore consumo', 'conversione consumo'], type: cell.decimal({ precision: 18, scale: 8 }) },
    supplierArticleCode: { label: 'Supplier article code', aliases: ['codice fornitore', 'codice articolo fornitore'], type: cell.text({ max: 64 }) },
    animalSpecies: { label: 'Animal', aliases: ['specie', 'animale', 'species'], type: cell.text({ max: 60 }) },
    tannage: { label: 'Tannage', aliases: ['concia'], type: cell.oneOf(TANNAGES, TANNAGE_ALIASES) },
    grade: { label: 'Grade', aliases: ['scelta', 'selezione', 'selection'], type: cell.text({ max: 40 }) },
    finish: { label: 'Finish', aliases: ['rifinizione', 'finitura'], type: cell.text({ max: 80 }) },
    thicknessMinMm: { label: 'Thickness from (mm)', aliases: ['spessore min', 'spessore da', 'thickness min'], type: cell.decimal({ precision: 6, scale: 2 }) },
    thicknessMaxMm: { label: 'Thickness to (mm)', aliases: ['spessore max', 'spessore a', 'thickness max'], type: cell.decimal({ precision: 6, scale: 2 }) },
    isPpeComponent: { label: 'PPE component', aliases: ['componente dpi', 'dpi'], type: cell.boolean() },
    requiresCrViTest: { label: 'Cr VI test', aliases: ['test cromo vi', 'prova cromo esavalente', 'cr6 test'], type: cell.boolean() },
    crViLimitMgKg: { label: 'Cr VI limit (mg/kg)', aliases: ['limite cromo vi', 'limite cr6', 'cr6 limit'], type: cell.decimal({ precision: 8, scale: 3 }) },
    colours: { label: 'Colours', aliases: ['colori', 'colors'], type: cell.text({ max: 8000 }), description: 'CODE=Name|supplier code, split by ;' },
    standardCost: { label: 'Standard cost', aliases: ['costo standard', 'prezzo standard', 'standard price', 'prezzo di acquisto'], type: cell.decimal({ precision: 18, scale: 6, min: '0' }), grain: 'cost', description: 'Per stock unit.' },
  },
  keyColumns: ['code'],
  batchSize: 100,
  validateRow(values) {
    if (typeof values.colours !== 'string') return []
    const colours = parseColourList(values.colours)
    return colours.ok ? [] : [{ column: 'colours', message: colours.message }]
  },
  plan: (values, existing) => planMaterialRow(values, existing),
})

type Columns = typeof materialImporter.columns
type Column = keyof Columns & string
const isColumn = (name: string): name is Column => Object.hasOwn(materialImporter.columns, name)

/** The field columns: the importer's columns that are material fields (all but colours and the cost). */
const FIELD_COLUMNS = Object.keys(materialImporter.columns).filter((name) => name !== 'colours' && name !== 'standardCost') as (Column & keyof MaterialFields)[]

// ---- the record as the adapter loads it -----------------------------------------------------------------------------

/** A material as the import sees it. */
export interface ImportedMaterial {
  readonly fields: MaterialFields
  readonly status: MaterialStatus
  /** Of another company than the job's (or tenant-wide for a company's job, or the reverse). */
  readonly foreign: boolean
  /** Its active colours. */
  readonly colours: readonly ColourFields[]
  readonly standardCost: string | null
}

const RECORD = '$record'

/** The values the adapter's load answers for a material: its columns and the whole record (`$record`). */
export function importRecordValues(material: ImportedMaterial): RecordValues {
  const columns: Record<string, CellValue | null> = {}
  for (const name of FIELD_COLUMNS) columns[name] = (material.fields[name] as CellValue | null) ?? null
  columns.colours = material.colours.length === 0 ? null : formatColourList(material.colours)
  columns.standardCost = material.standardCost
  return { ...columns, [RECORD]: JSON.stringify(material) }
}

function recordOf(existing: ExistingRecord): ImportedMaterial {
  const raw = existing.values[RECORD]
  if (typeof raw !== 'string') throw new Error('The material import needs the record ($record) beside the columns.')
  return JSON.parse(raw) as ImportedMaterial
}

// ---- the plan ---------------------------------------------------------------------------------------------------------

const rowIssues = (issues: readonly Issue[]): RowIssue[] =>
  issues.map((issue) => {
    const field = issue.path.split('/')[0] ?? ''
    return isColumn(field) ? { column: field, message: issue.message } : { message: `${issue.path}: ${issue.message}` }
  })
const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

/** The fields a row gives, as a material patch (field columns only). */
function patchOf(values: RowValues): MaterialPatch {
  const patch: Record<string, CellValue> = {}
  for (const name of FIELD_COLUMNS) if (values[name] !== undefined) patch[name] = values[name]!
  return patch as MaterialPatch
}

/** A new material from a row (name, kind and stock unit checked present by the caller). */
export function materialInputOf(values: RowValues): MaterialInput {
  return patchOf(values) as MaterialInput
}

const sameDecimal = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : new Decimal(a).eq(b))

/** What one row does (the importer's `plan`): see the module comment. */
export function planMaterialRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  const cost = typeof values.standardCost === 'string' ? values.standardCost : null
  const costIssues = cost === null ? [] : standardCostProblems(cost, 'EUR')
  if (existing === null) {
    const missing = (['name', 'kind', 'baseUom'] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) return refused(missing.map((name) => ({ column: name, message: `${materialImporter.columns[name].label} is needed for a new material.` })))
    const outcome = newMaterial(materialInputOf(values))
    const issues = [...(outcome.ok ? [] : outcome.issues), ...costIssues]
    return issues.length > 0 ? refused(rowIssues(issues)) : { action: 'CREATE', after: values }
  }

  const record = recordOf(existing)
  if (record.foreign) return refused([{ column: 'code', message: "This code is another company's material (or one for every company): import it with that company." }])
  if (record.status !== 'ACTIVE') return refused([{ message: 'This material is archived: reactivate it on its page before importing changes.' }])
  if (values.baseUom !== undefined && values.baseUom !== record.fields.baseUom) {
    return refused([{ column: 'baseUom', message: "A material's stock unit changes on its page (it checks its BOM lines and its cost), not by an import." }])
  }
  const change = changeMaterial(record.fields, patchOf(values))
  if (!change.ok || costIssues.length > 0) return refused(rowIssues([...(change.ok ? [] : change.issues), ...costIssues]))

  const before: Record<string, CellValue | null> = {}
  const after: Record<string, CellValue> = {}
  for (const field of change.changed) {
    if (!isColumn(field)) continue
    before[field] = (record.fields[field] as CellValue | null) ?? null
    // A value the change clears (the Cr VI limit when the test is turned off) follows from the others: the apply
    // derives it again, and the review shows what it was.
    const next = change.material[field] as CellValue | null
    if (next !== null) after[field] = next
  }
  if (typeof values.colours === 'string') {
    const given = parseColourList(values.colours)
    if (given.ok) {
      const current = record.colours.length === 0 ? null : formatColourList(record.colours)
      const merged = formatColourList(mergeColours(record.colours, given.colours))
      if (merged !== current) {
        before.colours = current
        after.colours = merged
      }
    }
  }
  if (cost !== null && !sameDecimal(cost, record.standardCost)) {
    before.standardCost = record.standardCost
    after.standardCost = cost
  }
  return Object.keys(after).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before, after }
}

/** The colours a planned row gives (the merged list for an update, the given ones for a new material). */
export function coloursOf(values: RowValues): ColourFields[] {
  if (typeof values.colours !== 'string') return []
  const parsed = parseColourList(values.colours)
  return parsed.ok ? [...parsed.colours] : []
}

/** The material fields a planned UPDATE row changes, as a patch. */
export const patchOfRow = patchOf
