import { cell, type CellValue } from '../../imports/cells'
import { defineImporter, type ExistingRecord, type RecordValues, type RowIssue, type RowPlan, type RowValues } from '../../imports/importer'
import { kindChangeRefusal, normalisePom, patchedPom, pomChanges, pomProblems, POM_KINDS, POM_LIMITS, POM_UOMS, POM_ZONES, type PomFields, type PomStatus, type PomUse } from './rules'

/**
 * The point of measure library's import (B-W2b-224; PRD-062; design products.sizes "Import (W2b)"): a sheet of points,
 * one per row, keyed by the point's code. A new code makes a point; a known one changes the cells the row gives (a blank
 * cell is "not given", never "clear it"). The dry run applies every library rule (./rules), so a row that would break
 * one is an error in the review, never a failed apply.
 *
 *   code, name, name (it), name (en)              the point and its names per language
 *   kind, zone, unit, default tolerance           body or garment; upper body, arms, legs, riding, other; cm or mm
 *   how to measure, how to (it), how to (en)      the text the spec's HoverCard and the inspection show
 *   description, body point                       a garment point's body point by its code (PRD-069)
 *
 * Not by import: the company (the job's company is the points' company), the picture, an archived point (restore it
 * first), a kind or unit of a point in use. The adapter (apps/factory-api modules/product/measures/importer.ts) loads each
 * point as `importRecordValues()`: the columns' values and `$record`, the whole point with what names it.
 */

export const POM_IMPORTER_KEY = 'product.pointsOfMeasure'

const KIND_ALIASES = { corpo: 'BODY', body: 'BODY', capo: 'GARMENT', garment: 'GARMENT', indumento: 'GARMENT', prodotto: 'GARMENT' } as const satisfies Record<string, (typeof POM_KINDS)[number]>
const ZONE_ALIASES = {
  busto: 'UPPER', tronco: 'UPPER', torso: 'UPPER', upper: 'UPPER', 'parte superiore': 'UPPER',
  braccia: 'ARMS', braccio: 'ARMS', arms: 'ARMS', maniche: 'ARMS',
  gambe: 'LEGS', gamba: 'LEGS', legs: 'LEGS', pantaloni: 'LEGS',
  guida: 'RIDING', 'in sella': 'RIDING', riding: 'RIDING',
  altro: 'OTHER', other: 'OTHER',
} as const satisfies Record<string, (typeof POM_ZONES)[number]>

export const pointsOfMeasureImporter = defineImporter({
  key: POM_IMPORTER_KEY,
  label: 'Points of measure',
  description: 'The point of measure library: body and garment points, how to measure each, its unit and default tolerance.',
  columns: {
    code: { label: 'Code', aliases: ['codice', 'codice punto', 'point', 'punto', 'pom'], required: true, type: cell.code({ max: 40 }) },
    name: { label: 'Name', aliases: ['nome', 'descrizione breve'], type: cell.text({ max: POM_LIMITS.name }), description: 'Needed for a new point.' },
    nameIt: { label: 'Name (it)', aliases: ['nome (it)', 'nome italiano'], type: cell.text({ max: POM_LIMITS.name }) },
    nameEn: { label: 'Name (en)', aliases: ['nome (en)', 'nome inglese'], type: cell.text({ max: POM_LIMITS.name }) },
    kind: { label: 'Kind', aliases: ['tipo', 'corpo o capo'], type: cell.oneOf(POM_KINDS, KIND_ALIASES), description: 'BODY or GARMENT; needed for a new point.' },
    bodyZone: { label: 'Zone', aliases: ['zona', 'zona del corpo', 'body zone'], type: cell.oneOf(POM_ZONES, ZONE_ALIASES), description: 'Needed for a new point.' },
    uom: { label: 'Unit', aliases: ['unita', 'unità', 'unita di misura', 'uom'], type: cell.oneOf(POM_UOMS, { centimetri: 'CM', millimetri: 'MM' }), description: 'CM (default) or MM.' },
    defaultTolerance: { label: 'Default tolerance', aliases: ['tolleranza', 'tolleranza standard', 'tolerance'], type: cell.decimal({ precision: 8, scale: 2, min: '0' }) },
    howTo: { label: 'How to measure', aliases: ['come misurare', 'istruzioni', 'how to'], type: cell.text({ max: POM_LIMITS.howTo }) },
    howToIt: { label: 'How to measure (it)', aliases: ['come misurare (it)'], type: cell.text({ max: POM_LIMITS.howTo }) },
    howToEn: { label: 'How to measure (en)', aliases: ['come misurare (en)'], type: cell.text({ max: POM_LIMITS.howTo }) },
    description: { label: 'Description', aliases: ['descrizione', 'note'], type: cell.text({ max: POM_LIMITS.description }) },
    bodyPoint: { label: 'Body point', aliases: ['punto corpo', 'misura corporea', 'body measure'], type: cell.code({ max: 40 }), description: "A garment point's body point, by its code." },
  },
  keyColumns: ['code'],
  batchSize: 100,
  plan: (values, existing) => planPomRow(values, existing),
})

type Column = keyof typeof pointsOfMeasureImporter.columns
const isColumn = (name: string): name is Column => Object.hasOwn(pointsOfMeasureImporter.columns, name)

/** A point as the import sees it. */
export interface ImportedPom {
  readonly fields: PomFields
  /** Its body point's code (the sheet names it by code). */
  readonly bodyPointCode: string | null
  readonly status: PomStatus
  /** Of another company than the job's (or tenant-wide for a company's job, or the reverse). */
  readonly foreign: boolean
  readonly use: PomUse
}

const RECORD = '$record'

function columnsOf(point: ImportedPom): Record<Column, CellValue | null> {
  const { fields } = point
  return {
    code: fields.code,
    name: fields.name,
    nameIt: fields.nameI18n?.it ?? null,
    nameEn: fields.nameI18n?.en ?? null,
    kind: fields.kind,
    bodyZone: fields.bodyZone,
    uom: fields.uom,
    defaultTolerance: fields.defaultTolerance,
    howTo: fields.howTo,
    howToIt: fields.howToI18n?.it ?? null,
    howToEn: fields.howToI18n?.en ?? null,
    description: fields.description,
    bodyPoint: point.bodyPointCode,
  }
}

/** The values the adapter's load answers for a point: its columns and the whole record (`$record`). */
export function importRecordValues(point: ImportedPom): RecordValues {
  return { ...columnsOf(point), [RECORD]: JSON.stringify(point) }
}

function recordOf(existing: ExistingRecord): ImportedPom {
  const raw = existing.values[RECORD]
  if (typeof raw !== 'string') throw new Error('The points of measure import needs the record ($record) beside the columns.')
  return JSON.parse(raw) as ImportedPom
}

const refused = (errors: readonly RowIssue[]): RowPlan => ({ action: 'ERROR', errors })

const wordsOf = (values: RowValues, it: Column, en: Column, current: Readonly<Record<string, string>> | null) => {
  if (values[it] === undefined && values[en] === undefined) return undefined
  return { ...(current ?? {}), ...(typeof values[it] === 'string' ? { it: values[it] as string } : {}), ...(typeof values[en] === 'string' ? { en: values[en] as string } : {}) }
}

/**
 * The fields a row gives over a point (or over nothing, for a new one). The body point stays as it is here: its id is the
 * adapter's (by code); the plan checks only that a body point is named on a garment point.
 */
export function fieldsFromRow(values: RowValues, current: PomFields | null): PomFields {
  const given = (name: Column) => values[name] !== undefined
  const base: PomFields = current ?? { code: String(values.code), name: '', nameI18n: null, description: null, howTo: null, howToI18n: null, kind: 'GARMENT', bodyZone: 'OTHER', uom: 'CM', defaultTolerance: null, bodyPointId: null }
  return patchedPom(base, {
    ...(given('name') ? { name: String(values.name) } : {}),
    ...(given('kind') ? { kind: values.kind as PomFields['kind'] } : {}),
    ...(given('bodyZone') ? { bodyZone: values.bodyZone as PomFields['bodyZone'] } : {}),
    ...(given('uom') ? { uom: values.uom as PomFields['uom'] } : {}),
    ...(given('defaultTolerance') ? { defaultTolerance: String(values.defaultTolerance) } : {}),
    ...(given('howTo') ? { howTo: String(values.howTo) } : {}),
    ...(given('description') ? { description: String(values.description) } : {}),
    ...(wordsOf(values, 'nameIt', 'nameEn', base.nameI18n) !== undefined ? { nameI18n: wordsOf(values, 'nameIt', 'nameEn', base.nameI18n)! } : {}),
    ...(wordsOf(values, 'howToIt', 'howToEn', base.howToI18n) !== undefined ? { howToI18n: wordsOf(values, 'howToIt', 'howToEn', base.howToI18n)! } : {}),
  })
}

const rowIssues = (issues: readonly { path: string; message: string }[]): RowIssue[] =>
  issues.map((issue) => {
    const head = issue.path.split('/')[0] ?? ''
    const column = head === 'nameI18n' ? (issue.path.endsWith('/it') ? 'nameIt' : 'nameEn') : head === 'howToI18n' ? (issue.path.endsWith('/it') ? 'howToIt' : 'howToEn') : head === 'bodyPointId' ? 'bodyPoint' : head
    return isColumn(column) ? { column, message: issue.message } : { message: `${issue.path}: ${issue.message}` }
  })

/** What one row does (the importer's `plan`): see the module comment. */
export function planPomRow(values: RowValues, existing: ExistingRecord | null): RowPlan {
  if (existing === null) {
    const missing = (['name', 'kind', 'bodyZone'] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) return refused(missing.map((name) => ({ column: name, message: `${pointsOfMeasureImporter.columns[name].label} is needed for a new point.` })))
    const fields = fieldsFromRow(values, null)
    // The body point's id is found by the adapter: here only its place (a garment point) is checked.
    const problems = rowIssues(pomProblems(fields))
    if (values.bodyPoint !== undefined && fields.kind !== 'GARMENT') problems.push({ column: 'bodyPoint', message: 'Only a garment point names the body point it answers to.' })
    return problems.length > 0 ? refused(problems) : { action: 'CREATE', after: values }
  }
  const record = recordOf(existing)
  if (record.foreign) return refused([{ column: 'code', message: "This code is another company's point (or one for every company): import it with that company." }])
  if (record.status !== 'ACTIVE') return refused([{ message: 'This point is archived: restore it in the library before importing changes.' }])
  const next = normalisePom(fieldsFromRow(values, record.fields))
  const problems = rowIssues(pomProblems(next, { id: null }))
  if (values.bodyPoint !== undefined && next.kind !== 'GARMENT') problems.push({ column: 'bodyPoint', message: 'Only a garment point names the body point it answers to.' })
  const refusal = kindChangeRefusal(record.fields.code, pomChanges(record.fields, next), record.use)
  if (refusal) problems.push({ column: values.kind !== undefined ? 'kind' : 'uom', message: refusal })
  if (problems.length > 0) return refused(problems)
  const before = columnsOf(record)
  const after = columnsOf({ ...record, fields: next, bodyPointCode: values.bodyPoint !== undefined ? String(values.bodyPoint) : record.bodyPointCode })
  const changedBefore: Record<string, CellValue | null> = {}
  const changedAfter: Record<string, CellValue> = {}
  for (const column of Object.keys(after) as Column[]) {
    const from = before[column]
    const to = after[column]
    if (to === null || from === to || (column === 'bodyPoint' && typeof from === 'string' && typeof to === 'string' && from.toUpperCase() === to.toUpperCase())) continue
    changedBefore[column] = from
    changedAfter[column] = to
  }
  return Object.keys(changedAfter).length === 0 ? { action: 'UNCHANGED' } : { action: 'UPDATE', before: changedBefore, after: changedAfter }
}
