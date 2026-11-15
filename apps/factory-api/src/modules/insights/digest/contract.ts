import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DIGEST_LOCALES, DIGEST_SECTIONS } from '@nexus/factory-domain/insights-digest/digest'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The owner digest's contracts (B-W2b-435; ANA-032; design home.reports `digest`, home.today ⋯ "Daily digest by e-mail") and
 * Today's value per stage. Every word on screen is a code the web says, except the preview's mail lines: the e-mail itself, as it
 * would go out, in the language asked (composed for the reader, so a money figure is in it only with its grain). Amounts are
 * marked by grain (the grain filter drops them for a caller without it).
 */

const locale = z.enum(DIGEST_LOCALES)
const section = z.enum(DIGEST_SECTIONS)

const settingView = output({
  saved: z.boolean(),
  enabled: z.boolean(),
  enabledAt: instant().nullable(),
  companyId: id().nullable(),
  sendTime: z.string(),
  timeZone: z.string(),
  weekdays: z.array(z.number().int()),
  locale,
  sections: z.array(section),
  lastSentAt: instant().nullable(),
  version: z.number().int(),
})

const digestAnswer = output({
  asOf: instant(),
  setting: settingView,
  /** My own address (where it goes). */
  email: z.string().nullable(),
  /** Why it would not go out now: OFF (mine is off), MAIL_OFF (no company it covers is switched on); null: it goes out. */
  held: z.enum(['OFF', 'MAIL_OFF']).nullable(),
  nextAt: instant().nullable(),
  companies: z.array(
    output({
      id: id(),
      code: z.string(),
      name: z.string(),
      timeZone: z.string(),
      mailOn: z.boolean(),
      mailOnAt: instant().nullable(),
      maySwitch: z.boolean(),
      switchVersion: z.number().int(),
      /** Who gets it there: only for a company whose switch I hold (else null). Names inside the settings only. */
      recipients: z.array(output({ id: id(), name: z.string(), me: z.boolean(), group: z.boolean(), sendTime: z.string(), timeZone: z.string(), locale })).nullable(),
    }),
  ),
})

export const digestContract = defineContract({ response: { 200: digestAnswer } })

export const saveDigestContract = defineContract({
  body: input({
    enabled: z.boolean(),
    sendTime: z.string().max(5),
    weekdays: z.array(z.number().int()).max(7),
    locale,
    sections: z.array(section).max(DIGEST_SECTIONS.length),
    companyId: id().nullable(),
    version: z.number().int().min(0),
  }),
  response: { 200: digestAnswer },
})

export const switchDigestContract = defineContract({
  body: input({ companyId: id(), on: z.boolean(), version: z.number().int().min(0) }),
  response: { 200: digestAnswer },
})

const itemView = output({ label: z.string(), days: z.number().int().nullable(), place: z.string().nullable(), record: output({ type: z.string(), id: id() }).nullable() })

export const previewDigestContract = defineContract({
  querystring: input({
    locale: locale.optional(),
    companyId: z.union([id(), z.literal('all')]).optional(),
    sections: z.string().max(200).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      locale,
      companyId: id().nullable(),
      day: businessDate(),
      today: businessDate(),
      companies: z.array(z.string()),
      wouldSend: z.boolean(),
      sections: z.array(
        output({
          section,
          state: z.enum(['READY', 'NO_ACCESS', 'FAILED']),
          count: z.number().int(),
          extra: z.number().int().nullable(),
          percent: z.string().nullable(),
          priceValue: money.price(z.number().int().nullable()),
          costValue: money.cost(z.number().int().nullable()),
          currency: z.string().nullable(),
          items: z.array(itemView),
        }),
      ),
      mail: output({ subject: z.string(), lines: z.array(z.string()), to: z.string().nullable() }),
    }),
  },
})

export const testDigestContract = defineContract({
  body: input({ locale: locale.optional() }),
  response: { 200: output({ sent: z.boolean(), to: z.string(), subject: z.string() }) },
})

export const flowValueContract = defineContract({
  querystring: input({ companyId: id().optional(), siteId: id().optional() }),
  response: {
    200: output({
      asOf: instant(),
      lens: z.literal('WORK_ORDERS'),
      /** False: the person lacks the cost grain or costing.view; the strip stays counts only. */
      valued: z.boolean(),
      currency: z.string().nullable(),
      mixedCurrencies: z.boolean(),
      complete: z.boolean(),
      stages: z.array(output({ key: z.string(), workOrders: z.number().int(), value: money.cost(z.number().int().nullable()) })),
    }),
  },
})

// ---- "E-mail me this" for any report (follow-up DG1:01; ../reports/subscriptions.ts) ----------------------------------------

const reportParams = input({ key: z.string().min(1).max(80) })

const subscriptionView = output({
  id: id(),
  reportKey: z.string(),
  /** The run's filters by the report's own keys (a site filter: a site id). */
  filters: z.record(z.string(), z.string()),
  siteId: id().nullable(),
  sendTime: z.string(),
  timeZone: z.string(),
  weekdays: z.array(z.number().int()),
  locale,
  active: z.boolean(),
  lastSentAt: instant().nullable(),
  nextAt: instant().nullable(),
  version: z.number().int(),
})

export const reportSubscriptionsContract = defineContract({
  querystring: input({ reportKey: z.string().min(1).max(80).optional() }),
  response: { 200: output({ asOf: instant(), subscriptions: z.array(subscriptionView) }) },
})

export const subscribeReportContract = defineContract({
  params: reportParams,
  body: input({
    sendTime: z.string().max(5),
    weekdays: z.array(z.number().int()).max(7),
    locale,
    filters: z.record(z.string().max(40), z.string().max(80).nullable()),
    active: z.boolean(),
    version: z.number().int().min(0),
  }),
  response: { 200: output({ subscription: subscriptionView }) },
})

export const unsubscribeReportContract = defineContract({
  params: reportParams,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ removed: z.boolean() }) },
})
