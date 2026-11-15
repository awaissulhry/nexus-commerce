import type { FactoryDatabase } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { escapeHtml, footerOf, privacyNoticeUrl } from '@nexus/factory-domain/email/footer'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { buildMime } from '@nexus/factory-domain/email/mime'
import { identityReady } from '@nexus/factory-domain/email/rules'
import { digestDueNow, digestMail, isDigestSection, type DigestContent, type DigestLocale } from '@nexus/factory-domain/insights-digest/digest'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { deliverOutbound } from '../../../platform/email-out/outbound'
import { processEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { activeTenants, asSystem, systemContext } from '../../../platform/outbox/system'
import { officeContextOf } from '../viewer'
import { digestContent, type DigestScope } from './content'
import { companiesReached, personOf, type ReachedCompany } from './person'
import { coveredBy, settingOf, settingView, switchesOf, zoneOf } from './settings'

/**
 * The owner digest by e-mail (B-W2b-435; ANA-032 "the morning summary without opening the app"; PLT-142 quiet defaults). The
 * scheduler's clustered cron `insights.ownerDigest` (every 15 minutes) sends each person's morning e-mail once a day, at its time
 * on its weekdays on its clock, ONLY while both switches are on: theirs (DigestSetting.enabled, OFF until they turn it on) and
 * their company's (InsightsSettings.digestMailOn, OFF until the owner switches it on; a group digest lists only the companies
 * switched on). For each due digest of an ACTIVE person:
 *
 *   1. what it says, read as the person now (./content.ts: their live roles; money only with its grain), in their language;
 *   2. one EmailOutbound (record `User`, template `insights.digest`, NO body) from the tenant's default NOTIFICATION identity,
 *      sent at once by deliverOutbound (suppression and identity checked again; FAKE accounts locally and in tests);
 *   3. ONE command marks lastSentAt (the database refuses it while either switch is off), audits the outcome (counts only) and
 *      emits digest.sent.
 *
 * `POST /insights/digest/test` ("Send me a test") sends the same mail to the person now, marked [Test], without marking it sent —
 * held while no company it covers has its morning e-mail switched on (the owner's rule). Nothing is sent by itself in tests: the
 * cron runs only in the scheduler.
 */

export const DIGEST_TEMPLATE_KEY = 'insights.digest'

const IDENTITY = { id: true, companyId: true, domain: true, fromAddress: true, displayName: true, displayNamePolicy: true, status: true, verificationStatus: true, dkimStatus: true } as const

export interface PersonMail {
  readonly userId: string
  readonly to: string
  readonly name: string
  readonly locale: DigestLocale
  readonly templateKey: string
  readonly subject: string
  readonly lines: readonly string[]
}

/** One mail to one office person of the tenant (no thread, no reply address): 'sent' with its id, or 'failed' with why. */
export async function mailPerson(caller: CommandCaller, runtime: EmailRuntime, mail: PersonMail, now: Date, clock?: Clock): Promise<{ readonly sent: true; readonly outboundId: string } | { readonly sent: false; readonly why: string }> {
  const identities = await caller.withClient((client) =>
    client.emailIdentity.findMany({ where: { status: 'ACTIVE', isDefault: true, kind: { in: ['NOTIFICATION', 'CONVERSATION'] } }, orderBy: [{ kind: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: IDENTITY }),
  )
  const identity = identities.find((entry) => identityReady(entry)) ?? null
  if (!identity) return { sent: false, why: 'the tenant has no verified sending identity' }
  const company = await companyLegalOf(caller, identity.companyId)
  const greeting = mail.locale === 'it' ? `Ciao ${mail.name},` : `Hello ${mail.name},`
  const footer = footerOf(company, privacyNoticeUrl(runtime.webOrigin, identity.companyId), mail.locale)
  const text = [greeting, '', ...mail.lines, '', footer.text].join('\n')
  const html = `<p>${escapeHtml(greeting)}</p>${mail.lines.map((line) => (line === '' ? '' : `<p>${escapeHtml(line)}</p>`)).join('')}${footer.html}`
  const from = fromLine(identity, null)
  const outboundId = newId()
  const emailMessageId = messageIdFor(outboundId, identity.domain)
  await command(caller, { name: 'email.queueSystem', input: { kind: mail.templateKey, userId: mail.userId } }, async ({ tx, now: at, audit }) => {
    await tx.emailOutbound.create({
      data: {
        id: outboundId,
        companyId: identity.companyId,
        identityId: identity.id,
        recordType: 'User',
        recordId: mail.userId,
        templateKey: mail.templateKey,
        locale: mail.locale,
        fromAddress: from.address,
        fromName: from.name,
        to: [mail.to.toLowerCase()],
        subject: mail.subject,
        emailMessageId,
        status: 'QUEUED',
        queuedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true },
    })
    audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: mail.templateKey, userId: mail.userId, identityId: identity.id, status: 'QUEUED' } })
    return null
  })
  const delivered = await deliverOutbound(runtime, caller, outboundId, {
    retry: false,
    ...(clock ? { clock } : {}),
    build: async (row) => buildMime({ id: row.id, from: { name: row.fromName, address: row.fromAddress }, to: row.to, cc: [], replyTo: null, subject: row.subject, messageId: row.emailMessageId, inReplyTo: null, references: [], date: now, text, html, automatic: true }),
  })
  return delivered === 'sent' ? { sent: true, outboundId } : { sent: false, why: 'the mail could not be sent (a suppressed address, or the provider refused it)' }
}

/** The links a digest carries: Today and its settings, on the digest's company (else the first it covers). */
export function digestLinks(webOrigin: string, company: Pick<ReachedCompany, 'code'> | undefined) {
  const base = company ? `${webOrigin}/w/${encodeURIComponent(company.code)}` : webOrigin
  return { today: `${base}/home/today`, settings: `${base}/home/reports#digest` }
}

/** The scope a digest covers now: its companies whose morning e-mail is on (none: it does not go out). */
export async function scopeNow(db: Parameters<typeof switchesOf>[0], companies: readonly ReachedCompany[], companyId: string | null, timeZone: string) {
  const covered = coveredBy(companies, companyId)
  const switches = await switchesOf(db, covered.map((company) => company.id))
  const on = covered.filter((company) => switches.get(company.id)?.digestMailOn === true)
  const scope: DigestScope = { companyIds: on.map((company) => company.id), everyCompany: on.length === companies.length, timeZone }
  return { covered, on, scope }
}

export interface DigestRunOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
  readonly runtime?: () => EmailRuntime
}

export interface DigestRunResult {
  readonly due: number
  readonly sent: number
  /** Due, but no company it covers has its morning e-mail on: not sent, not marked. */
  readonly held: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it with their clock and e-mail runtime). */
export async function runOwnerDigests(options: DigestRunOptions): Promise<DigestRunResult> {
  const now = (options.clock ?? serverClock).now()
  const requestId = `insights-owner-digest-${newId()}`
  const result = { due: 0, sent: 0, held: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const rows = await asSystem(options.database, tenantId, requestId, (client) =>
        client.digestSetting.findMany({
          where: { enabled: true, user: { status: 'ACTIVE' } },
          orderBy: { id: 'asc' },
          select: { id: true, userId: true, companyId: true, sendTime: true, timeZone: true, weekdays: true, locale: true, sections: true, lastSentAt: true, user: { select: { email: true, displayName: true, requireMfa: true } } },
        }),
      )
      const system = callerFor(options.database, systemContext(tenantId, requestId))
      for (const row of rows.filter((entry) => digestDueNow(entry, entry.lastSentAt, now))) {
        result.due += 1
        try {
          const outcome = await sendOwnerDigest(system, tenantId, row, now, (options.runtime ?? processEmail)(), requestId, options)
          result[outcome] += 1
        } catch (error) {
          result.failed += 1
          options.log.error({ err: error, tenantId, digestId: row.id }, 'an owner digest could not be sent')
        }
      }
    } catch (error) {
      result.failed += 1
      options.log.error({ err: error, tenantId }, 'the owner digests of a tenant could not be read')
    }
  }
  return result
}

interface DueDigest {
  readonly id: string
  readonly userId: string
  readonly companyId: string | null
  readonly timeZone: string
  readonly locale: string
  readonly sections: readonly string[]
  readonly user: { readonly email: string; readonly displayName: string; readonly requireMfa: boolean }
}

/** One person's morning e-mail (see the module comment): 'sent', 'held' (no company switched on: nothing written) or 'failed'. */
export async function sendOwnerDigest(system: CommandCaller, tenantId: string, row: DueDigest, now: Date, runtime: EmailRuntime, requestId: string, options: { readonly log: Log; readonly clock?: Clock }): Promise<'sent' | 'held' | 'failed'> {
  const person = await personOf(system, tenantId, { id: row.userId, requireMfa: row.user.requireMfa }, now, requestId, row.companyId)
  const { companies, on, scope } = await system.withClient(async (db) => {
    const reached = await companiesReached(db, person.actor)
    return { companies: reached, ...(await scopeNow(db, reached, row.companyId, row.timeZone)) }
  })
  if (on.length === 0) return 'held'
  const locale: DigestLocale = row.locale === 'en' ? 'en' : 'it'
  const content = await digestContent(person.caller, person.actor, scope, row.sections.filter(isDigestSection), on.map((company) => company.name), now, (section, error) =>
    options.log.error({ err: error, tenantId, digestId: row.id, section }, 'a section of an owner digest could not be read'),
  )
  const mail = digestMail(content, locale, digestLinks(runtime.webOrigin, on[0] ?? companies[0]))
  const outcome = await mailPerson(system, runtime, { userId: row.userId, to: row.user.email, name: row.user.displayName, locale, templateKey: DIGEST_TEMPLATE_KEY, subject: mail.subject, lines: mail.lines }, now, options.clock)
  const today = businessDate(now, row.timeZone)
  await command(system, { name: 'insights.digestSent', idempotencyKey: `owner-digest-${row.id}-${today}`, input: { digestId: row.id, today } }, async (tools) => {
    await tools.tx.digestSetting.update({ where: { id: row.id }, data: { lastSentAt: tools.now, updatedAt: tools.now }, select: { id: true } })
    tools.audit({
      recordType: 'DigestSetting',
      recordId: row.id,
      companyId: row.companyId,
      after: { outcome: outcome.sent ? 'sent' : 'failed', day: content.day, companies: on.length, sections: content.sections.map((section) => ({ section: section.section, state: section.state, count: section.count })), ...(outcome.sent ? { emailOutboundId: outcome.outboundId } : { why: outcome.why }) },
    })
    if (outcome.sent)
      tools.emit({ type: 'digest.sent', subject: row.userId, ...(row.companyId ? { companyId: row.companyId } : {}), payload: { digestId: row.id, userId: row.userId, emailOutboundId: outcome.outboundId, day: content.day, test: false, sections: content.sections.length } })
    return null
  })
  return outcome.sent ? 'sent' : 'failed'
}

export function ownerDigestCron(options: { readonly database: FactoryDatabase; readonly log: Log }): CronJob {
  return defineCron({
    name: 'insights.ownerDigest',
    schedule: '*/15 * * * *',
    async run() {
      const result = await runOwnerDigests(options)
      if (result.due > 0) options.log.info({ ...result }, 'owner digests')
    },
  })
}

// ---- the preview and the test ----------------------------------------------------------------------------------------------

export interface PreviewQuery {
  readonly locale?: 'it' | 'en' | undefined
  /** A company, or `all` (a group digest); default: the saved digest's. */
  readonly companyId?: string | undefined
  /** The sections, comma separated; default: the saved digest's. */
  readonly sections?: string | undefined
}

/** What the person's digest would say now, as them (the preview; the test sends it). */
async function compose(caller: CommandCaller, query: PreviewQuery, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const { companies, row, user } = await caller.withClient(async (db) => ({
    companies: await companiesReached(db, actor),
    row: await settingOf(db, context.actorId),
    user: await db.user.findUnique({ where: { id: context.actorId }, select: { email: true, displayName: true, locale: true } }),
  }))
  const defaultCompany = companies.length === 1 ? companies[0]!.id : companies.some((company) => company.id === context.companyId) ? (context.companyId ?? null) : null
  const setting = settingView(row, { companyId: defaultCompany, timeZone: zoneOf(companies, defaultCompany, context.companyId), locale: user?.locale ?? 'it' })
  const companyId = query.companyId === 'all' ? null : (query.companyId ?? setting.companyId)
  if (companyId !== null && !companies.some((company) => company.id === companyId)) throw new DomainError('not_found', 'Company not found.', [{ path: 'querystring/companyId', message: 'Not a company you work in.' }])
  const sections = query.sections !== undefined ? query.sections.split(',').filter(isDigestSection) : setting.sections
  if (sections.length === 0) throw new DomainError('validation_failed', 'Choose at least one section.', [{ path: 'querystring/sections', message: 'Choose at least one section, each once.' }])
  const locale: DigestLocale = query.locale ?? setting.locale
  const timeZone = row && companyId === row.companyId ? row.timeZone : zoneOf(companies, companyId, context.companyId)
  const { covered, on } = await caller.withClient((db) => scopeNow(db, companies, companyId, timeZone))
  // The preview shows what would go out: the companies switched on; with none, what the companies it covers hold (and says so).
  const shown = on.length > 0 ? on : covered
  const scope: DigestScope = { companyIds: shown.map((company) => company.id), everyCompany: shown.length === companies.length, timeZone }
  const content = await digestContent(caller, actor, scope, sections, shown.map((company) => company.name), now)
  return { context, digestId: row?.id ?? null, setting, companyId, locale, content, on, covered, user, companies }
}

const sectionView = (content: DigestContent['sections'][number]) => ({
  section: content.section,
  state: content.state,
  count: content.count,
  extra: content.extra,
  percent: content.percent,
  priceValue: asMoney('price', content.amount?.grain === 'price' ? content.amount.minor : null),
  costValue: asMoney('cost', content.amount?.grain === 'cost' ? content.amount.minor : null),
  currency: content.amount?.currency ?? null,
  items: content.items.map((entry) => ({ label: entry.label, days: entry.days, place: entry.place, record: entry.record })),
})

/** GET /insights/digest/preview?locale&companyId&sections (home.view): today's digest as it would go out, in a language. */
export async function previewDigest(caller: CommandCaller, query: PreviewQuery) {
  const now = serverClock.now()
  const composed = await compose(caller, query, now)
  const mail = digestMail(composed.content, composed.locale, digestLinks(processEmail().webOrigin, composed.on[0] ?? composed.covered[0]))
  return {
    asOf: now.toISOString(),
    locale: composed.locale,
    companyId: composed.companyId,
    day: composed.content.day,
    today: composed.content.today,
    companies: [...composed.content.companies],
    /** Would it go out (some company it covers has its morning e-mail on). */
    wouldSend: composed.on.length > 0,
    sections: composed.content.sections.map(sectionView),
    mail: { subject: mail.subject, lines: [...mail.lines], to: composed.user?.email ?? null },
  }
}

/** POST /insights/digest/test {locale?} (home.view): "Send me a test" — my digest to me now, marked [Test]; never marks it sent. */
export async function testDigest(caller: CommandCaller, body: { readonly locale?: 'it' | 'en' | undefined }) {
  const now = serverClock.now()
  const composed = await compose(caller, { locale: body.locale }, now)
  if (composed.on.length === 0) throw new DomainError('conflict', "The morning e-mail of this company is switched off: the owner switches it on first, then a test can go out.", [{ path: 'digest/MAIL_OFF', message: 'No company it covers has its morning e-mail switched on.' }])
  if (!composed.user) throw new DomainError('not_found', 'Person not found.')
  const runtime = processEmail()
  const mail = digestMail(composed.content, composed.locale, digestLinks(runtime.webOrigin, composed.on[0]), true)
  const outcome = await mailPerson(caller, runtime, { userId: composed.context.actorId, to: composed.user.email, name: composed.user.displayName, locale: composed.locale, templateKey: DIGEST_TEMPLATE_KEY, subject: mail.subject, lines: mail.lines }, now)
  if (!outcome.sent) throw new DomainError('conflict', 'The test could not be sent: no verified sending address, or the address refuses mail.', [{ path: 'digest/NOT_SENT', message: outcome.why }])
  await command(caller, { name: 'insights.digestTest', input: { locale: composed.locale } }, async (tools) => {
    tools.audit({ action: 'insights.digestTest', recordType: 'User', recordId: composed.context.actorId, companyId: composed.companyId, after: { emailOutboundId: outcome.outboundId, day: composed.content.day, sections: composed.content.sections.length } })
    tools.emit({ type: 'digest.sent', subject: composed.context.actorId, ...(composed.companyId ? { companyId: composed.companyId } : {}), payload: { digestId: composed.digestId, userId: composed.context.actorId, emailOutboundId: outcome.outboundId, day: composed.content.day, test: true, sections: composed.content.sections.length } })
    return null
  })
  return { sent: true, to: composed.user.email, subject: mail.subject }
}
