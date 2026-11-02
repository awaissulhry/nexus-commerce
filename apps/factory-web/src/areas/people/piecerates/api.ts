import { z } from 'zod'
import { EARNINGS_KINDS, HOLD_REASONS, HOLD_STATUSES, PERIOD_CHECKS, STATEMENT_STATUSES } from '@nexus/factory-domain/people/earnings/rules'
import { OPEN_REASONS } from '@nexus/factory-domain/people/privacy/figures'
import { CHANGE_REASONS, RATE_BASES, VERSION_STATES, VERSION_STATUSES } from '@nexus/factory-domain/people/piecerates/rates'
import { PRECONDITION_CODES, SWITCH_STATES } from '@nexus/factory-domain/people/piecerates/switch'
import { GUARANTEED_BASES, INCENTIVE_KINDS, OWN_FAULT_PAYS, PAID_TIME_RATES, PERIOD_EFFECTS, PERIOD_STATUSES, SCHEME_STATES, SCHEME_STATUSES, TEAM_SPLITS } from '@nexus/factory-domain/people/schemes/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of People › Piece rates (B-W2b-62 on the API of B-W2b-34 rates and the switch, B-W2b-38 schemes, B-W2b-43
 * earnings and periods), with the answer's shape checked (zod; unknown fields are dropped, so the API's English `words`
 * never reach a screen). Every figure is `money.pay`: the API drops it for a caller without the grain, so each is optional
 * here and the screen says "hidden", never 0. A list names nobody (Owner answer W1): names come only inside one record.
 * Every write is one command with its own Idempotency-Key and the version read.
 */

export type ChangeReason = (typeof CHANGE_REASONS)[number]
export type RateBasis = (typeof RATE_BASES)[number]
export type VersionState = (typeof VERSION_STATES)[number]
export type PreconditionCode = (typeof PRECONDITION_CODES)[number]
export type IncentiveKind = (typeof INCENTIVE_KINDS)[number]
export type GuaranteedBasis = (typeof GUARANTEED_BASES)[number]
export type TeamSplit = (typeof TEAM_SPLITS)[number]
export type OwnFaultPay = (typeof OWN_FAULT_PAYS)[number]
export type PaidTimeRate = (typeof PAID_TIME_RATES)[number]
export type PeriodStatus = (typeof PERIOD_STATUSES)[number]
export type SchemeStatus = (typeof SCHEME_STATUSES)[number]
export type EarningsKind = (typeof EARNINGS_KINDS)[number]
export type HoldStatus = (typeof HOLD_STATUSES)[number]
export type PeriodCheckCode = (typeof PERIOD_CHECKS)[number]
export type OpenReason = (typeof OPEN_REASONS)[number]
export { OPEN_REASONS }

type Query = Record<string, string | number | boolean | null | undefined>
const seg = (value: string) => encodeURIComponent(value)
const clean = (query: Query): Query => Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ''))
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

/** A figure the pay grain may drop. */
const pay = z.string().nullable().optional()
const payMinor = z.number().nullable().optional()

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const readBy = z.object({ read: z.number(), of: z.number() })
export type ReadBy = z.infer<typeof readBy>
const actionView = z.object({ allowed: z.boolean(), refusal: z.object({ code: z.string() }).nullable() })
export type ActionView = z.infer<typeof actionView>

// ---- the overview ---------------------------------------------------------------------------------------------------------

const overviewSite = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  switch: z.object({ state: z.enum(SWITCH_STATES), onFrom: z.string().nullable(), offFrom: z.string().nullable(), missing: z.number() }),
  tiles: z.object({ trialEndingSoon: z.number(), trialEnded: z.number(), unread: z.number(), drafts: z.number() }),
})
export type OverviewSite = z.infer<typeof overviewSite>
const overviewSchema = z.object({ today: z.string(), payShown: z.boolean(), sites: z.array(overviewSite) })
export type Overview = z.infer<typeof overviewSchema>

export const readOverview = (api: ApiClient, companyId: string | null | undefined) => api.get('/people/piece-rates', { query: clean({ companyId }), schema: overviewSchema })

// ---- the rate table -------------------------------------------------------------------------------------------------------

const versionSummary = z.object({
  id: z.string(),
  tableId: z.string(),
  versionNo: z.number(),
  status: z.enum(VERSION_STATUSES),
  state: z.enum(VERSION_STATES),
  changeReason: z.enum(CHANGE_REASONS),
  changeNote: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  provisional: z.boolean(),
  trialEndsOn: z.string().nullable(),
  inForceToday: z.boolean(),
  rateCount: z.number(),
  publishedOn: z.string().nullable(),
  readBy,
  version: z.number(),
})
export type VersionSummary = z.infer<typeof versionSummary>

const rateView = z.object({
  id: z.string(),
  operation: ref,
  sizeBand: z.string(),
  basis: z.enum(RATE_BASES),
  standardMinutes: z.string().nullable(),
  ratePerMinute: pay,
  ratePerPiece: pay,
  note: z.string().nullable(),
})
export type RateView = z.infer<typeof rateView>

const rateRow = z.object({
  table: z.object({ id: z.string(), code: z.string(), name: z.string(), currency: z.string() }),
  style: ref.nullable(),
  line: ref.nullable(),
  rate: rateView,
  version: versionSummary,
})
export type RateRow = z.infer<typeof rateRow>
const ratesSchema = z.object({ today: z.string(), payShown: z.boolean(), rows: z.array(rateRow), complete: z.boolean() })
export type RatesPage = z.infer<typeof ratesSchema>

export const readRates = (api: ApiClient, siteId: string, view: 'CURRENT' | 'ALL', q?: string | null) =>
  api.get('/people/piece-rates/rates', { query: clean({ siteId, view, q: q?.trim(), limit: 2000 }), schema: ratesSchema })

const tableView = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  style: ref.nullable(),
  line: ref.nullable(),
  currency: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  note: z.string().nullable(),
  fixed: z.boolean(),
  version: z.number(),
})
export type TableView = z.infer<typeof tableView>
const tableRow = z.object({ table: tableView, current: versionSummary.nullable(), next: versionSummary.nullable(), drafts: z.number() })
export type TableRow = z.infer<typeof tableRow>

export const readTables = (api: ApiClient, siteId: string) => api.get('/people/piece-rates/tables', { query: { siteId }, schema: z.object({ tables: z.array(tableRow) }) }).then((answer) => answer.tables)

const tableDetail = z.object({ table: tableView, site: z.object({ id: z.string(), code: z.string(), name: z.string() }), versions: z.array(versionSummary), canManage: z.boolean() })
export const createTable = (api: ApiClient, body: { siteId: string; code: string; name: string; styleId?: string | null; lineId?: string | null; currency?: string; note?: string | null }, idempotencyKey?: string) =>
  api.post('/people/piece-rates/tables', { body, schema: tableDetail, ...key(idempotencyKey) })

const publication = z.object({
  id: z.string(),
  status: z.enum(['PUBLISHED', 'WITHDRAWN']),
  line: ref.nullable(),
  onFloor: z.boolean(),
  printed: z.boolean(),
  publishedAt: z.string(),
  publishedByName: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawReason: z.string().nullable(),
  workers: z.array(z.object({ workerId: z.string(), name: z.string(), employeeId: z.string().nullable(), read: z.object({ at: z.string(), channel: z.enum(['DEVICE', 'PAPER']) }).nullable() })),
  readBy,
  version: z.number(),
})
export type Publication = z.infer<typeof publication>

const versionDetail = z.object({
  table: tableView,
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  version: versionSummary.extend({
    confirmedAt: z.string().nullable(),
    confirmedByName: z.string().nullable(),
    supersededAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
    createdAt: z.string(),
    createdByName: z.string().nullable(),
  }),
  rates: z.array(rateView),
  publications: z.array(publication),
  actions: z.object({ edit: actionView, publish: actionView, putInForce: actionView, confirm: actionView, cancel: actionView }),
  payShown: z.boolean(),
  canManage: z.boolean(),
})
export type VersionDetail = z.infer<typeof versionDetail>

export const readVersion = (api: ApiClient, versionId: string) => api.get(`/people/piece-rates/versions/${seg(versionId)}`, { schema: versionDetail })

export interface RateBody {
  operationId: string
  sizeBand?: string | null
  basis: RateBasis
  standardMinutes?: string | null
  ratePerMinute?: string | null
  ratePerPiece?: string | null
  note?: string | null
}

export interface VersionBody {
  changeReason: ChangeReason
  changeNote?: string | null
  effectiveFrom: string
  provisional?: boolean
  trialEndsOn?: string | null
  copy?: 'LATEST' | 'NONE'
  rates?: RateBody[]
}

export const createVersion = (api: ApiClient, tableId: string, body: VersionBody, idempotencyKey?: string) => api.post(`/people/piece-rates/tables/${seg(tableId)}/versions`, { body, schema: versionDetail, ...key(idempotencyKey) })
export const setRates = (api: ApiClient, versionId: string, version: number, rates: RateBody[], idempotencyKey?: string) =>
  api.request('PUT', `/people/piece-rates/versions/${seg(versionId)}/rates`, { body: { version, rates }, schema: versionDetail, ...key(idempotencyKey) })
export const cancelVersion = (api: ApiClient, versionId: string, version: number, reason: string) => api.post(`/people/piece-rates/versions/${seg(versionId)}/cancel`, { body: { version, reason }, schema: versionDetail, ...key() })
export const putInForce = (api: ApiClient, versionId: string, version: number) => api.post(`/people/piece-rates/versions/${seg(versionId)}/put-in-force`, { body: { version }, schema: versionDetail, ...key() })
export const confirmVersion = (api: ApiClient, versionId: string, version: number) => api.post(`/people/piece-rates/versions/${seg(versionId)}/confirm`, { body: { version }, schema: versionDetail, ...key() })

const confirmPreviewSchema = z.object({
  rows: z.array(z.object({ id: z.string(), table: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), versionNo: z.number().nullable(), from: z.string().nullable(), trialEndsOn: z.string().nullable(), refusal: z.object({ code: z.string() }).nullable(), version: z.number().nullable() })),
  canConfirm: z.number(),
})
export type ConfirmPreview = z.infer<typeof confirmPreviewSchema>
export const confirmPreview = (api: ApiClient, ids: readonly string[]) => api.post('/people/piece-rates/versions/confirm/preview', { body: { ids }, schema: confirmPreviewSchema })
export const confirmVersions = (api: ApiClient, items: readonly { id: string; version: number }[], idempotencyKey?: string) =>
  api.post('/people/piece-rates/versions/confirm', { body: { items }, schema: z.object({ confirmed: z.array(z.object({ id: z.string(), versionNo: z.number(), tableId: z.string() })) }), ...key(idempotencyKey) })

const publishPreviewSchema = z.object({
  version: z.object({ id: z.string(), versionNo: z.number(), status: z.enum(VERSION_STATUSES) }),
  line: ref.nullable(),
  workers: z.array(z.object({ workerId: z.string(), name: z.string(), employeeId: z.string().nullable(), alreadyTold: z.boolean() })),
  count: z.number(),
  newCount: z.number(),
  withoutEmployee: z.number(),
  refusal: z.object({ code: z.string() }).nullable(),
})
export type PublishPreview = z.infer<typeof publishPreviewSchema>
export const publishPreview = (api: ApiClient, versionId: string, lineId: string | null) => api.get(`/people/piece-rates/versions/${seg(versionId)}/publish/preview`, { query: clean({ lineId }), schema: publishPreviewSchema })
export const publishVersion = (api: ApiClient, versionId: string, body: { version: number; lineId?: string | null; workerIds?: string[]; onFloor: boolean; printed: boolean; putInForce: boolean }, idempotencyKey?: string) =>
  api.post(`/people/piece-rates/versions/${seg(versionId)}/publish`, { body, schema: versionDetail, ...key(idempotencyKey) })
export const withdrawPublication = (api: ApiClient, publicationId: string, version: number, reason: string) => api.post(`/people/piece-rates/publications/${seg(publicationId)}/withdraw`, { body: { version, reason }, schema: versionDetail, ...key() })
export const paperReceipts = (api: ApiClient, publicationId: string, workerIds: readonly string[]) =>
  api.post(`/people/piece-rates/publications/${seg(publicationId)}/paper-receipts`, { body: { workerIds }, schema: versionDetail.extend({ recorded: z.number(), already: z.number() }), ...key() })

// ---- the legal switch -----------------------------------------------------------------------------------------------------

const schemeOption = z.object({ id: z.string(), name: z.string(), kind: z.string(), status: z.string(), validFrom: z.string(), validTo: z.string().nullable(), lineId: z.string().nullable() })
const noticeOption = z.object({ id: z.string(), label: z.string(), status: z.string() })
const dpiaOption = z.object({ id: z.string(), versionNo: z.number(), status: z.string() })
const switchSchema = z.object({
  site: z.object({ id: z.string(), companyId: z.string(), code: z.string(), name: z.string() }),
  today: z.string(),
  state: z.enum(SWITCH_STATES),
  onFrom: z.string().nullable(),
  switchedOnAt: z.string().nullable(),
  switchedOnByName: z.string().nullable(),
  offFrom: z.string().nullable(),
  switchedOffAt: z.string().nullable(),
  switchedOffByName: z.string().nullable(),
  offReason: z.string().nullable(),
  earlierWindows: z.array(z.object({ from: z.string(), to: z.string() })),
  recorded: z.object({
    ccnlName: z.string().nullable(),
    ccnlArticle: z.string().nullable(),
    workerNotice: noticeOption.nullable(),
    dpia: dpiaOption.nullable(),
    consultantName: z.string().nullable(),
    consultantAgreedOn: z.string().nullable(),
    scheme: schemeOption.nullable(),
    preconditionsNote: z.string().nullable(),
  }),
  preconditions: z.array(z.object({ code: z.enum(PRECONDITION_CODES), met: z.boolean(), law: z.string(), page: z.string().nullable(), words: z.string() })),
  canStart: z.boolean(),
  noticeReadBy: readBy.nullable(),
  candidates: z.object({ notices: z.array(noticeOption), dpias: z.array(dpiaOption), schemes: z.array(schemeOption) }),
  version: z.number().nullable(),
  canManage: z.boolean(),
  canSwitch: z.boolean(),
})
export type SwitchView = z.infer<typeof switchSchema>
export type Precondition = SwitchView['preconditions'][number]

export const readSwitch = (api: ApiClient, siteId: string) => api.get(`/people/piece-rates/sites/${seg(siteId)}/switch`, { schema: switchSchema })

export interface PreconditionsBody {
  version?: number
  ccnlName?: string | null
  ccnlArticle?: string | null
  workerNoticeId?: string | null
  dpiaId?: string | null
  consultantName?: string | null
  consultantAgreedOn?: string | null
  schemeId?: string | null
  preconditionsNote?: string | null
}
export const recordPreconditions = (api: ApiClient, siteId: string, body: PreconditionsBody) => api.request('PUT', `/people/piece-rates/sites/${seg(siteId)}/switch/preconditions`, { body, schema: switchSchema, ...key() })
export const startPiecePay = (api: ApiClient, siteId: string, body: { version: number; onFrom: string; reason: string }, idempotencyKey: string) => api.post(`/people/piece-rates/sites/${seg(siteId)}/switch/start`, { body, schema: switchSchema, idempotencyKey })
export const stopPiecePay = (api: ApiClient, siteId: string, body: { version: number; reason: string }) => api.post(`/people/piece-rates/sites/${seg(siteId)}/switch/stop`, { body, schema: switchSchema, ...key() })

// ---- schemes --------------------------------------------------------------------------------------------------------------

const schemeSummary = z.object({
  id: z.string(),
  companyId: z.string(),
  siteId: z.string().nullable(),
  line: ref.nullable(),
  name: z.string(),
  kind: z.enum(INCENTIVE_KINDS),
  status: z.enum(SCHEME_STATUSES),
  state: z.enum(SCHEME_STATES),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  guaranteedBasis: z.enum(GUARANTEED_BASES),
  guaranteedHourlyRate: pay,
  teamSplit: z.enum(TEAM_SPLITS).nullable(),
  currency: z.string(),
  version: z.number(),
})
export type SchemeSummary = z.infer<typeof schemeSummary>
const schemesSchema = z.object({
  today: z.string(),
  payShown: z.boolean(),
  schemes: z.array(schemeSummary),
  applies: z.array(z.object({ line: ref.extend({ siteId: z.string() }).nullable(), scheme: z.object({ id: z.string(), name: z.string() }).nullable(), inherited: z.boolean() })),
})
export type SchemesPage = z.infer<typeof schemesSchema>
export const readSchemes = (api: ApiClient, companyId: string) => api.get('/people/incentive-schemes', { query: { companyId }, schema: schemesSchema })

const neighbour = z.object({ id: z.string(), name: z.string(), validFrom: z.string(), validTo: z.string().nullable(), status: z.enum(SCHEME_STATUSES) })
const schemeDetail = z.object({
  scheme: schemeSummary.extend({
    efficiencyThresholdPct: z.string().nullable(),
    traineeHourlyRate: pay,
    reworkOwnFault: z.enum(OWN_FAULT_PAYS),
    scrapOwnFault: z.enum(OWN_FAULT_PAYS),
    ownFaultRatePct: z.string().nullable(),
    othersFaultPay: z.enum(PAID_TIME_RATES),
    waitingPay: z.enum(PAID_TIME_RATES),
    payOnlyWhileClockedIn: z.boolean(),
    note: z.string().nullable(),
  }),
  periods: z.array(z.object({ id: z.string(), month: z.string(), status: z.enum(PERIOD_STATUSES), effect: z.enum(PERIOD_EFFECTS) })),
  follows: neighbour.nullable(),
  followedBy: neighbour.nullable(),
  switches: z.array(z.object({ site: ref, state: z.enum(SWITCH_STATES) })),
  actions: z.object({ edit: actionView, activate: actionView, end: actionView, delete: actionView }),
  payShown: z.boolean(),
  canManage: z.boolean(),
})
export type SchemeDetail = z.infer<typeof schemeDetail>
export const readScheme = (api: ApiClient, schemeId: string) => api.get(`/people/incentive-schemes/${seg(schemeId)}`, { schema: schemeDetail })

export interface SchemeBody {
  name: string
  kind: IncentiveKind
  efficiencyThresholdPct: string | null
  guaranteedBasis: GuaranteedBasis
  guaranteedHourlyRate: string | null
  traineeHourlyRate: string | null
  teamSplit: TeamSplit | null
  reworkOwnFault: OwnFaultPay
  scrapOwnFault: OwnFaultPay
  ownFaultRatePct: string | null
  othersFaultPay: PaidTimeRate
  waitingPay: PaidTimeRate
  payOnlyWhileClockedIn: boolean
  validFrom: string
  note: string | null
}
export const createScheme = (api: ApiClient, companyId: string, lineId: string | null, body: SchemeBody) => api.post('/people/incentive-schemes', { body: { companyId, lineId, ...body }, schema: schemeDetail, ...key() })
export const updateScheme = (api: ApiClient, schemeId: string, version: number, body: SchemeBody) => api.request('PATCH', `/people/incentive-schemes/${seg(schemeId)}`, { body: { version, ...body }, schema: schemeDetail, ...key() })
export const activateScheme = (api: ApiClient, schemeId: string, version: number) => api.post(`/people/incentive-schemes/${seg(schemeId)}/activate`, { body: { version }, schema: schemeDetail, ...key() })
export const endScheme = (api: ApiClient, schemeId: string, version: number, lastDay: string, reason: string) => api.post(`/people/incentive-schemes/${seg(schemeId)}/end`, { body: { version, lastDay, reason }, schema: schemeDetail, ...key() })
export const deleteScheme = (api: ApiClient, schemeId: string, version: number) => api.request('DELETE', `/people/incentive-schemes/${seg(schemeId)}`, { query: { version }, schema: z.object({ deleted: z.object({ id: z.string(), name: z.string() }) }), ...key() })

// ---- pay periods ----------------------------------------------------------------------------------------------------------

const periodRow = z.object({
  id: z.string(),
  companyId: z.string(),
  month: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.enum(PERIOD_STATUSES),
  people: z.number(),
  earnings: payMinor,
  makeUp: payMinor,
  currency: z.string(),
  tooFew: z.boolean(),
  heldOpen: z.number(),
  disputesOpen: z.number(),
  statements: z.object({ draft: z.number(), approved: z.number() }),
  version: z.number(),
})
export type PeriodRow = z.infer<typeof periodRow>
const periodsSchema = z.object({ periods: z.array(periodRow), payShown: z.boolean() })
export const readPeriods = (api: ApiClient, companyId: string) => api.get('/people/pay-periods', { query: { companyId, limit: 24 }, schema: periodsSchema })

const periodLine = z.object({ line: ref.nullable(), people: z.number().nullable(), pieces: z.string().nullable(), earnings: payMinor, makeUp: payMinor, makeUpSharePct: z.string().nullable(), tooFew: z.boolean() })
export type PeriodLine = z.infer<typeof periodLine>
const periodDetail = z.object({
  period: periodRow.extend({ previewedAt: z.string().nullable(), reviewStartedAt: z.string().nullable(), lockedAt: z.string().nullable(), lockNote: z.string().nullable() }),
  checks: z.array(z.object({ code: z.enum(PERIOD_CHECKS), blocking: z.boolean(), count: z.number() })),
  lines: z.array(periodLine),
  actions: z.object({ run: actionView, reopen: actionView, startReview: actionView, back: actionView, lock: actionView }),
  lockPhrase: z.string(),
  canManage: z.boolean(),
  payShown: z.boolean(),
})
export type PeriodDetail = z.infer<typeof periodDetail>
const period = (id: string) => `/people/pay-periods/${seg(id)}`
export const readPeriod = (api: ApiClient, id: string) => api.get(period(id), { schema: periodDetail })
export const createPeriod = (api: ApiClient, companyId: string, month: string) => api.post('/people/pay-periods', { body: { companyId, month }, schema: periodDetail, ...key() })
export const runPeriod = (api: ApiClient, id: string, version: number) => api.post(`${period(id)}/run`, { body: { version }, schema: periodDetail, ...key() })
export const reopenPeriod = (api: ApiClient, id: string, version: number) => api.post(`${period(id)}/reopen`, { body: { version }, schema: periodDetail, ...key() })
export const startReview = (api: ApiClient, id: string, version: number) => api.post(`${period(id)}/review`, { body: { version }, schema: periodDetail, ...key() })
export const backToPreview = (api: ApiClient, id: string, version: number, reason: string) => api.post(`${period(id)}/review/back`, { body: { version, reason }, schema: periodDetail, ...key() })
export const lockPeriod = (api: ApiClient, id: string, version: number, phrase: string, note?: string) => api.post(`${period(id)}/lock`, { body: { version, phrase, ...(note ? { note } : {}) }, schema: periodDetail, ...key() })

const statementRow = z.object({ id: z.string(), siteId: z.string(), status: z.enum(STATEMENT_STATUSES), revision: z.number(), leadReviewed: z.boolean(), stale: z.boolean(), version: z.number() })
export type StatementRow = z.infer<typeof statementRow>
export const readStatements = (api: ApiClient, id: string) => api.get(`${period(id)}/statements`, { schema: z.object({ periodId: z.string(), month: z.string(), statements: z.array(statementRow) }) }).then((answer) => answer.statements)

const statementSchema = z.object({
  id: z.string(),
  periodId: z.string(),
  month: z.string(),
  periodStatus: z.enum(PERIOD_STATUSES),
  person: z.object({ employeeId: z.string(), name: z.string(), code: z.string().nullable() }),
  revision: z.number(),
  status: z.enum(STATEMENT_STATUSES),
  openedAs: z.enum(['HR', 'LEAD']),
  currency: z.string(),
  lines: z.array(z.object({ operationCode: z.string(), operationName: z.string(), pieces: z.number(), minutes: z.string(), sharePct: z.string().nullable(), rate: pay, amount: payMinor })),
  time: z.array(z.object({ code: z.string(), minutes: z.string(), rate: pay, amount: payMinor })),
  corrections: z.array(z.object({ kind: z.enum(EARNINGS_KINDS), month: z.string().nullable(), words: z.string().nullable(), amount: payMinor })),
  attendance: z.object({ ordinaryMinutes: z.number(), approvedOvertimeMinutes: z.number() }).nullable(),
  makeUp: z.object({ minutes: z.number(), rate: pay, guaranteed: payMinor, earned: payMinor, amount: payMinor }).nullable(),
  held: z.object({ open: z.number(), counted: z.number(), notPaid: z.number() }),
  defects: z.object({ scrap: z.number(), rework: z.number() }),
  disputes: z.array(z.object({ id: z.string(), status: z.string(), workDate: z.string(), recordType: z.string() })),
  earningsAmount: payMinor,
  makeUpAmount: payMinor,
  stale: z.boolean(),
  leadReview: z.object({ at: z.string(), byName: z.string().nullable(), note: z.string().nullable() }).nullable(),
  fileId: z.string().nullable(),
  approvedAt: z.string().nullable(),
  canApprove: z.boolean(),
  version: z.number(),
})
export type Statement = z.infer<typeof statementSchema>
/** HR's opening needs nothing; a lead's says why (recorded), and the API drops the money. */
export const openStatement = (api: ApiClient, id: string, reason?: OpenReason) => api.post(`/people/statements/${seg(id)}/open`, { body: reason ? { reason } : {}, schema: statementSchema })
export const leadReview = (api: ApiClient, id: string, version: number) => api.post(`/people/statements/${seg(id)}/lead-review`, { body: { version }, schema: z.object({ id: z.string() }), ...key() })
export const approveStatement = (api: ApiClient, id: string, version: number) => api.post(`/people/statements/${seg(id)}/approve`, { body: { version }, schema: statementSchema, ...key() })
export const statementPdf = (api: ApiClient, id: string) => api.bytes(`/people/statements/${seg(id)}/pdf`, { method: 'POST', body: {} })

const employeeStatements = z.object({
  employeeId: z.string(),
  payShown: z.boolean(),
  statements: z.array(z.object({ id: z.string(), month: z.string(), periodStatus: z.enum(PERIOD_STATUSES), status: z.enum(STATEMENT_STATUSES), revision: z.number(), currency: z.string(), earningsAmount: payMinor, makeUpAmount: payMinor, approvedOn: z.string().nullable() })),
})
export type EmployeeStatements = z.infer<typeof employeeStatements>
export const readEmployeeStatements = (api: ApiClient, employeeId: string) => api.get(`/people/employees/${seg(employeeId)}/statements`, { schema: employeeStatements })

const employeePublications = z.object({
  employeeId: z.string(),
  publications: z.array(z.object({ id: z.string(), versionId: z.string(), versionNo: z.number(), table: z.object({ code: z.string(), name: z.string() }), state: z.enum(VERSION_STATES), effectiveFrom: z.string(), publishedAt: z.string(), onFloor: z.boolean(), printed: z.boolean(), read: z.object({ at: z.string(), channel: z.enum(['DEVICE', 'PAPER']), device: z.string().nullable() }).nullable() })),
})
export type EmployeePublications = z.infer<typeof employeePublications>
export const readEmployeePublications = (api: ApiClient, employeeId: string) => api.get(`/people/employees/${seg(employeeId)}/rate-publications`, { schema: employeePublications })

// ---- held scans -----------------------------------------------------------------------------------------------------------

const heldRow = z.object({
  id: z.string(),
  siteId: z.string(),
  periodId: z.string(),
  at: z.string(),
  bundle: z.string(),
  operation: z.object({ code: z.string(), name: z.string() }),
  lineId: z.string().nullable(),
  pieces: z.number(),
  reason: z.enum(HOLD_REASONS),
  status: z.enum(HOLD_STATUSES),
  version: z.number(),
})
export type HeldRow = z.infer<typeof heldRow>
const heldRecord = heldRow.extend({
  day: z.string(),
  people: z.array(z.object({ employeeId: z.string(), name: z.string(), clockedIn: z.boolean() })),
  peopleShown: z.boolean(),
  attendanceDayId: z.string().nullable(),
  voided: z.boolean(),
  canCount: z.boolean(),
  resolution: z.object({ at: z.string().nullable(), note: z.string().nullable(), fixRecordType: z.string().nullable(), fixRecordId: z.string().nullable() }).nullable(),
})
export type HeldRecord = z.infer<typeof heldRecord>
export const readHeld = (api: ApiClient, query: { siteId: string | null; status?: HoldStatus | null }) => api.get('/people/held-scans', { query: clean({ siteId: query.siteId, status: query.status, limit: 200 }), schema: z.object({ held: z.array(heldRow) }) }).then((answer) => answer.held)
export const readHeldRecord = (api: ApiClient, id: string) => api.get(`/people/held-scans/${seg(id)}`, { schema: heldRecord })
export const countHeld = (api: ApiClient, id: string, version: number, note?: string) => api.post(`/people/held-scans/${seg(id)}/count`, { body: { version, ...(note ? { note } : {}) }, schema: heldRecord, ...key() })
export const notPaidHeld = (api: ApiClient, id: string, version: number, reason: string) => api.post(`/people/held-scans/${seg(id)}/not-paid`, { body: { version, reason }, schema: heldRecord, ...key() })

// ---- the earnings ledger --------------------------------------------------------------------------------------------------

const entryRow = z.object({
  id: z.string(),
  workDate: z.string(),
  siteId: z.string(),
  periodId: z.string(),
  kind: z.enum(EARNINGS_KINDS),
  bundle: z.string().nullable(),
  operation: z.object({ code: z.string(), name: z.string() }).nullable(),
  pieces: z.number().nullable(),
  minutes: z.string().nullable(),
  sharePct: z.string().nullable(),
  rate: pay,
  amount: payMinor,
  currency: z.string(),
  reversesId: z.string().nullable(),
  correctsMonth: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
})
export type EntryRow = z.infer<typeof entryRow>
const entryRecord = entryRow.extend({ person: z.object({ employeeId: z.string(), name: z.string(), code: z.string().nullable() }), reversedById: z.string().nullable(), canCorrect: z.boolean() })
export type EntryRecord = z.infer<typeof entryRecord>
export interface LedgerQuery {
  siteId: string | null
  periodId?: string | null
  lineId?: string | null
  kind?: EarningsKind | null
  cursor?: string | null
}
const ledgerSchema = z.object({ entries: z.array(entryRow), nextCursor: z.string().nullable() })
export const readLedger = (api: ApiClient, query: LedgerQuery) => api.get('/people/earnings/ledger', { query: clean({ siteId: query.siteId, periodId: query.periodId, lineId: query.lineId, kind: query.kind, cursor: query.cursor, limit: 100 }), schema: ledgerSchema })
export const readEntry = (api: ApiClient, id: string) => api.get(`/people/earnings/entries/${seg(id)}`, { schema: entryRecord })
export const correctEntry = (api: ApiClient, id: string, reason: string, amount: number | null) => api.post(`/people/earnings/entries/${seg(id)}/correct`, { body: { reason, ...(amount === null ? {} : { amount }) }, schema: entryRecord, ...key() })
const countsSchema = z.object({ heldOpen: z.number(), disputesOpen: z.number(), asOf: z.string() })
export type EarningsCounts = z.infer<typeof countsSchema>
export const readCounts = (api: ApiClient, companyId: string | null | undefined, siteId: string | null) => api.get('/people/earnings/counts', { query: clean({ companyId, siteId }), schema: countsSchema })

// ---- beside the page ------------------------------------------------------------------------------------------------------

/** The operations a rate may be for (Products › Operations; the library's SMV fills a rate when none is typed). */
const operationOption = z.object({ id: z.string(), code: z.string(), name: z.string(), standardMinutes: z.string().nullable().optional() })
export type OperationOption = z.infer<typeof operationOption>
export const readOperations = (api: ApiClient) => api.get('/product/operations', { query: { limit: 200 }, schema: z.object({ operations: z.array(operationOption) }) }).then((answer) => answer.operations)
export const readStyles = (api: ApiClient) => api.get('/product/styles', { query: { limit: 200 }, schema: z.object({ styles: z.array(ref) }) }).then((answer) => answer.styles)

export const reviewQueueCount = (api: ApiClient, siteId: string) => api.get('/people/efficiency/review', { query: { siteId }, schema: z.object({ count: z.number() }) }).then((answer) => answer.count)
