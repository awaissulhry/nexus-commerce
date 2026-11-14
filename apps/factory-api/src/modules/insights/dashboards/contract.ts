import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ATTENTION_KINDS, SEVERITIES } from '@nexus/factory-domain/insights/attention'
import { BOARD_PANELS, DASHBOARD_KEYS, DASHBOARD_PERIODS, MAX_LAYOUT_PANELS, PANEL_WIDTHS } from '@nexus/factory-domain/insights/dashboards/boards'
import { KPI_DRILL_KINDS, KPI_GRAINS, KPI_UNITS } from '@nexus/factory-domain/insights/kpis/catalogue'
import { MEASURE_SOURCES } from '@nexus/factory-domain/insights/kpis/measures'
import { WIP_AGE_BUCKETS } from '@nexus/factory-domain/insights/kpis/wip'
import { PERIOD_KINDS } from '@nexus/factory-domain/insights/periods/periods'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { KPI_PROBLEMS } from '../kpis/value'

/**
 * The dashboards' contracts (B-W2b-434; ANA-002, ANA-003, ANA-004; design home.dashboards, SCR-031 / SCR-103). Every value is a
 * KPI's (the metric layer's one calculation), free JSON marked with the KPI's grain (`grainedJson`): the grain filter drops a
 * price, cost or margin value for a caller without it. A KPI's name and definition are data of its version (Italian and
 * English); every other word on screen is a code the web says.
 */

const boardParams = input({ board: z.enum(DASHBOARD_KEYS) })
const place = { companyId: id().optional(), siteId: id().optional() }
const ref = output({ id: id(), code: z.string(), name: z.string() })
const periodView = output({ kind: z.enum(PERIOD_KINDS), key: z.string(), from: businessDate(), to: businessDate() })
const said = output({ it: z.string(), en: z.string() })

/** A KPI value's freshness and why it may be missing (design ANA-004: "as of 10:40 · from orders", "Data is 3 h old"). */
const freshness = {
  currency: z.string().nullable(),
  converted: z.array(z.string()),
  asOf: instant().nullable(),
  stale: z.boolean(),
  live: z.boolean(),
  missingDays: z.number().int(),
  problem: z.enum(KPI_PROBLEMS).nullable(),
}

export const boardsContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      boards: z.array(output({ key: z.enum(DASHBOARD_KEYS), mine: z.boolean(), panels: z.array(z.enum(BOARD_PANELS)) })),
      /** The scope's choices: the companies the person reaches, each with its active sites they reach. */
      companies: z.array(output({ ...ref.shape, sites: z.array(ref) })),
    }),
  },
})

const kpiOf = {
  kpiKey: z.string(),
  unit: z.enum(KPI_UNITS),
  grain: z.enum(KPI_GRAINS).nullable(),
  name: said,
}

export const numbersContract = defineContract({
  params: boardParams,
  querystring: input({ period: z.enum(DASHBOARD_PERIODS).optional(), ...place }),
  response: {
    200: output({
      board: z.enum(DASHBOARD_KEYS),
      asOf: instant(),
      period: z.enum(DASHBOARD_PERIODS),
      numbers: z.array(
        output({
          ...kpiOf,
          definition: said,
          formula: said,
          /** The KPI this one stands in for (its place went to the next allowed number), when it moved up. */
          standsFor: output({ kpiKey: z.string(), name: said }).nullable(),
          /** Where its facts come from (design: "from orders"). */
          sources: z.array(z.enum(MEASURE_SOURCES)),
          /** A site was chosen but the KPI is kept per company: the value is the whole company's. */
          wholeCompany: z.boolean(),
          period: periodView,
          value: grainedJson(),
          ...freshness,
          /** The periods before it with the current one last (the number's line). */
          periods: z.array(output({ ...periodView.shape, value: grainedJson() })),
          drill: output({ kind: z.enum(KPI_DRILL_KINDS), key: z.string().nullable(), api: z.string().nullable(), terms: z.record(z.string(), z.string()) }).nullable(),
        }),
      ),
      /** The board's KPIs the person may not read: their places went to the next allowed numbers. */
      withheld: z.array(z.string()),
    }),
  },
})

export const byCompanyContract = defineContract({
  params: boardParams,
  querystring: input({ period: z.enum(DASHBOARD_PERIODS).optional() }),
  response: {
    200: output({
      board: z.enum(DASHBOARD_KEYS),
      asOf: instant(),
      period: periodView,
      columns: z.array(output({ ...kpiOf, perSite: z.boolean() })),
      rows: z.array(
        output({
          company: ref,
          /** Null: the company's own row. */
          site: ref.nullable(),
          cells: z.array(output({ kpiKey: z.string(), value: grainedJson(), perCompanyOnly: z.boolean(), ...freshness })),
          /** On a company row: how many of its active sites the per-site numbers were read for (design: "3 of 4 sites"). */
          sites: output({ read: z.number().int(), of: z.number().int() }).nullable(),
        }),
      ),
    }),
  },
})

export const needsActionContract = defineContract({
  querystring: input(place),
  response: {
    200: output({
      asOf: instant(),
      /** At most five kinds of exception, the worst first, each with how many and its oldest age. */
      rows: z.array(output({ kind: z.enum(ATTENTION_KINDS), count: z.number().int(), severity: z.enum(SEVERITIES), oldestDays: z.number().int().nullable(), complete: z.boolean() })),
      /** Every exception on the person's Today in this scope ("See all N"). */
      all: z.number().int(),
      complete: z.boolean(),
    }),
  },
})

export const trendsContract = defineContract({
  querystring: input(place),
  response: {
    200: output({
      kpi: output(kpiOf),
      target: z.number(),
      weeks: z.array(periodView),
      /** The scope's on-time per week (every company I reach, or the one chosen). */
      values: z.array(grainedJson()),
      /** One line per company when no company is chosen and several are read (shipments are kept per company). */
      series: z.array(output({ company: ref, values: z.array(grainedJson()) })),
      ...freshness,
    }),
  },
})

const ageing = output(Object.fromEntries(WIP_AGE_BUCKETS.map((bucket) => [bucket, z.number().int()])) as Record<(typeof WIP_AGE_BUCKETS)[number], z.ZodNumber>)

export const wipContract = defineContract({
  querystring: input(place),
  response: {
    200: output({
      asOf: instant(),
      kpiKey: z.string(),
      overall: output({ workOrders: z.number().int(), pieces: z.number().int(), waiting: z.number().int() }),
      /** The stages in the routing's order, each with its garments waiting by age band and the work orders there. */
      stages: z.array(output({ code: z.string(), name: z.string(), workOrders: z.number().int(), waiting: z.number().int(), ageing })),
    }),
  },
})

const layoutPanel = output({ id: z.string(), hidden: z.boolean(), width: z.enum(PANEL_WIDTHS) })
const layoutView = output({ board: z.enum(DASHBOARD_KEYS), panels: z.array(layoutPanel), saved: z.boolean(), version: z.number().int(), updatedAt: instant().nullable() })

export const layoutContract = defineContract({ params: boardParams, response: { 200: layoutView } })

export const saveLayoutContract = defineContract({
  params: boardParams,
  body: input({
    panels: z.array(input({ id: z.string().max(120), hidden: z.boolean(), width: z.string().max(20) })).min(1).max(MAX_LAYOUT_PANELS),
    /** The version read (0: nothing saved yet). */
    version: z.number().int().min(0),
  }),
  response: { 200: layoutView },
})

export const resetLayoutContract = defineContract({
  params: boardParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: layoutView },
})
