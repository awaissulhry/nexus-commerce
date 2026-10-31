import { z } from 'zod'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FLOW_LENSES } from '@nexus/factory-domain/insights/flow'
import { COLUMN_KINDS, FILTER_KINDS, REPORT_AREAS, REPORT_FORMATS } from '@nexus/factory-domain/insights/reports/definition'
import { NUMBER_UNITS, TARGET_DIRECTIONS, TARGET_WORDS } from '@nexus/factory-domain/insights/reports/numbers'
import { LIBRARY_STATES } from '@nexus/factory-domain/insights/reports/rights'
import { grainedJson, notMoney } from '@nexus/factory-domain/money/marked'
import { NUMBER_PROBLEMS } from './numbers'

/**
 * The report pack's and My numbers' contracts (B-W2a-79; design home.reports, home.today key-numbers). A report's cells,
 * totals and groups are free JSON whose money and margin values are marked with their grain (`grainedJson`): the grain
 * filter drops a marked value for a caller without its grain, and the columns of such a grain are left out before the
 * read (ANA-034). A number's value and line are marked the same way.
 */

const KEY = /^[a-z]+\.[a-z][a-z0-9-]*$/
const reportKey = () => z.string().regex(KEY)
const keyParams = input({ key: reportKey() })

const column = output({
  key: z.string(),
  label: z.string(),
  kind: z.enum(COLUMN_KINDS),
  grain: z.enum(GRAINS).nullable(),
  /** A figure made by a group of people (blanked for a group under 5 people). */
  people: z.boolean(),
  sum: z.boolean(),
  group: z.boolean(),
})

const filterChoice = output({ value: z.string(), label: z.string() })

export const libraryContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      areas: z.array(output({ area: z.enum(REPORT_AREAS), label: z.string() })),
      reports: z.array(
        output({
          key: z.string(),
          area: z.enum(REPORT_AREAS),
          title: z.string(),
          question: z.string(),
          /** READY · NO_ACCESS (the list it reads is not the person's) · NEEDS_GRAIN (`grain`). */
          state: z.enum(LIBRARY_STATES),
          grain: z.enum(GRAINS).nullable(),
          permission: z.string(),
          formats: z.array(z.enum(REPORT_FORMATS)),
          /** The e-mailed report it shares its rows with (production.daily), or null. */
          mail: z.string().nullable(),
          /** The person receives that e-mail now (the library's schedule badge). */
          mailed: z.boolean(),
        }),
      ),
    }),
  },
})

export const reportAboutContract = defineContract({
  params: keyParams,
  response: {
    200: output({
      key: z.string(),
      area: z.enum(REPORT_AREAS),
      title: z.string(),
      question: z.string(),
      state: z.enum(LIBRARY_STATES),
      grain: z.enum(GRAINS).nullable(),
      permission: z.string(),
      columns: z.array(column),
      /** What the person's rights leave out of every run (named on the page). */
      leftOut: output({ grains: z.array(z.enum(GRAINS)), columns: z.array(output({ key: z.string(), label: z.string(), grain: z.enum(GRAINS).nullable() })) }),
      filters: z.array(output({ key: z.string(), label: z.string(), kind: z.enum(FILTER_KINDS), default: z.string().nullable(), choices: z.array(filterChoice) })),
      groupBy: z.string().nullable(),
      sources: z.string(),
      definition: z.string(),
      refresh: z.enum(['LIVE']),
      numbers: z.array(output({ key: z.string(), label: z.string() })),
      mail: z.string().nullable(),
      formats: z.array(z.enum(REPORT_FORMATS)),
    }),
  },
})

export const reportResultsContract = defineContract({
  params: keyParams,
  // The report's own filters by key (unknown keys are ignored), the grouping and the reader's language.
  querystring: z
    .object({ group: z.string().max(40).optional(), lang: z.enum(['it', 'en']).optional() })
    .catchall(z.string().max(200)),
  response: {
    200: output({
      key: z.string(),
      asOf: instant(),
      today: z.string(),
      /** What the server applied, filter by filter (its value and words). */
      applied: z.array(output({ key: z.string(), value: z.string().nullable(), label: z.string().nullable() })),
      range: output({ from: z.string(), to: z.string() }).nullable(),
      columns: z.array(column),
      rows: z.array(
        output({
          id: z.string(),
          record: output({ type: z.string(), id: z.string(), label: z.string() }).nullable(),
          currency: z.string().nullable(),
          cells: grainedJson(),
        }),
      ),
      totals: notMoney(output({ rows: z.number().int(), sums: grainedJson(), currency: z.string().nullable(), mixedCurrencies: z.boolean() })),
      groupBy: z.string().nullable(),
      groups: z.array(output({ value: z.union([z.string(), z.number()]).nullable(), rows: z.number().int(), sums: grainedJson(), currency: z.string().nullable() })).nullable(),
      /** "What you see": the grains left out and the groups of fewer than 5 people blanked; null: nothing to say. */
      rights: output({ leftOut: z.array(z.enum(GRAINS)), hiddenGroups: z.number().int() }).nullable(),
      complete: z.boolean(),
      limit: z.number().int(),
    }),
  },
})

export const reportScheduleContract = defineContract({
  params: keyParams,
  response: {
    200: output({
      key: z.string(),
      mail: z.string().nullable(),
      /** False: no schedule exists for this report yet (scheduling any report comes later). */
      schedulable: z.boolean(),
      subscriptions: z.array(
        output({
          id: id(),
          user: output({ id: id(), name: z.string() }),
          mine: z.boolean(),
          site: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          sendTime: z.string(),
          weekdays: z.array(z.number().int()),
          locale: z.enum(['it', 'en']),
          active: z.boolean(),
          lastSentAt: instant().nullable(),
        }),
      ),
      /** The page where the subscriptions are changed (company-free), or null. */
      manage: z.string().nullable(),
    }),
  },
})

export const numbersContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      today: z.string(),
      lenses: z.array(
        output({
          lens: z.enum(FLOW_LENSES),
          numbers: z.array(
            output({
              key: z.string(),
              label: z.string(),
              unit: z.enum(NUMBER_UNITS),
              grain: z.enum(GRAINS).nullable(),
              /** The number (money in minor units; a percent with one decimal), marked with its grain; null: see `problem`. */
              value: grainedJson(),
              currency: z.string().nullable(),
              target: output({ value: z.number(), direction: z.enum(TARGET_DIRECTIONS) }).nullable(),
              targetWord: z.enum(TARGET_WORDS).nullable(),
              history: z.boolean(),
              /** The last 8 weeks, oldest first (marked like the value); null: counted now only. */
              spark: grainedJson(),
              complete: z.boolean(),
              problem: z.enum(NUMBER_PROBLEMS).nullable(),
              list: output({ api: z.string(), query: z.record(z.string(), z.string()) }).nullable(),
              report: output({ key: z.string(), filters: z.record(z.string(), z.string()) }).nullable(),
              explain: output({ definition: z.string(), formula: z.string(), sources: z.string(), period: z.string(), cutOff: z.string(), setBy: z.string().nullable() }),
            }),
          ),
        }),
      ),
    }),
  },
})
