import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { escapeHtml, footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady } from '@nexus/factory-domain/email/rules'
import { digestDue } from '@nexus/factory-domain/notifications/rules'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { DAILY_REPORT_KEY, dailyReportMail, reportLocaleOf } from '@nexus/factory-domain/production/reports/subscriptions'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound } from '../../../platform/email-out/outbound'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { dailyView, previousWorkingDayOf, readDaily } from './daily'
import { readerOf } from './subscriptions'

/**
 * The daily production report by e-mail (B-W2a-38; MES-301 "sent each morning"; PLT-142 quiet defaults). The scheduler's
 * clustered cron `production.dailyReport` (every 15 minutes) sends each ACTIVE ReportSubscription `production.daily`
 * of an ACTIVE person once a day, at its time on its weekdays in its SITE's zone:
 *
 *   1. the person may still read the report at the site (their live roles now); else nothing is sent and the day is
 *      marked checked (outcome `not_allowed` in the audit row);
 *   2. the report of the site's previous working day (its calendar), per line and work centre, as the page shows it,
 *      composed in memory in the subscription's language with the company's footer and a link to the page;
 *   3. one EmailOutbound (record `User`, template `production.daily`, NO body) from the tenant's default NOTIFICATION
 *      identity, sent at once by deliverOutbound (suppression and identity checked again; FAKE accounts locally and in
 *      tests);
 *   4. ONE command marks lastSentAt, audits the outcome, and emits production.daily_report_sent.
 *
 * The mail holds lines and work centres only, never a person (Statuto dei Lavoratori art. 4).
 */

export const DAILY_TEMPLATE_KEY = 'production.daily'

const IDENTITY = { id: true, companyId: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

const clockOf = (instant: Date, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant)
const weekdayOf = (instant: Date, timeZone: string): number => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(instant)) + 1

export interface DailyRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly runtime?: () => EmailRuntime
}

export interface DailyRunResult {
  readonly due: number
  readonly sent: number
  readonly skipped: number
  readonly failed: number
}

interface Due {
  readonly id: string
  readonly userId: string
  readonly locale: string
  readonly site: { readonly id: string; readonly companyId: string; readonly code: string; readonly name: string; readonly timezone: string; readonly company: { readonly code: string } }
}

/** One tick over every active tenant (the cron's; tests call it with their clock and e-mail runtime). */
export async function runDailyReports(options: DailyRunOptions): Promise<DailyRunResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `production-daily-report-${newId()}`
  const result = { due: 0, sent: 0, skipped: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const due: Due[] = await asSystem(options.database, tenantId, requestId, async (client) => {
        const rows = await client.reportSubscription.findMany({
          where: { reportKey: DAILY_REPORT_KEY, active: true, siteId: { not: null }, user: { status: 'ACTIVE' } },
          orderBy: { id: 'asc' },
          select: { id: true, userId: true, locale: true, sendTime: true, weekdays: true, lastSentAt: true, site: { select: { id: true, companyId: true, code: true, name: true, timezone: true, company: { select: { code: true } } } } },
        })
        return rows.flatMap((row) => {
          if (!row.site) return []
          const zone = row.site.timezone
          const sentToday = row.lastSentAt !== null && businessDate(row.lastSentAt, zone) === businessDate(now, zone)
          return digestDue(row, { weekday: weekdayOf(now, zone), clock: clockOf(now, zone) }, sentToday) ? [{ id: row.id, userId: row.userId, locale: row.locale, site: row.site }] : []
        })
      })
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      for (const subscription of due) {
        result.due += 1
        try {
          const outcome = await sendDailyReport(caller, tenantId, subscription, now, (options.runtime ?? processEmail)(), options.clock)
          result[outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'skipped'] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, subscriptionId: subscription.id }, 'a daily production report could not be sent')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the daily production reports of a tenant could not be read')
    }
  }
  return result
}

/** One person's report (see the module comment): 'sent', 'not_allowed' (the day marked checked) or 'failed'. */
export async function sendDailyReport(caller: CommandCaller, tenantId: string, subscription: Due, now: Date, runtime: EmailRuntime, clock?: Clock): Promise<'sent' | 'not_allowed' | 'failed'> {
  const site = subscription.site
  const locale = reportLocaleOf(subscription.locale)
  const today = businessDate(now, site.timezone)
  const facts = await caller.withClient(async (client) => {
    const reader = await readerOf(client, tenantId, subscription.userId, now)
    const allowed = can(reader, PRODUCTION_REPORTS_VIEW, { companyId: site.companyId, siteId: site.id })
    const user = await client.user.findUnique({ where: { id: subscription.userId }, select: { email: true, displayName: true } })
    if (!allowed || !user) return { allowed: false as const, user }
    const day: BusinessDate = await previousWorkingDayOf(client, site.id, today)
    const view = dailyView(await readDaily(client, site, day))
    const identities = await client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY })
    return { allowed: true as const, user, day, view, identity: identities.find((entry) => identityReady(entry)) ?? null }
  })

  const finish = (outcome: 'sent' | 'not_allowed' | 'failed', details: { day?: BusinessDate; lanes?: number; outboundId?: string; why?: string }) =>
    command(caller, { name: 'production.dailyReportSent', idempotencyKey: `daily-report-${subscription.id}-${today}`, input: { subscriptionId: subscription.id, today } }, async (tools) => {
      await tools.tx.reportSubscription.update({ where: { id: subscription.id }, data: { lastSentAt: tools.now, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'ReportSubscription', recordId: subscription.id, companyId: site.companyId, siteId: site.id, after: { outcome, ...details } })
      if (outcome === 'sent' && details.outboundId && details.day)
        tools.emit({
          type: 'production.daily_report_sent',
          subject: subscription.userId,
          companyId: site.companyId,
          siteId: site.id,
          payload: { subscriptionId: subscription.id, userId: subscription.userId, reportKey: DAILY_REPORT_KEY, day: details.day, emailOutboundId: details.outboundId, lanes: details.lanes ?? 0 },
        })
      return outcome
    })

  if (!facts.allowed) return (await finish('not_allowed', { why: facts.user ? 'the person may no longer read this report at the site' : 'the person is not there any more' })).result
  if (!facts.identity) return (await finish('failed', { day: facts.day, why: 'the tenant has no verified sending identity' })).result

  const identity = facts.identity
  const link = `${runtime.webOrigin}/w/${encodeURIComponent(site.company.code)}/production/reports?site=${site.id}&date=${facts.day}`
  const { subject, lines } = dailyReportMail(
    {
      site: { code: site.code, name: site.name },
      day: facts.day,
      lanes: facts.view.lanes.map((lane) => ({ label: `${lane.code} ${lane.name}`, kind: lane.kind, good: lane.good, scrap: lane.scrap, rework: lane.rework, efficiencyPct: lane.efficiencyPct })),
      totals: facts.view.totals,
      link,
    },
    locale,
  )
  const company = await companyLegalOf(caller, identity.companyId)
  const greeting = locale === 'it' ? `Ciao ${facts.user!.displayName},` : `Hello ${facts.user!.displayName},`
  const footer = footerOf(company, privacyNoticeUrl(runtime.webOrigin, identity.companyId), locale)
  const text = [greeting, '', ...lines, '', footer.text].join('\n')
  const html = `<p>${escapeHtml(greeting)}</p>${lines.map((line) => (line === '' ? '' : `<p>${escapeHtml(line)}</p>`)).join('')}${footer.html}`
  const from = fromLine(identity, null)
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  await command(caller, { name: 'email.queueSystem', input: { kind: DAILY_TEMPLATE_KEY, userId: subscription.userId } }, async ({ tx, now: at, audit }) => {
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'User',
        recordId: subscription.userId,
        templateKey: DAILY_TEMPLATE_KEY,
        locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [facts.user!.email.toLowerCase()],
        subject,
        emailMessageId,
        status: 'QUEUED',
        queuedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: DAILY_TEMPLATE_KEY, userId: subscription.userId, identityId: identity.id, status: 'QUEUED' } })
    return null
  })
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    ...(clock ? { clock } : {}),
    build: async (row) => buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: now, text, html, automatic: true }),
  })
  if (delivered === 'sent') return (await finish('sent', { day: facts.day, lanes: facts.view.lanes.length, outboundId })).result
  return (await finish('failed', { day: facts.day, why: 'the mail could not be sent (a suppressed address, or the provider refused it)' })).result
}

export function dailyReportCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({
    name: 'production.dailyReport',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runDailyReports(options)
      if (result.due > 0) options.log.info({ ...result }, 'daily production reports')
    },
  })
}
