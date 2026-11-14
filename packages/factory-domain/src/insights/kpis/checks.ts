import type { Issue } from '../../core/errors'
import { measuresOfCalc } from './calc'
import { KPI_GRAINS, KPI_UNITS, type KpiFile, type KpiGrain, type KpiUnit } from './catalogue'
import { MEASURE_KEY, measureOf } from './measures'

/**
 * The rules of a KPI version a person writes (B-W2b-428; ANA-012), pure, checked in words before the database's own guards
 * (…_insights_depth_w2b_guards, B-W2b-381) would refuse the same row:
 *
 *   draftProblems        a draft's words (Italian AND English), records, measures, unit and grain
 *   activationProblems   what must hold to put a version in force: every measure is one the layer builds, and a KPI with a
 *                        calculation in code names exactly the measures it reads, with its unit and grain (a different
 *                        calculation is a different KPI, never a new version of this one)
 *
 * Issue paths: `body/<field>` for a field, `refusal/<CODE>` for a state.
 */

export const KPI_LIMITS = Object.freeze({ name: 120, definition: 2000, formula: 1000, changeNote: 2000, records: 20, measures: 30 })

export const KPI_REFUSALS = ['UNKNOWN_MEASURE', 'MEASURES_DIFFER', 'UNIT_DIFFERS', 'GRAIN_DIFFERS', 'NOT_DRAFT', 'NOT_IN_FORCE', 'BASED_ON_OTHER_KPI'] as const
export type KpiRefusal = (typeof KPI_REFUSALS)[number]

export interface KpiVersionFields {
  readonly nameIt: string
  readonly nameEn: string
  readonly definitionIt: string
  readonly definitionEn: string
  readonly formulaIt: string
  readonly formulaEn: string
  readonly sourceRecords: readonly string[]
  readonly measureKeys: readonly string[]
  readonly unit: KpiUnit
  readonly grain: KpiGrain | null
}

/** The fields a person may change on a draft (the owner role is checked by the API: an office role, not archived). */
export const KPI_EDITABLE = ['nameIt', 'nameEn', 'definitionIt', 'definitionEn', 'formulaIt', 'formulaEn', 'sourceRecords', 'measureKeys', 'ownerRoleId', 'unit', 'grain', 'changeNote'] as const
export type KpiEditable = (typeof KPI_EDITABLE)[number]

/** A model name (`SalesOrderLine`); that it is a table the database checks. */
const RECORD = /^[A-Z][A-Za-z0-9]{0,62}$/

const words = (value: string, limit: number): boolean => value.trim().length >= 1 && value.length <= limit

/** What is wrong with a draft (empty when nothing). `changed` names the fields being written (measures are checked against the registry only then). */
export function draftProblems(fields: KpiVersionFields & { readonly changeNote?: string | null }, changed: ReadonlySet<string> | 'all' = 'all'): Issue[] {
  const issues: Issue[] = []
  const touched = (field: string) => changed === 'all' || changed.has(field)
  for (const field of ['nameIt', 'nameEn'] as const) {
    if (!words(fields[field], KPI_LIMITS.name) || /[\r\n]/.test(fields[field])) issues.push({ path: `body/${field}`, message: `The name is 1 to ${KPI_LIMITS.name} characters on one line, in Italian and in English.` })
  }
  for (const field of ['definitionIt', 'definitionEn'] as const) {
    if (!words(fields[field], KPI_LIMITS.definition)) issues.push({ path: `body/${field}`, message: `Say what it means and what it leaves out, 1 to ${KPI_LIMITS.definition} characters, in Italian and in English.` })
  }
  for (const field of ['formulaIt', 'formulaEn'] as const) {
    if (!words(fields[field], KPI_LIMITS.formula)) issues.push({ path: `body/${field}`, message: `Give the formula in words, 1 to ${KPI_LIMITS.formula} characters, in Italian and in English.` })
  }
  if (fields.changeNote !== undefined && fields.changeNote !== null && !words(fields.changeNote, KPI_LIMITS.changeNote)) {
    issues.push({ path: 'body/changeNote', message: `Say what changed from the version it is made from, 1 to ${KPI_LIMITS.changeNote} characters.` })
  }
  const records = fields.sourceRecords
  if (records.length < 1 || records.length > KPI_LIMITS.records || new Set(records).size !== records.length || records.some((record) => !RECORD.test(record))) {
    issues.push({ path: 'body/sourceRecords', message: `Name 1 to ${KPI_LIMITS.records} records it is computed from, each once, by their model name (SalesOrderLine).` })
  }
  const measures = fields.measureKeys
  if (measures.length > KPI_LIMITS.measures || new Set(measures).size !== measures.length || measures.some((key) => !MEASURE_KEY.test(key) || key.length > 100)) {
    issues.push({ path: 'body/measureKeys', message: `Name up to ${KPI_LIMITS.measures} facts it reads, each once, by their measure key (orders.value).` })
  } else if (touched('measureKeys')) {
    const unknown = measures.filter((key) => !measureOf(key))
    if (unknown.length > 0) issues.push({ path: 'body/measureKeys', message: `${unknown.join(', ')}: not a measure the metric layer builds.` })
  }
  if (!(KPI_UNITS as readonly string[]).includes(fields.unit)) issues.push({ path: 'body/unit', message: 'Choose what its value counts in.' })
  if (fields.grain !== null && !(KPI_GRAINS as readonly string[]).includes(fields.grain)) issues.push({ path: 'body/grain', message: 'A KPI needs the price, cost or margin rights, or none.' })
  if (fields.unit === 'MONEY' && fields.grain === null) issues.push({ path: 'body/grain', message: 'A KPI that counts money names the rights its value needs (price, cost or margin).' })
  if (measures.some((key) => measureOf(key)?.grain === 'margin') && fields.grain !== 'MARGIN') {
    issues.push({ path: 'body/grain', message: 'A KPI that reads margin shows its value only with the margin rights: choose margin.' })
  }
  return issues
}

/** What stops a version from being put in force (empty when nothing). `file`: the KPI's calculation in code, if it has one. */
export function activationProblems(fields: Pick<KpiVersionFields, 'measureKeys' | 'unit' | 'grain'>, file: KpiFile | null): Issue[] {
  const unknown = fields.measureKeys.filter((key) => !measureOf(key))
  if (unknown.length > 0) return [{ path: 'refusal/UNKNOWN_MEASURE', message: `It reads ${unknown.join(', ')}, which the metric layer does not build yet: it cannot be put in force.` }]
  if (!file) return []
  const issues: Issue[] = []
  const reads = measuresOfCalc(file.calc)
  if (reads.length !== fields.measureKeys.length || reads.some((key) => !fields.measureKeys.includes(key))) {
    issues.push({ path: 'refusal/MEASURES_DIFFER', message: `Its calculation reads ${reads.join(', ')}: the version names exactly those facts (a different calculation is a different KPI).` })
  }
  if (fields.unit !== file.unit) issues.push({ path: 'refusal/UNIT_DIFFERS', message: `Its calculation counts in ${file.unit}: the version says the same.` })
  if (fields.grain !== file.grain) issues.push({ path: 'refusal/GRAIN_DIFFERS', message: `Its value needs ${file.grain ?? 'no money'} rights: the version says the same.` })
  return issues
}

/** The key of a use (KpiUse.key, the database's rule): `kpiuse:<kpiKey>:<usedIn>:<useKey>`. */
export const kpiUseKey = (kpiKey: string, usedIn: string, useKey: string): string => `kpiuse:${kpiKey}:${usedIn}:${useKey}`
