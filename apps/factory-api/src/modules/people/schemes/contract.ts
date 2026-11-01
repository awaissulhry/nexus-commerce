import { z } from 'zod'
import { amountMinor, businessDate, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { MINUTES_MAX } from '@nexus/factory-domain/people/schemes/pay'
import {
  GUARANTEED_BASES,
  INCENTIVE_KINDS,
  OWN_FAULT_PAYS,
  PAID_TIME_RATES,
  PERIOD_EFFECTS,
  PERIOD_STATUSES,
  SCHEME_REFUSALS,
  SCHEME_STATES,
  SCHEME_STATUSES,
  TEAM_SPLITS,
} from '@nexus/factory-domain/people/schemes/rules'

/**
 * Incentive schemes (B-W2b-38; MES-253, MES-257, MES-258, MES-259; design people.piecerates "Scheme", the header's "Scheme
 * settings"; c.c. arts. 2100-2101 and the CCNL minimum). Every guaranteed rate and every figure of the worked example is
 * `money.pay`: the API drops it for a caller without the pay grain (HR and the worker hold it) and refuses a body that
 * sends one. No answer names a person or holds a figure about one person's work: a scheme is the company's rule, and the
 * worked example runs on figures the caller types (made up), never on anyone's records.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().max(max)
const decimal = (max: number) => z.string().max(max)

const refView = output({ id: id(), code: z.string(), name: z.string() })
const refusalView = output({ code: z.enum(SCHEME_REFUSALS), message: z.string() }).nullable()
const actionView = output({ allowed: z.boolean(), refusal: refusalView })
const neighbourView = output({ id: id(), name: z.string(), validFrom: businessDate(), validTo: businessDate().nullable(), status: z.enum(SCHEME_STATUSES) })

export const schemeSummary = output({
  id: id(),
  companyId: id(),
  /** The line it is for (and its site); null: the company's scheme (a line's own wins on that line). */
  siteId: id().nullable(),
  line: refView.nullable(),
  name: z.string(),
  kind: z.enum(INCENTIVE_KINDS),
  kindWords: z.string(),
  status: z.enum(SCHEME_STATUSES),
  /** Draft · To come · In force · Ending · Ended, with its words. */
  state: z.enum(SCHEME_STATES),
  stateWords: z.string(),
  validFrom: businessDate(),
  validTo: businessDate().nullable(),
  guaranteedBasis: z.enum(GUARANTEED_BASES),
  guaranteedHourlyRate: money.pay(unitPrice().nullable()),
  teamSplit: z.enum(TEAM_SPLITS).nullable(),
  currency: z.string(),
  version: z.number().int(),
})

const schemeFields = {
  efficiencyThresholdPct: z.string().nullable(),
  traineeHourlyRate: money.pay(unitPrice().nullable()),
  reworkOwnFault: z.enum(OWN_FAULT_PAYS),
  scrapOwnFault: z.enum(OWN_FAULT_PAYS),
  ownFaultRatePct: z.string().nullable(),
  othersFaultPay: z.enum(PAID_TIME_RATES),
  waitingPay: z.enum(PAID_TIME_RATES),
  payOnlyWhileClockedIn: z.boolean(),
  note: z.string().nullable(),
  activatedAt: instant().nullable(),
  activatedByName: z.string().nullable(),
  createdAt: instant(),
  createdByName: z.string().nullable(),
}

const schemeDetail = output({
  scheme: schemeSummary.extend(schemeFields),
  company: refView,
  site: refView.nullable(),
  /** The rules in words, one per line (never a pay figure). */
  rules: z.array(z.string()),
  /** The company's pay periods its days touch (design "a change shows the periods it affects"). */
  periods: z.array(output({ id: id(), month: z.string(), status: z.enum(PERIOD_STATUSES), effect: z.enum(PERIOD_EFFECTS), words: z.string() })),
  periodWords: z.string(),
  /** The scheme of the same company and line just before it, and just after it. */
  follows: neighbourView.nullable(),
  followedBy: neighbourView.nullable(),
  /** The sites whose piece-pay switch names it (the legal switch's SCHEME precondition). */
  switches: z.array(output({ site: refView, state: z.enum(['OFF', 'ON']) })),
  /** What may be done now, and why not (in words). */
  actions: output({ edit: actionView, activate: actionView, end: actionView, delete: actionView }),
  payShown: z.boolean(),
  canManage: z.boolean(),
})
export type SchemeDetail = z.infer<typeof schemeDetail>

// ---- reads ----------------------------------------------------------------------------------------------------------

export const schemesContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    /** A line: its own schemes and the company's (what applies to it). */
    lineId: id().optional(),
    status: z.enum(SCHEME_STATUSES).optional(),
    /** true: also the schemes that ended (default: only those that apply today or later, and the drafts). */
    includeEnded: z.enum(['true', 'false']).optional(),
  }),
  response: {
    200: output({
      today: businessDate(),
      /** False: pay figures are hidden for this role (the rules only). */
      payShown: z.boolean(),
      schemes: z.array(schemeSummary),
      /** With a company: which scheme applies today to the company and to each of its lines (inherited: the company's). */
      applies: z.array(output({ line: refView.extend({ siteId: id() }).nullable(), scheme: output({ id: id(), name: z.string() }).nullable(), inherited: z.boolean() })),
    }),
  },
})

const params = input({ schemeId: id() })

export const schemeContract = defineContract({ params, response: { 200: schemeDetail } })

// ---- writes ---------------------------------------------------------------------------------------------------------

const termFields = {
  name: text(120),
  kind: z.enum(INCENTIVE_KINDS),
  /** STANDARD_MINUTE_BONUS: percent above 0, at most 200. */
  efficiencyThresholdPct: decimal(20).nullish(),
  /** UNDECIDED (default) until the labour consultant answers: the scheme cannot start. */
  guaranteedBasis: z.enum(GUARANTEED_BASES).optional(),
  guaranteedHourlyRate: money.pay(unitPrice().nullish()),
  traineeHourlyRate: money.pay(unitPrice().nullish()),
  /** TEAM_INCENTIVE: how the team's pay splits. */
  teamSplit: z.enum(TEAM_SPLITS).nullish(),
  reworkOwnFault: z.enum(OWN_FAULT_PAYS).optional(),
  scrapOwnFault: z.enum(OWN_FAULT_PAYS).optional(),
  /** REDUCED_RATE: percent of the rate, above 0 and below 100. */
  ownFaultRatePct: decimal(20).nullish(),
  othersFaultPay: z.enum(PAID_TIME_RATES).optional(),
  waitingPay: z.enum(PAID_TIME_RATES).optional(),
  payOnlyWhileClockedIn: z.boolean().optional(),
  currency: currency().optional(),
  validFrom: businessDate(),
  note: text(2000).nullish(),
}

export const createSchemeContract = defineContract({
  body: input({
    companyId: id(),
    /** A line of one of the company's sites; left out: the company's scheme. */
    lineId: id().nullish(),
    ...termFields,
  }),
  response: { 201: schemeDetail, 200: schemeDetail },
})

export const updateSchemeContract = defineContract({
  params,
  body: input({
    version: version(),
    name: termFields.name.optional(),
    kind: termFields.kind.optional(),
    efficiencyThresholdPct: termFields.efficiencyThresholdPct,
    guaranteedBasis: termFields.guaranteedBasis,
    guaranteedHourlyRate: termFields.guaranteedHourlyRate,
    traineeHourlyRate: termFields.traineeHourlyRate,
    teamSplit: termFields.teamSplit,
    reworkOwnFault: termFields.reworkOwnFault,
    scrapOwnFault: termFields.scrapOwnFault,
    ownFaultRatePct: termFields.ownFaultRatePct,
    othersFaultPay: termFields.othersFaultPay,
    waitingPay: termFields.waitingPay,
    payOnlyWhileClockedIn: termFields.payOnlyWhileClockedIn,
    currency: termFields.currency,
    validFrom: businessDate().optional(),
    note: termFields.note,
  }),
  response: { 200: schemeDetail },
})

const withWords = schemeDetail.extend({ words: z.array(z.string()) })

export const activateContract = defineContract({ params, body: input({ version: version() }), response: { 200: withWords } })

export const endContract = defineContract({ params, body: input({ version: version(), lastDay: businessDate(), reason: text(500) }), response: { 200: withWords } })

export const deleteContract = defineContract({
  params,
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ deleted: output({ id: id(), name: z.string() }) }) },
})

// ---- the worked example ("Try the scheme": made-up figures only) ------------------------------------------------------

const minutes = () => z.number().int().min(0).max(MINUTES_MAX)
const defectInput = input({
  /** Pieces of the worker's own fault (paid at the scheme's own-fault rule). */
  ownPieces: z.number().int().min(0).max(100_000).optional(),
  /** Their rate per piece at the full rate. */
  ratePerPiece: money.pay(unitPrice().optional()),
  /** Minutes of rework or scrap caused by others (paid as time off standard). */
  othersMinutes: minutes().optional(),
})

export const exampleContract = defineContract({
  params,
  body: input({
    minutesPresent: z.number().int().min(1).max(MINUTES_MAX),
    traineeMinutes: minutes().optional(),
    /** What the good pieces (and the team shares) paid at their rates, in major units. */
    pieceEarnings: money.pay(unitPrice()),
    /** STANDARD_MINUTE_BONUS: the standard minutes the pieces earned. */
    earnedStandardMinutes: decimal(20).optional(),
    /** Waiting that was not the worker's doing. */
    waitingMinutes: minutes().optional(),
    rework: defectInput.optional(),
    scrap: defectInput.optional(),
    /** TEAM_INCENTIVE: a team's pay for one operation and its members (letters, never people). */
    team: input({
      teamEarnings: money.pay(unitPrice()),
      members: z.array(input({ label: z.string().min(1).max(20), minutesPresent: minutes().optional(), skillWeight: decimal(20).optional() })).min(1).max(30),
    }).optional(),
  }),
  response: {
    200: output({
      scheme: output({ id: id(), name: z.string(), kind: z.enum(INCENTIVE_KINDS) }),
      currency: z.string(),
      /** Each part of the period's pay: what it is, its minutes or pieces, its rate and its amount (minor units). */
      lines: z.array(
        output({
          code: z.enum(['PIECES', 'TIME', 'BONUS', 'WAITING', 'REWORK_OWN', 'REWORK_OTHERS', 'SCRAP_OWN', 'SCRAP_OTHERS', 'MAKE_UP']),
          words: z.string(),
          minutes: z.string().nullable(),
          pieces: z.number().int().nullable(),
          rate: money.pay(unitPrice().nullable()),
          amount: money.pay(amountMinor()),
        }),
      ),
      guaranteed: money.pay(amountMinor()),
      makeUp: money.pay(amountMinor()),
      total: money.pay(amountMinor()),
      /** STANDARD_MINUTE_BONUS: standard minutes earned ÷ minutes present, percent. */
      efficiencyPct: z.string().nullable(),
      teamShares: z.array(output({ label: z.string(), sharePct: z.string(), amount: money.pay(amountMinor()) })),
      /** What the example shows, in words (no figure). */
      words: z.array(z.string()),
    }),
  },
})
