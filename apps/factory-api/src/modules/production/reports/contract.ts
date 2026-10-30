import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LANE_KINDS } from '@nexus/factory-domain/production/reports/daily'
import { LINE_STATES } from '@nexus/factory-domain/production/reports/lines'
import { MAX_RECIPIENTS, REPORT_KEYS, REPORT_LOCALES } from '@nexus/factory-domain/production/reports/subscriptions'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'

/**
 * Production reports (B-W2a-38; MES-301, MES-160; design production.reports, production.floor "Lines"). Quantities are
 * garments; minutes and percents are decimal strings with one place. No field carries money; no field names a person
 * of the floor (Statuto dei Lavoratori art. 4; Owner answers W1, F2): figures per line, work centre, style and size,
 * and per station only whether someone is signed in and whether a machine at it is down. A subscription names its
 * office recipient (they read their own mail settings).
 */

const site = output({ id: id(), code: z.string(), name: z.string() })
const style = output({ id: id(), code: z.string(), name: z.string() })
const pct = () => z.string().regex(/^\d{1,6}\.\d$/).nullable()
const minutes = () => z.string().regex(/^\d{1,12}\.\d$/).nullable()
const figures = { good: z.number().int(), scrap: z.number().int(), rework: z.number().int() }

export const dailyContract = defineContract({
  querystring: input({
    /** Default: the first site (by code) the caller reads the report at. */
    siteId: id().optional(),
    /** Default: today at the site. */
    date: businessDate().optional(),
  }),
  response: {
    200: output({
      site: output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string() }),
      /** Every site the caller reads the report at (the page's scope). */
      sites: z.array(site),
      day: businessDate(),
      /** Today at the site: the day "so far" when `day` is today. */
      today: businessDate(),
      /** The site's working day before `day` (the morning mail's day), and the one after it (null: none, or after today). */
      previousWorkingDay: businessDate().nullable(),
      nextDay: businessDate().nullable(),
      /** Whether `day` is a working day of the site's calendar. */
      workingDay: z.boolean(),
      asOf: instant(),
      lanes: z.array(
        output({
          kind: z.enum(LANE_KINDS),
          id: id(),
          code: z.string(),
          name: z.string(),
          ...figures,
          /** LINE only: earned standard minutes, people × working minutes, and their percent (null: nothing available). */
          earnedMinutes: minutes(),
          availableMinutes: minutes(),
          efficiencyPct: pct(),
          /** LINE only: people per shift (a headcount, never who) and the line's working minutes that day. */
          people: z.number().int().nullable(),
          workingMinutes: z.number().int().nullable(),
          rows: z.array(output({ style, size: z.string(), ...figures })),
        }),
      ),
      /** Garments of every lane together (not money). */
      totals: notMoney(output(figures)),
    }),
  },
})

export const linesContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      asOf: instant(),
      /** The sites the caller sees the floor of (workorders.view). */
      sites: z.array(output({ id: id(), code: z.string(), name: z.string(), timeZone: z.string(), today: businessDate() })),
      lines: z.array(
        output({
          id: id(),
          code: z.string(),
          name: z.string(),
          site: output({ id: id(), code: z.string() }),
          state: z.enum(LINE_STATES),
          /** The last report from a station of the line today (null: none today). */
          lastScanAt: instant().nullable(),
          /** The open work orders allocated to it or planned on it today (RELEASED, IN_PROGRESS, ON_HOLD). */
          workOrders: z.array(output({ id: id(), number: z.string(), status: z.enum(WORK_ORDER_STATUSES), style })),
          /** Garments the floor's published plan puts through the line today; null: no plan published for today. */
          plannedToday: z.number().int().nullable(),
          /** The published version the plan comes from. */
          plan: output({ number: z.number().int() }).nullable(),
          /** Garments through the line's last operation today (the daily report's good). */
          output: z.number().int(),
          outputPct: z.number().int().nullable(),
          /** The operation of its work orders where most pieces wait (null: nothing waits). */
          bottleneck: output({ workOrderId: id(), workOrderNumber: z.string(), operationId: id(), seq: z.number().int(), code: z.string(), name: z.string(), waiting: z.number().int() }).nullable(),
          /** Owner F2: per station only "nobody signed in" and machine down; never who. */
          stations: z.array(
            output({
              id: id(),
              code: z.string(),
              name: z.string(),
              signedIn: z.boolean(),
              machinesDown: z.array(output({ assetNumber: z.string(), status: z.enum(['DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE']) })),
            }),
          ),
        }),
      ),
    }),
  },
})

const subscriptionView = output({
  id: id(),
  reportKey: z.enum(REPORT_KEYS),
  user: output({ id: id(), name: z.string() }),
  /** It is the caller's own (else one the caller made for a colleague). */
  mine: z.boolean(),
  site: site.nullable(),
  sendTime: z.string(),
  weekdays: z.array(z.number().int()),
  locale: z.enum(REPORT_LOCALES),
  active: z.boolean(),
  lastSentAt: instant().nullable(),
  version: z.number().int(),
})

export const subscriptionsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ subscriptions: z.array(subscriptionView) }) },
})

export const recipientsContract = defineContract({
  querystring: input({ siteId: id() }),
  response: {
    200: output({
      /** Active office people who may read the report at the site (the caller first), and whether each gets it already. */
      people: z.array(output({ id: id(), name: z.string(), me: z.boolean(), subscribed: z.boolean() })),
    }),
  },
})

export const subscribeContract = defineContract({
  body: input({
    reportKey: z.enum(REPORT_KEYS).default('production.daily'),
    siteId: id(),
    /** Default: the caller alone. Anyone else needs production.reports.subscribe. */
    recipients: z.array(id()).min(1).max(MAX_RECIPIENTS).optional(),
    sendTime: z.string(),
    weekdays: z.array(z.number().int()).min(1).max(7),
    /** null: each recipient's own language. */
    locale: z.enum(REPORT_LOCALES).nullable().default(null),
  }),
  response: { 200: output({ subscriptions: z.array(subscriptionView) }), 201: output({ subscriptions: z.array(subscriptionView) }) },
})

export const changeSubscriptionContract = defineContract({
  params: input({ subscriptionId: id() }),
  body: input({
    version: z.number().int().min(1),
    active: z.boolean().optional(),
    sendTime: z.string().optional(),
    weekdays: z.array(z.number().int()).min(1).max(7).optional(),
    locale: z.enum(REPORT_LOCALES).optional(),
  }),
  response: { 200: output({ subscription: subscriptionView }) },
})

export type DailyQuery = z.infer<typeof dailyContract.querystring>
export type SubscribeBody = z.infer<typeof subscribeContract.body>
export type ChangeSubscriptionBody = z.infer<typeof changeSubscriptionContract.body>
