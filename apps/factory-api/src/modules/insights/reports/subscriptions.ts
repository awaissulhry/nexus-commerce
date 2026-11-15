import type { FactoryDatabase, Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { DIGEST_DEFAULTS, digestDueNow, nextSendAt, type DigestLocale } from '@nexus/factory-domain/insights-digest/digest'
import { periodWords, reportMail, reportTitleIn } from '@nexus/factory-domain/insights-digest/report-mail'
import { REPORT_ROW_LIMIT } from '@nexus/factory-domain/insights/reports/definition'
import { appliedFilters } from '@nexus/factory-domain/insights/reports/results'
import { columnsFor, libraryState } from '@nexus/factory-domain/insights/reports/rights'
import { subscriptionProblems } from '@nexus/factory-domain/production/reports/subscriptions'
import { callerFor, command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { mailPerson } from '../digest/mail'
import { companiesReached, personOf } from '../digest/person'
import { officeContextOf } from '../viewer'
import type { ReportDefinition } from './report'
import { subscribableReport, subscribableReports } from './registry'
import { sitesReached } from './run'

/**
 * "E-mail me this" for any report of the library (B-W2b-435; follow-up DG1:01; design home.reports rec:Report › Schedule): ONE
 * ReportSubscription per person and report (views.prisma: reportKey = the report's key, the run's filters in `params`, a site
 * filter's value also in `siteId`; the recipient is the person who asked — never anyone else). A report that shares its rows
 * with a module's own mail (`production.daily`) is subscribed on its module's page (409 `subscription/OWN_MAIL`).
 *
 *   GET    /reports/subscriptions            home.reports.view: my report e-mails (one report's with `reportKey`)
 *   PUT    /reports/:key/subscription        home.reports.view + the report runnable by me: make or change mine, at the version
 *          {sendTime, weekdays, locale, filters, active, version}   read (0: none yet) — command insights.subscribeReport
 *   DELETE /reports/:key/subscription?version                       stop it for good — command insights.unsubscribeReport
 *
 * The scheduler's clustered cron `insights.reportMail` (every 15 minutes) runs each due one AS ITS PERSON (their live roles now:
 * a report they can no longer run is not sent, and said in the audit row) and mails how many rows it found, the first records by
 * their own number and the link to the report with the same filters (FAKE SES locally and in tests); then ONE command marks it
 * sent (lastSentAt) and emits report_subscription.sent. Nothing is sent by itself in tests.
 */

export const REPORT_MAIL_TEMPLATE_KEY = 'insights.report'

const COLUMNS = { id: true, userId: true, reportKey: true, companyId: true, siteId: true, params: true, sendTime: true, weekdays: true, locale: true, active: true, lastSentAt: true, version: true } as const satisfies Prisma.ReportSubscriptionSelect
type Row = Prisma.ReportSubscriptionGetPayload<{ select: typeof COLUMNS }>

const filtersOf = (row: Pick<Row, 'params'>): Record<string, string> => {
  const params = (row.params ?? {}) as Record<string, unknown>
  const filters = (params.filters ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/** The clock a subscription keeps: its site's, else its company's, else the factory's. */
async function zoneOfRow(caller: CommandCaller, row: Pick<Row, 'siteId' | 'companyId'>): Promise<string> {
  return caller.withClient(async (db) => {
    if (row.siteId) return (await db.site.findUnique({ where: { id: row.siteId }, select: { timezone: true } }))?.timezone ?? DIGEST_DEFAULTS.timeZone
    if (row.companyId) return (await db.company.findUnique({ where: { id: row.companyId }, select: { timezone: true } }))?.timezone ?? DIGEST_DEFAULTS.timeZone
    return DIGEST_DEFAULTS.timeZone
  })
}

function viewOf(row: Row, timeZone: string, now: Date) {
  const sentToday = row.lastSentAt !== null && businessDate(row.lastSentAt, timeZone) === businessDate(now, timeZone)
  const next = row.active ? nextSendAt({ sendTime: row.sendTime, timeZone, weekdays: row.weekdays }, now, sentToday) : null
  return {
    id: row.id,
    reportKey: row.reportKey,
    filters: filtersOf(row),
    siteId: row.siteId,
    sendTime: row.sendTime,
    timeZone,
    weekdays: [...row.weekdays],
    locale: row.locale === 'en' ? ('en' as const) : ('it' as const),
    active: row.active,
    lastSentAt: row.lastSentAt ? toUtcIso(row.lastSentAt) : null,
    nextAt: next ? toUtcIso(next) : null,
    version: row.version,
  }
}

/** The report, if a person may subscribe to it: it exists, it has no module mail of its own, and they may run it. */
function reportFor(actor: Actor, key: string): ReportDefinition {
  const found = subscribableReport(key)
  if (found === 'UNKNOWN') throw new NotFoundError('There is no such report.')
  if (found === 'OWN_MAIL') throw new DomainError('conflict', 'This report is e-mailed by its own page: subscribe there (Production › Reports).', [{ path: 'subscription/OWN_MAIL', message: 'Its module sends it.' }])
  const { state, grain } = libraryState(actor, found)
  if (state === 'NO_ACCESS') throw new DomainError('forbidden', 'This report reads a list you cannot read.', [{ path: `permission/${found.permission}`, message: 'You cannot read the list this report reads.' }])
  if (state === 'NEEDS_GRAIN') throw new DomainError('forbidden', `This report needs ${grain} rights.`, [{ path: `grain/${grain}`, message: `This report needs ${grain} rights.` }])
  return found
}

/** GET /reports/subscriptions?reportKey: my report e-mails (the library's reports only; a module's own mail is listed there). */
export async function listReportSubscriptions(caller: CommandCaller, query: { readonly reportKey?: string | undefined }) {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  const keys = subscribableReports().map((report) => report.key)
  const rows = await caller.withClient((db) =>
    db.reportSubscription.findMany({
      where: { userId: context.actorId, reportKey: query.reportKey ? (keys.includes(query.reportKey) ? query.reportKey : '~none') : { in: keys } },
      orderBy: [{ reportKey: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: COLUMNS,
    }),
  )
  const out = []
  for (const row of rows) out.push(viewOf(row, await zoneOfRow(caller, row), now))
  return { asOf: toUtcIso(now), subscriptions: out }
}

export interface SubscribeReportBody {
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: 'it' | 'en'
  readonly filters: Readonly<Record<string, string | null>>
  readonly active: boolean
  readonly version: number
}

/** The run's filters as stored: the report's own keys with a value; a site the person reaches (its company with it). */
async function checkedFilters(caller: CommandCaller, actor: Actor, report: ReportDefinition, asked: Readonly<Record<string, string | null>>) {
  const unknown = Object.keys(asked).filter((key) => !report.filters.some((filter) => filter.key === key))
  if (unknown.length > 0) throw new ValidationError('This report has no such filter.', unknown.map((key) => ({ path: `body/filters/${key}`, message: 'Not a filter of this report.' })))
  const applied = appliedFilters(report, Object.fromEntries(Object.entries(asked).map(([key, value]) => [key, value ?? undefined])))
  if (applied.problems.length > 0) throw new ValidationError(applied.problems[0]!.message, applied.problems.map((problem) => ({ ...problem, path: problem.path.replace('querystring/', 'body/filters/') })))
  const siteFilter = report.filters.find((filter) => filter.kind === 'site')
  const siteId = siteFilter ? (asked[siteFilter.key] ?? null) : null
  let companyId: string | null = null
  if (siteId) {
    const site = (await sitesReached(caller, actor, report.permission)).find((entry) => entry.id === siteId)
    if (!site) throw new ValidationError('Choose a site you work at.', [{ path: `body/filters/${siteFilter!.key}`, message: 'Not a site you reach.' }])
    companyId = site.companyId
  }
  const filters = Object.fromEntries(Object.entries(asked).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''))
  return { filters, siteId, companyId }
}

/** PUT /reports/:key/subscription (command insights.subscribeReport): "E-mail me this", made or changed. */
export async function subscribeReport(caller: CommandCaller, key: string, body: SubscribeReportBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const report = reportFor(actor, key)
  const problems: Issue[] = [...subscriptionProblems({ sendTime: body.sendTime, weekdays: body.weekdays })]
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The e-mail settings are not valid.', problems)
  const { filters, siteId, companyId } = await checkedFilters(caller, actor, report, body.filters)
  // A report without a site filter keeps the clock of my session's company.
  const company = companyId ?? (context.companyId && (await caller.withClient((db) => companiesReached(db, actor))).some((entry) => entry.id === context.companyId) ? context.companyId : null)
  const { result } = await command(caller, { name: 'insights.subscribeReport', idempotencyKey, input: { key, ...body } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "ReportSubscription" WHERE "userId" = ${context.actorId}::uuid AND "reportKey" = ${report.key} FOR UPDATE`
    const existing = await tools.tx.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: report.key }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: COLUMNS })
    if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('ReportSubscription', existing?.id ?? report.key, existing?.version ?? 0, body.version)
    const fields = { locale: body.locale, companyId: company, siteId, params: { filters } as Prisma.InputJsonValue, sendTime: body.sendTime, weekdays: [...body.weekdays], active: body.active }
    const row = existing
      ? await tools.tx.reportSubscription.update({ where: { id: existing.id }, data: { ...fields, version: existing.version + 1, updatedAt: tools.now }, select: COLUMNS })
      : await tools.tx.reportSubscription.create({ data: { id: newId(), userId: context.actorId, reportKey: report.key, channel: 'EMAIL', ...fields, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: COLUMNS })
    const change = !existing ? 'SUBSCRIBED' : existing.active && !body.active ? 'TURNED_OFF' : 'CHANGED'
    tools.audit({
      recordType: 'ReportSubscription',
      recordId: row.id,
      ...(company ? { companyId: company } : {}),
      ...(siteId ? { siteId } : {}),
      ...(existing ? { before: { active: existing.active, sendTime: existing.sendTime, weekdays: existing.weekdays, locale: existing.locale, filters: filtersOf(existing) } } : {}),
      after: { reportKey: report.key, active: row.active, sendTime: row.sendTime, weekdays: row.weekdays, locale: row.locale, filters },
    })
    tools.emit({ type: 'report_subscription.changed', subject: row.id, ...(company ? { companyId: company } : {}), ...(siteId ? { siteId } : {}), payload: { subscriptionId: row.id, reportKey: report.key, userId: context.actorId, change } })
    return row.id
  })
  const saved = await caller.withClient((db) => db.reportSubscription.findUnique({ where: { id: result }, select: COLUMNS }))
  if (!saved) throw new NotFoundError('You do not get this report by e-mail.')
  return { subscription: viewOf(saved, await zoneOfRow(caller, saved), serverClock.now()) }
}

/** DELETE /reports/:key/subscription?version (command insights.unsubscribeReport): mine, removed. */
export async function unsubscribeReport(caller: CommandCaller, key: string, version: number, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const found = subscribableReport(key)
  if (found === 'UNKNOWN') throw new NotFoundError('There is no such report.')
  await command(caller, { name: 'insights.unsubscribeReport', idempotencyKey, input: { key, version } }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "ReportSubscription" WHERE "userId" = ${context.actorId}::uuid AND "reportKey" = ${key} FOR UPDATE`
    const existing = await tools.tx.reportSubscription.findFirst({ where: { userId: context.actorId, reportKey: key }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: COLUMNS })
    if (!existing) throw new NotFoundError('You do not get this report by e-mail.')
    if (existing.version !== version) throw new StaleVersionError('ReportSubscription', existing.id, existing.version, version)
    await tools.tx.reportSubscription.delete({ where: { id: existing.id } })
    tools.audit({ recordType: 'ReportSubscription', recordId: existing.id, ...(existing.companyId ? { companyId: existing.companyId } : {}), ...(existing.siteId ? { siteId: existing.siteId } : {}), before: { reportKey: key, active: existing.active, filters: filtersOf(existing) }, after: null })
    tools.emit({ type: 'report_subscription.changed', subject: existing.id, ...(existing.companyId ? { companyId: existing.companyId } : {}), ...(existing.siteId ? { siteId: existing.siteId } : {}), payload: { subscriptionId: existing.id, reportKey: key, userId: context.actorId, change: 'REMOVED' } })
    return null
  })
  return { removed: true }
}

// ---- the scheduler ------------------------------------------------------------------------------------------------------------

export interface ReportMailOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly runtime?: () => EmailRuntime
}

export interface ReportMailResult {
  readonly due: number
  readonly sent: number
  readonly skipped: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it with their clock and e-mail runtime). */
export async function runReportMails(options: ReportMailOptions): Promise<ReportMailResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `insights-report-mail-${newId()}`
  const result = { due: 0, sent: 0, skipped: 0, failed: 0 }
  const keys = subscribableReports().map((report) => report.key)
  if (keys.length === 0) return result
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const rows = await asSystem(options.database, tenantId, requestId, (client) =>
        client.reportSubscription.findMany({
          where: { reportKey: { in: keys }, active: true, user: { status: 'ACTIVE' } },
          orderBy: { id: 'asc' },
          select: { ...COLUMNS, site: { select: { timezone: true } }, company: { select: { timezone: true, code: true } }, user: { select: { email: true, displayName: true, requireMfa: true } } },
        }),
      )
      const system = callerFor(options.database, systemContext(tenantId, requestId))
      for (const row of rows) {
        const timeZone = row.site?.timezone ?? row.company?.timezone ?? DIGEST_DEFAULTS.timeZone
        if (!digestDueNow({ sendTime: row.sendTime, timeZone, weekdays: row.weekdays }, row.lastSentAt, now)) continue
        result.due += 1
        try {
          const outcome = await sendReportMail(system, tenantId, row, timeZone, now, (options.runtime ?? processEmail)(), requestId, options.clock)
          result[outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'skipped'] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, subscriptionId: row.id }, 'a report e-mail could not be sent')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the report e-mails of a tenant could not be read')
    }
  }
  return result
}

interface DueMail extends Row {
  readonly company: { readonly code: string } | null
  readonly user: { readonly email: string; readonly displayName: string; readonly requireMfa: boolean }
}

/** One person's report (see the module comment): 'sent', 'not_allowed' (marked checked), or 'failed'. */
export async function sendReportMail(system: CommandCaller, tenantId: string, row: DueMail, timeZone: string, now: Date, runtime: EmailRuntime, requestId: string, clock?: Clock): Promise<'sent' | 'not_allowed' | 'failed'> {
  const today = businessDate(now, timeZone)
  const locale: DigestLocale = row.locale === 'en' ? 'en' : 'it'
  const finish = (outcome: 'sent' | 'not_allowed' | 'failed', details: { rows?: number; outboundId?: string; why?: string }) =>
    command(system, { name: 'insights.reportMailSent', idempotencyKey: `report-mail-${row.id}-${today}`, input: { subscriptionId: row.id, today } }, async (tools) => {
      await tools.tx.reportSubscription.update({ where: { id: row.id }, data: { lastSentAt: tools.now, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'ReportSubscription', recordId: row.id, ...(row.companyId ? { companyId: row.companyId } : {}), ...(row.siteId ? { siteId: row.siteId } : {}), after: { outcome, reportKey: row.reportKey, ...details } })
      if (outcome === 'sent' && details.outboundId)
        tools.emit({ type: 'report_subscription.sent', subject: row.userId, ...(row.companyId ? { companyId: row.companyId } : {}), ...(row.siteId ? { siteId: row.siteId } : {}), payload: { subscriptionId: row.id, reportKey: row.reportKey, userId: row.userId, emailOutboundId: details.outboundId, rows: details.rows ?? 0 } })
      return outcome
    })
  const report = subscribableReport(row.reportKey)
  if (report === 'UNKNOWN' || report === 'OWN_MAIL') return (await finish('not_allowed', { why: 'the report is not in the library any more' })).result
  const person = await personOf(system, tenantId, { id: row.userId, requireMfa: row.user.requireMfa }, now, requestId, row.companyId)
  if (libraryState(person.actor, report).state !== 'READY') return (await finish('not_allowed', { why: 'the person may no longer run this report' })).result
  const asked = filtersOf(row)
  const applied = appliedFilters(report, asked)
  if (applied.problems.length > 0) return (await finish('not_allowed', { why: 'its filters are not the report’s any more' })).result
  const siteFilter = report.filters.find((filter) => filter.kind === 'site')
  const siteId = siteFilter ? applied.values[siteFilter.key] : null
  const sites = siteFilter ? await sitesReached(person.caller, person.actor, report.permission) : []
  const site = siteId ? sites.find((entry) => entry.id === siteId) : null
  if (siteId && !site) return (await finish('not_allowed', { why: 'the person no longer reaches its site' })).result
  const read = await report.read({ caller: person.caller, filters: applied.values, today, now, limit: REPORT_ROW_LIMIT, locale })
  const rows = read.rows.slice(0, REPORT_ROW_LIMIT)
  const sight = columnsFor(person.actor, report.columns)
  const companies = row.company ? [row.company] : await system.withClient((db) => companiesReached(db, person.actor))
  const prefix = companies[0] ? `${runtime.webOrigin}/w/${encodeURIComponent(companies[0].code)}` : runtime.webOrigin
  const query = new URLSearchParams(Object.entries(asked).sort())
  const link = `${prefix}/home/reports/${encodeURIComponent(report.key)}${query.size > 0 ? `?${query.toString()}` : ''}`
  const periodFilter = report.filters.find((filter) => filter.kind === 'period')
  const period = periodFilter ? applied.values[periodFilter.key] : null
  const mail = reportMail(
    {
      title: reportTitleIn(report.key, report.title, locale),
      today,
      period: period ? periodWords(period, locale) : null,
      site: site ? site.code : null,
      rows: rows.length,
      complete: read.complete && read.rows.length <= REPORT_ROW_LIMIT,
      // Each record once (a report may give one record several rows: a work order short of two materials).
      records: [...new Set(rows.flatMap((entry) => (entry.record ? [entry.record.label] : [])))],
      leftOut: sight.leftOutColumns.length,
      link,
      settings: `${prefix}/home/reports/${encodeURIComponent(report.key)}?tab=schedule`,
    },
    locale,
  )
  const outcome = await mailPerson(system, runtime, { userId: row.userId, to: row.user.email, name: row.user.displayName, locale, templateKey: REPORT_MAIL_TEMPLATE_KEY, subject: mail.subject, lines: mail.lines }, now, clock)
  if (outcome.sent) return (await finish('sent', { rows: rows.length, outboundId: outcome.outboundId })).result
  return (await finish('failed', { why: outcome.why })).result
}

export function reportMailCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({
    name: 'insights.reportMail',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runReportMails(options)
      if (result.due > 0) options.log.info({ ...result }, 'report e-mails')
    },
  })
}
