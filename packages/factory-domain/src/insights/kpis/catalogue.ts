import type { Grain } from '../../auth/grains/grains'
import type { Permission } from '../../core/permissions'
import type { PeriodKind } from '../periods/periods'
import { measuresOfCalc, type KpiCalc } from './calc'
import { measureOf, type FactGrain } from './measures'

/**
 * The KPI catalogue in code (B-W2b-428; ANA-012 KPI catalogue with definitions, ANA-070): one file per KPI in `defs/`
 * (listed in defs/index.ts, the merge point of the steps that add KPIs: B-W2b-429's ready KPIs), each with its calculation
 * (calc.ts) and the words of its first version. The versions themselves live in the database (KpiDefinition, B-W2b-381): the
 * standard KPIs are installed as version 1 in force by `POST /insights/kpis/sync`, and a person changes a KPI by writing a new
 * version from the one in force (its words, owner, records; never its calculation: a version names exactly the measures its
 * calculation reads, `activationProblems`).
 *
 *   unit          what its value counts in (KpiUnit; the database's enum)
 *   grain         the money grain its value needs (KpiGrain): a margin percent reveals margin, so it names MARGIN
 *   ownerRole     the office role template that owns its definition (the KPI library's "Owner")
 *   period        the period it is read over when none is asked (the library's "now"), with 12 before it for the trend
 *   drill         the report or list that shows the records behind it, with its filters, when one does
 *
 * Per-person figures are never a KPI (Statuto dei Lavoratori art. 4): a KPI reads measures, and no measure is of a person.
 */

export const KPI_UNITS = ['PERCENT', 'COUNT', 'PIECES', 'MONEY', 'DAYS', 'HOURS', 'MINUTES', 'RATIO'] as const
export type KpiUnit = (typeof KPI_UNITS)[number]

export const KPI_GRAINS = ['PRICE', 'COST', 'MARGIN'] as const
export type KpiGrain = (typeof KPI_GRAINS)[number]

export const KPI_STATES = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED'] as const
export type KpiState = (typeof KPI_STATES)[number]

export const KPI_USE_KINDS = ['DASHBOARD', 'REPORT', 'ALERT', 'PORTAL'] as const
export type KpiUseKind = (typeof KPI_USE_KINDS)[number]

/** The money grain of a KPI grain (KpiGrain PRICE → price). */
export const grainOfKpi = (grain: KpiGrain): FactGrain => grain.toLowerCase() as FactGrain

export interface KpiWords {
  readonly nameIt: string
  readonly nameEn: string
  readonly definitionIt: string
  readonly definitionEn: string
  readonly formulaIt: string
  readonly formulaEn: string
}

export interface KpiFile {
  readonly key: string
  readonly unit: KpiUnit
  readonly grain: KpiGrain | null
  readonly ownerRole: string
  readonly sourceRecords: readonly string[]
  readonly calc: KpiCalc
  readonly period: PeriodKind
  readonly drill: KpiDrill | null
  readonly words: KpiWords
}

/** Where the records behind a KPI are listed: a report of the pack (home.reports) or an area list, with its filters. */
export type KpiDrill =
  | { readonly kind: 'REPORT'; readonly key: string; readonly filters: Readonly<Record<string, string>> }
  | { readonly kind: 'LIST'; readonly api: string; readonly query: Readonly<Record<string, string>> }
export const KPI_DRILL_KINDS = ['REPORT', 'LIST'] as const

/** A KPI's key: lower-case dotted words (`delivery.otif`), up to 100 characters (the database's rule). */
export const KPI_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/** What is wrong with a KPI file (empty when nothing): its key, its measures, its unit and grain against its calculation. */
export function kpiFileProblems(file: KpiFile): string[] {
  const problems: string[] = []
  if (!KPI_KEY.test(file.key) || file.key.length > 100) problems.push(`${file.key}: the key is lower-case dotted words`)
  const measures = measuresOfCalc(file.calc).map((key) => ({ key, measure: measureOf(key) }))
  for (const { key, measure } of measures) if (!measure) problems.push(`${file.key}: measure ${key} is not in the measure registry`)
  const known = measures.flatMap(({ measure }) => (measure ? [measure] : []))
  if (file.calc.kind === 'SUM' && known.some((measure) => measure.kind !== 'FLOW')) problems.push(`${file.key}: SUM reads FLOW measures only`)
  if (file.calc.kind === 'BALANCE' && known.some((measure) => measure.kind !== 'BALANCE')) problems.push(`${file.key}: BALANCE reads a BALANCE measure`)
  if (file.calc.kind === 'RATIO' && file.unit !== 'PERCENT' && file.unit !== 'RATIO') problems.push(`${file.key}: a RATIO is a PERCENT or a RATIO`)
  if (file.calc.kind === 'RATIO' && (file.calc.scale === 100) !== (file.unit === 'PERCENT')) problems.push(`${file.key}: a percent scales by 100, a ratio by 1`)
  if (file.calc.kind === 'RATIO' && (!Number.isSafeInteger(file.calc.decimals) || file.calc.decimals < 0 || file.calc.decimals > 4)) problems.push(`${file.key}: 0 to 4 decimals`)
  if (file.unit === 'MONEY' && !file.grain) problems.push(`${file.key}: a MONEY KPI names its grain`)
  if (file.unit === 'MONEY' && known.some((measure) => measure.unit !== 'MONEY')) problems.push(`${file.key}: a MONEY KPI reads money measures`)
  if (file.unit === 'MONEY' && file.grain && known.some((measure) => measure.grain !== grainOfKpi(file.grain!))) problems.push(`${file.key}: a MONEY KPI reads measures of its grain`)
  if (known.some((measure) => measure.grain === 'margin') && file.grain !== 'MARGIN') problems.push(`${file.key}: a KPI that reads margin names the MARGIN grain`)
  if (file.sourceRecords.length < 1 || file.sourceRecords.length > 20 || new Set(file.sourceRecords).size !== file.sourceRecords.length) problems.push(`${file.key}: 1 to 20 source records, each once`)
  for (const [field, limit] of [['nameIt', 120], ['nameEn', 120], ['definitionIt', 2000], ['definitionEn', 2000], ['formulaIt', 1000], ['formulaEn', 1000]] as const) {
    const text = file.words[field]
    if (text.trim().length < 1 || text.length > limit || (field.startsWith('name') && /[\r\n]/.test(text))) problems.push(`${file.key}: ${field} is 1 to ${limit} characters`)
  }
  return problems
}

/** Declares a KPI file; a bad one stops the import (and every test). */
export function defineKpi(file: KpiFile): KpiFile {
  const problems = kpiFileProblems(file)
  if (problems.length > 0) throw new Error(`KPI ${file.key}: ${problems.join('; ')}`)
  return Object.freeze({ ...file, sourceRecords: Object.freeze([...file.sourceRecords]), words: Object.freeze({ ...file.words }) })
}

/** The permissions a person needs to read a KPI's value: those of every measure it reads. */
export function permissionsOfKpi(file: KpiFile): Permission[] {
  return [...new Set(measuresOfCalc(file.calc).map((key) => measureOf(key)!.permission))].sort()
}

/** The money grains a person needs to see a KPI's value: its own and those of its measures. */
export function grainsOfKpi(file: KpiFile): Grain[] {
  const grains = new Set<Grain>(file.grain ? [grainOfKpi(file.grain)] : [])
  for (const key of measuresOfCalc(file.calc)) {
    const grain = measureOf(key)!.grain
    if (grain) grains.add(grain)
  }
  return [...grains].sort()
}
