import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { measuresOfCalc } from '@nexus/factory-domain/insights/kpis/calc'
import { KPI_KEY, type KpiFile } from '@nexus/factory-domain/insights/kpis/catalogue'
import { KPI_CATALOGUE, kpiFileOf } from '@nexus/factory-domain/insights/kpis/registry'
import type { Period } from '@nexus/factory-domain/insights/periods/periods'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../viewer'
import { inForce, namesFor, shownVersion, usesOf, versionsOf, type VersionRow } from './store'
import { kpiNow, markedValue, type KpiReading, type NowQuery } from './value'

/**
 * The KPI library's reads (B-W2b-428; ANA-012; design home.kpis "Every KPI" and the KPI record: Definition with Now, Where
 * used, History), office, home.kpis.view. Every KPI of the code catalogue and every key the database has versions of: the
 * version in force (else the newest draft), its calculation, where it is used, and its value in the person's scope with the
 * periods before it (kpis/value.ts, the one calculation). A KPI's words are data of its version, in Italian and English.
 * Margin and money values are marked with their grain (the grain filter drops them for anyone without it): a KPI is listed
 * for everyone with the library, its value only with its rights (design: "margin KPIs list for everyone but their values show
 * only with the margin grain").
 */

type Names = Awaited<ReturnType<typeof namesFor>>

function versionView(row: VersionRow, names: Names) {
  const role = names.roles.get(row.ownerRoleId)
  return {
    id: row.id,
    kpiVersion: row.kpiVersion,
    state: row.state,
    nameIt: row.nameIt,
    nameEn: row.nameEn,
    definitionIt: row.definitionIt,
    definitionEn: row.definitionEn,
    formulaIt: row.formulaIt,
    formulaEn: row.formulaEn,
    sourceRecords: [...row.sourceRecords],
    measureKeys: [...row.measureKeys],
    owner: { roleId: row.ownerRoleId, key: role?.key ?? null, name: role?.name ?? null },
    unit: row.unit,
    grain: row.grain,
    basedOnId: row.basedOnId,
    changeNote: row.changeNote,
    createdAt: toUtcIso(row.createdAt),
    createdBy: row.createdById ? (names.users.get(row.createdById) ?? null) : null,
    activatedAt: row.activatedAt ? toUtcIso(row.activatedAt) : null,
    activatedBy: row.activatedById ? (names.users.get(row.activatedById) ?? null) : null,
    endedAt: row.endedAt ? toUtcIso(row.endedAt) : null,
    endedBy: row.endedById ? (names.users.get(row.endedById) ?? null) : null,
    version: row.version,
  }
}

function calculationView(file: KpiFile | null) {
  if (!file) return null
  return {
    kind: file.calc.kind,
    measures: measuresOfCalc(file.calc),
    period: file.period,
    unit: file.unit,
    grain: file.grain,
    ownerRole: file.ownerRole,
    /** The records behind it: a report of the pack (`key`) or an area list (`api`), with its filters (`terms`). */
    drill: file.drill
      ? file.drill.kind === 'REPORT'
        ? { kind: file.drill.kind, key: file.drill.key, api: null, terms: { ...file.drill.filters } }
        : { kind: file.drill.kind, key: null, api: file.drill.api, terms: { ...file.drill.query } }
      : null,
  }
}

const sameMeasures = (row: VersionRow | null, file: KpiFile | null): boolean => {
  if (!row || !file) return true
  const reads = measuresOfCalc(file.calc)
  return reads.length === row.measureKeys.length && reads.every((key) => row.measureKeys.includes(key))
}

function valueView(file: KpiFile | null, periods: readonly Period[], reading: KpiReading | null) {
  if (!file || !reading) return { period: null, value: null, currency: null, converted: [], asOf: null, stale: false, live: false, missingDays: 0, problem: 'NO_CALCULATION' as const, periods: [] }
  const current = periods.at(-1)!
  return {
    period: { kind: current.kind, key: current.key, from: current.from, to: current.to },
    value: markedValue(file, reading.values.at(-1) ?? null),
    currency: reading.currency,
    converted: reading.converted,
    asOf: reading.asOf ? toUtcIso(reading.asOf) : null,
    stale: reading.stale,
    live: reading.live,
    missingDays: reading.missingDays,
    problem: reading.problem,
    periods: periods.map((period, index) => ({ kind: period.kind, key: period.key, from: period.from, to: period.to, value: markedValue(file, reading.values[index] ?? null) })),
  }
}

function itemOf(key: string, rows: readonly VersionRow[], names: Names, uses: number) {
  const file = kpiFileOf(key)
  const shown = shownVersion(rows)
  const current = inForce(rows)
  return {
    key,
    calculation: calculationView(file),
    shown: shown ? versionView(shown, names) : null,
    inForce: current ? { id: current.id, kpiVersion: current.kpiVersion } : null,
    drafts: rows.filter((row) => row.state === 'DRAFT').length,
    /** A version that names other facts than the calculation reads (written before the calculation, or by hand). */
    measuresDiffer: !sameMeasures(current ?? shown, file),
    /** No version yet: the standard words the sync installs as version 1. */
    standardWords: !shown && file ? { ...file.words } : null,
    uses,
  }
}

/** GET /insights/kpis: every KPI, with its value now (its own period, current) in my scope. */
export async function kpiLibrary(caller: CommandCaller, query: NowQuery) {
  const actor = actorOf(officeContextOf(caller))
  const { rows, uses, names } = await caller.withClient(async (db) => {
    const rows = await versionsOf(db)
    return { rows, uses: await usesOf(db), names: await namesFor(db, rows) }
  })
  const keys = [...new Set([...KPI_CATALOGUE.map((file) => file.key), ...rows.map((row) => row.kpiKey)])].sort()
  const kpis = []
  for (const key of keys) {
    const file = kpiFileOf(key)
    const item = itemOf(key, rows.filter((row) => row.kpiKey === key), names, uses.filter((use) => use.kpiKey === key).length)
    const now = file ? await kpiNow(caller, actor, file, { ...query, periods: 1 }) : null
    kpis.push({ ...item, value: valueView(file, now?.periods ?? [], now?.reading ?? null) })
  }
  return { asOf: toUtcIso(serverClock.now()), kpis }
}

function checkKey(key: string): void {
  if (!KPI_KEY.test(key) || key.length > 120) throw new NotFoundError('KPI not found.')
}

/** GET /insights/kpis/:key: one KPI with its history of versions, where it is used and its value with the periods before. */
export async function kpiRecord(caller: CommandCaller, key: string, query: NowQuery) {
  checkKey(key)
  const actor: Actor = actorOf(officeContextOf(caller))
  const file = kpiFileOf(key)
  const { rows, uses, names } = await caller.withClient(async (db) => {
    const rows = await versionsOf(db, [key])
    return { rows, uses: await usesOf(db, [key]), names: await namesFor(db, rows) }
  })
  if (!file && rows.length === 0) throw new NotFoundError('KPI not found.')
  const now = file ? await kpiNow(caller, actor, file, query) : null
  return {
    ...itemOf(key, rows, names, uses.length),
    versions: rows.map((row) => versionView(row, names)),
    usedIn: uses.map((use) => ({ usedIn: use.usedIn, useKey: use.useKey, since: toUtcIso(use.createdAt) })),
    value: valueView(file, now?.periods ?? [], now?.reading ?? null),
  }
}

/** GET /insights/kpis/:key/value: the value in my scope over a period kind (12 by default) at a place. */
export async function kpiValueAnswer(caller: CommandCaller, key: string, query: NowQuery) {
  checkKey(key)
  const actor = actorOf(officeContextOf(caller))
  const file = kpiFileOf(key)
  if (!file) {
    const known = await caller.withClient((db) => db.kpiDefinition.count({ where: { kpiKey: key } }))
    if (known === 0) throw new NotFoundError('KPI not found.')
  }
  const now = file ? await kpiNow(caller, actor, file, query) : null
  return { key, unit: file?.unit ?? null, grain: file?.grain ?? null, ...valueView(file, now?.periods ?? [], now?.reading ?? null) }
}
