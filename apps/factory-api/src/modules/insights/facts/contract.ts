import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MEASURE_KINDS, MEASURE_LEVELS, MEASURE_SOURCES, MEASURE_UNITS } from '@nexus/factory-domain/insights/kpis/measures'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { FACT_GROUPINGS } from './answers'

/**
 * The metric layer's facts and measures (B-W2b-428; ANA-069, ANA-028). A fact's number is free JSON marked with its measure's
 * grain (`grainedJson`): the grain filter drops a money value for a caller without its grain (the read also refuses the
 * measure first, 403 `grain/<grain>`).
 */

const FACT_GRAINS = ['price', 'cost', 'margin'] as const

export const measuresContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      measures: z.array(
        output({
          key: z.string(),
          source: z.enum(MEASURE_SOURCES),
          unit: z.enum(MEASURE_UNITS),
          grain: z.enum(FACT_GRAINS).nullable(),
          kind: z.enum(MEASURE_KINDS),
          levels: z.array(z.enum(MEASURE_LEVELS)),
          hourly: z.boolean(),
          permission: z.string(),
          records: z.array(z.string()),
          /** I hold its list permission and its grain. */
          readable: z.boolean(),
        }),
      ),
      /** How fresh each company's facts are (the companies of my library). */
      companies: z.array(output({ id: id(), code: z.string(), today: businessDate(), lastRebuiltAt: instant().nullable(), lastDay: businessDate().nullable() })),
    }),
  },
})

export const factsContract = defineContract({
  querystring: input({
    measure: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).max(100),
    from: businessDate(),
    to: businessDate(),
    by: z.enum(FACT_GROUPINGS).optional(),
    companyId: id().optional(),
    siteId: id().optional(),
    lineId: id().optional(),
  }),
  response: {
    200: output({
      measure: z.string(),
      unit: z.enum(MEASURE_UNITS),
      grain: z.enum(FACT_GRAINS).nullable(),
      kind: z.enum(MEASURE_KINDS),
      by: z.enum(FACT_GROUPINGS),
      from: businessDate(),
      to: businessDate(),
      complete: z.boolean(),
      rows: z.array(
        output({
          companyId: id(),
          siteId: id().nullable(),
          lineId: id().nullable(),
          /** The business day on the place's clock (a shift: the day it began). */
          day: businessDate(),
          hourStart: instant().nullable(),
          shift: output({ label: z.string(), start: instant(), end: instant() }).nullable(),
          /** A decimal string (minor units of `currency` for money), marked with the measure's grain. */
          value: grainedJson(),
          currency: z.string().nullable(),
          rebuiltAt: instant().nullable(),
        }),
      ),
    }),
  },
})

export const rebuildContract = defineContract({
  body: input({ from: businessDate(), to: businessDate(), companyId: id().optional() }),
  response: {
    200: output({
      from: businessDate(),
      to: businessDate(),
      sources: z.array(z.enum(MEASURE_SOURCES)),
      rebuiltAt: instant(),
      companies: z.array(output({ companyId: id(), daily: z.number().int(), hourly: z.number().int() })),
    }),
  },
})
