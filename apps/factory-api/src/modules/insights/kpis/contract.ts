import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CALC_KINDS } from '@nexus/factory-domain/insights/kpis/calc'
import { KPI_DRILL_KINDS, KPI_GRAINS, KPI_STATES, KPI_UNITS, KPI_USE_KINDS } from '@nexus/factory-domain/insights/kpis/catalogue'
import { KPI_LIMITS } from '@nexus/factory-domain/insights/kpis/checks'
import { PERIOD_KINDS, MAX_PERIODS } from '@nexus/factory-domain/insights/periods/periods'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { KPI_PROBLEMS } from './value'

/**
 * The KPI library's contracts (B-W2b-428; ANA-012, ANA-070; design home.kpis, SCR-249 of B-W2b-433). A KPI's words are data
 * of its version (Italian and English); its value is free JSON marked with the KPI's grain (`grainedJson`), so the grain
 * filter drops a price, cost or margin value for a caller without it.
 */

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const kpiKey = () => z.string().regex(KEY).max(100)
const keyParams = input({ key: kpiKey() })
const idParams = input({ id: id() })

const nowQuery = input({
  period: z.enum(PERIOD_KINDS).optional(),
  periods: z.coerce.number().int().min(1).max(MAX_PERIODS).optional(),
  day: businessDate().optional(),
  companyId: id().optional(),
  siteId: id().optional(),
  lineId: id().optional(),
})

const versionView = output({
  id: id(),
  kpiVersion: z.number().int(),
  state: z.enum(KPI_STATES),
  nameIt: z.string(),
  nameEn: z.string(),
  definitionIt: z.string(),
  definitionEn: z.string(),
  formulaIt: z.string(),
  formulaEn: z.string(),
  sourceRecords: z.array(z.string()),
  measureKeys: z.array(z.string()),
  owner: output({ roleId: id(), key: z.string().nullable(), name: z.string().nullable() }),
  unit: z.enum(KPI_UNITS),
  grain: z.enum(KPI_GRAINS).nullable(),
  basedOnId: id().nullable(),
  changeNote: z.string().nullable(),
  createdAt: instant(),
  createdBy: z.string().nullable(),
  activatedAt: instant().nullable(),
  activatedBy: z.string().nullable(),
  endedAt: instant().nullable(),
  endedBy: z.string().nullable(),
  version: z.number().int(),
})

const words = output({ nameIt: z.string(), nameEn: z.string(), definitionIt: z.string(), definitionEn: z.string(), formulaIt: z.string(), formulaEn: z.string() })

const calculation = output({
  kind: z.enum(CALC_KINDS),
  measures: z.array(z.string()),
  period: z.enum(PERIOD_KINDS),
  unit: z.enum(KPI_UNITS),
  grain: z.enum(KPI_GRAINS).nullable(),
  ownerRole: z.string(),
  drill: output({ kind: z.enum(KPI_DRILL_KINDS), key: z.string().nullable(), api: z.string().nullable(), terms: z.record(z.string(), z.string()) }).nullable(),
})

const periodView = output({ kind: z.enum(PERIOD_KINDS), key: z.string(), from: businessDate(), to: businessDate() })

const valueView = output({
  period: periodView.nullable(),
  /** The current period's value: a decimal string (minor units for money, a percent `93.5`), marked with the KPI's grain. */
  value: grainedJson(),
  currency: z.string().nullable(),
  /** Currencies counted in `currency` at each day's rate. */
  converted: z.array(z.string()),
  asOf: instant().nullable(),
  /** The facts read were rebuilt more than 3 hours ago. */
  stale: z.boolean(),
  /** Computed now from my own records (my grant is limited to some customers). */
  live: z.boolean(),
  missingDays: z.number().int(),
  problem: z.enum(KPI_PROBLEMS).nullable(),
  periods: z.array(output({ kind: z.enum(PERIOD_KINDS), key: z.string(), from: businessDate(), to: businessDate(), value: grainedJson() })),
})

const item = {
  key: z.string(),
  calculation: calculation.nullable(),
  shown: versionView.nullable(),
  inForce: output({ id: id(), kpiVersion: z.number().int() }).nullable(),
  drafts: z.number().int(),
  measuresDiffer: z.boolean(),
  standardWords: words.nullable(),
  uses: z.number().int(),
  value: valueView,
}

export const libraryContract = defineContract({
  querystring: nowQuery,
  response: { 200: output({ asOf: instant(), kpis: z.array(output(item)) }) },
})

export const recordContract = defineContract({
  params: keyParams,
  querystring: nowQuery,
  response: {
    200: output({
      ...item,
      versions: z.array(versionView),
      usedIn: z.array(output({ usedIn: z.enum(KPI_USE_KINDS), useKey: z.string(), since: instant() })),
    }),
  },
})

export const valueContract = defineContract({
  params: keyParams,
  querystring: nowQuery,
  response: { 200: output({ key: z.string(), unit: z.enum(KPI_UNITS).nullable(), grain: z.enum(KPI_GRAINS).nullable(), ...valueView.shape }) },
})

const fields = {
  nameIt: z.string().max(KPI_LIMITS.name).optional(),
  nameEn: z.string().max(KPI_LIMITS.name).optional(),
  definitionIt: z.string().max(KPI_LIMITS.definition).optional(),
  definitionEn: z.string().max(KPI_LIMITS.definition).optional(),
  formulaIt: z.string().max(KPI_LIMITS.formula).optional(),
  formulaEn: z.string().max(KPI_LIMITS.formula).optional(),
  sourceRecords: z.array(z.string().max(63)).max(KPI_LIMITS.records).optional(),
  measureKeys: z.array(z.string().max(100)).max(KPI_LIMITS.measures).optional(),
  ownerRoleId: id().optional(),
  unit: z.enum(KPI_UNITS).optional(),
  grain: z.enum(KPI_GRAINS).nullable().optional(),
}

const written = output({ id: id(), kpiKey: z.string(), kpiVersion: z.number().int(), version: z.number().int() })

export const draftContract = defineContract({
  params: keyParams,
  body: input({ basedOnId: id(), changeNote: z.string().max(KPI_LIMITS.changeNote), ...fields }),
  response: { 201: written },
})

export const editContract = defineContract({
  params: idParams,
  body: input({ version: z.number().int().min(1), changeNote: z.string().max(KPI_LIMITS.changeNote).optional(), ...fields }),
  response: { 200: written },
})

export const activateContract = defineContract({
  params: idParams,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ ...written.shape, supersededId: id().nullable() }) },
})

export const retireContract = defineContract({
  params: keyParams,
  body: input({ version: z.number().int().min(1) }),
  response: { 200: output({ ...written.shape, usesRemoved: z.number().int() }) },
})

export const deleteContract = defineContract({
  params: idParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ id: id(), deleted: z.literal(true) }) },
})

const useRef = output({ kpiKey: z.string(), usedIn: z.enum(KPI_USE_KINDS), useKey: z.string() })

export const syncContract = defineContract({
  response: { 200: output({ installed: z.array(z.string()), skipped: z.array(z.string()), usesAdded: z.array(useRef), usesRemoved: z.array(useRef) }) },
})
