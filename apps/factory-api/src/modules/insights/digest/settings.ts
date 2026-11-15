import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import {
  DIGEST_DEFAULTS,
  digestHeld,
  digestKey,
  insightsKey,
  nextSendAt,
  sectionsInOrder,
  settingProblems,
  type DigestLocale,
  type DigestSection,
} from '@nexus/factory-domain/insights-digest/digest'
import { HOME_DIGEST_SWITCH } from '@nexus/factory-domain/insights-digest/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { Reader } from '../facts/rows'
import { officeContextOf } from '../viewer'
import { companiesReached, type ReachedCompany } from './person'

/**
 * The owner digest's settings (B-W2b-435; ANA-032; design home.reports `digest` "Time (07:30 site time), recipients, language",
 * Edit with EditModeBar; home.today ⋯ "Daily digest by e-mail"):
 *
 *   GET  /insights/digest          home.view: my morning e-mail (or its defaults: off, 07:30 on my company's site clock, Mon–Fri, my
 *                                  language, every section), the companies I reach with each one's switch, why it would not go out
 *                                  (OFF | MAIL_OFF), when it goes out next, and — for each company whose switch I hold — who gets it
 *   PUT  /insights/digest          home.view: mine, at the version read (0: never saved) — command insights.saveDigest, the row
 *        {enabled, sendTime, weekdays, locale, sections, companyId, version}   locked by its key; turned on → when and by whom
 *   PUT  /insights/digest/switch   home.digest.switch over the company (the owner's): a company's morning e-mail on or off, at the
 *        {companyId, on, version}  version read (0: never switched) — command insights.switchDigestMail
 *
 * The clock is the company's first site's ("07:30 site time"; a group digest: the session company's, else the first company's).
 * Nothing here sends: the scheduler does (./mail.ts), only while both the person's and the company's switches are on.
 */

const SETTING = {
  id: true,
  userId: true,
  enabled: true,
  enabledAt: true,
  companyId: true,
  sendTime: true,
  timeZone: true,
  weekdays: true,
  locale: true,
  sections: true,
  lastSentAt: true,
  version: true,
} as const satisfies Prisma.DigestSettingSelect
export type SettingRow = Prisma.DigestSettingGetPayload<{ select: typeof SETTING }>

const SWITCH = { id: true, companyId: true, digestMailOn: true, digestMailOnAt: true, digestMailOnById: true, version: true } as const satisfies Prisma.InsightsSettingsSelect
type SwitchRow = Prisma.InsightsSettingsGetPayload<{ select: typeof SWITCH }>

export async function settingOf(db: Reader, userId: string): Promise<SettingRow | null> {
  return db.digestSetting.findFirst({ where: { key: digestKey(userId) }, select: SETTING })
}

export async function switchesOf(db: Reader, companyIds: readonly string[]): Promise<Map<string, SwitchRow>> {
  if (companyIds.length === 0) return new Map()
  const rows = await db.insightsSettings.findMany({ where: { companyId: { in: [...companyIds] } }, select: SWITCH })
  return new Map(rows.map((row) => [row.companyId, row]))
}

/** The clock of a digest: its company's site clock; a group digest the session company's, else the first company's. */
export function zoneOf(companies: readonly ReachedCompany[], companyId: string | null, sessionCompanyId: string | undefined): string {
  const own = companyId ? companies.find((company) => company.id === companyId) : (companies.find((company) => company.id === sessionCompanyId) ?? companies[0])
  return own?.siteZone ?? DIGEST_DEFAULTS.timeZone
}

export interface DigestView {
  readonly saved: boolean
  readonly enabled: boolean
  readonly enabledAt: string | null
  readonly companyId: string | null
  readonly sendTime: string
  readonly timeZone: string
  readonly weekdays: number[]
  readonly locale: DigestLocale
  readonly sections: DigestSection[]
  readonly lastSentAt: string | null
  readonly version: number
}

/** My digest as stored, or its defaults (my session's company when I reach it, my language). */
export function settingView(row: SettingRow | null, defaults: { readonly companyId: string | null; readonly timeZone: string; readonly locale: string }): DigestView {
  if (!row) {
    return {
      saved: false,
      enabled: false,
      enabledAt: null,
      companyId: defaults.companyId,
      sendTime: DIGEST_DEFAULTS.sendTime,
      timeZone: defaults.timeZone,
      weekdays: [...DIGEST_DEFAULTS.weekdays],
      locale: defaults.locale === 'en' ? 'en' : 'it',
      sections: [...DIGEST_DEFAULTS.sections],
      lastSentAt: null,
      version: 0,
    }
  }
  return {
    saved: true,
    enabled: row.enabled,
    enabledAt: row.enabledAt ? toUtcIso(row.enabledAt) : null,
    companyId: row.companyId,
    sendTime: row.sendTime,
    timeZone: row.timeZone,
    weekdays: [...row.weekdays],
    locale: row.locale === 'en' ? 'en' : 'it',
    sections: sectionsInOrder(row.sections),
    lastSentAt: row.lastSentAt ? toUtcIso(row.lastSentAt) : null,
    version: row.version,
  }
}

/** The companies a digest covers among those reached: its company, or all (a group digest). */
export const coveredBy = (companies: readonly ReachedCompany[], companyId: string | null): ReachedCompany[] => (companyId ? companies.filter((company) => company.id === companyId) : [...companies])

/** May the actor switch a company's morning e-mail (the owner's switch, over that company). */
export const maySwitch = (actor: Actor, companyId: string): boolean => can(actor, HOME_DIGEST_SWITCH, { companyId })

/** GET /insights/digest */
export async function getDigest(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const companies = await companiesReached(db, actor)
    const row = await settingOf(db, context.actorId)
    const user = await db.user.findUnique({ where: { id: context.actorId }, select: { email: true, locale: true } })
    const sessionCompany = companies.some((company) => company.id === context.companyId) ? (context.companyId ?? null) : null
    const defaultCompany = companies.length === 1 ? companies[0]!.id : sessionCompany
    const setting = settingView(row, { companyId: defaultCompany, timeZone: zoneOf(companies, defaultCompany, context.companyId), locale: user?.locale ?? 'it' })
    const switches = await switchesOf(db, companies.map((company) => company.id))
    const covered = coveredBy(companies, setting.companyId)
    const on = covered.filter((company) => switches.get(company.id)?.digestMailOn === true)
    const held = digestHeld(setting.enabled, on.length)
    const sentToday = row?.lastSentAt ? businessDate(row.lastSentAt, setting.timeZone) === businessDate(now, setting.timeZone) : false
    const next = held === null ? nextSendAt(setting, now, sentToday) : null
    const switchable = companies.filter((company) => maySwitch(actor, company.id))
    const recipients =
      switchable.length === 0
        ? []
        : await db.digestSetting.findMany({
            where: { enabled: true, OR: [{ companyId: { in: switchable.map((company) => company.id) } }, { companyId: null }], user: { status: 'ACTIVE' } },
            orderBy: [{ user: { displayName: 'asc' } }, { id: 'asc' }],
            take: 500,
            select: { userId: true, companyId: true, sendTime: true, timeZone: true, locale: true, user: { select: { displayName: true } } },
          })
    return {
      asOf: toUtcIso(now),
      setting,
      email: user?.email ?? null,
      held,
      nextAt: next ? toUtcIso(next) : null,
      companies: companies.map((company) => {
        const row = switches.get(company.id)
        return {
          id: company.id,
          code: company.code,
          name: company.name,
          timeZone: company.siteZone,
          mailOn: row?.digestMailOn === true,
          mailOnAt: row?.digestMailOnAt ? toUtcIso(row.digestMailOnAt) : null,
          maySwitch: maySwitch(actor, company.id),
          switchVersion: row?.version ?? 0,
          // Who gets it there (only where I hold the switch): their own digests of this company, and the group digests.
          recipients: maySwitch(actor, company.id)
            ? recipients
                .filter((entry) => entry.companyId === company.id || entry.companyId === null)
                .map((entry) => ({ id: entry.userId, name: entry.user.displayName, me: entry.userId === context.actorId, group: entry.companyId === null, sendTime: entry.sendTime, timeZone: entry.timeZone, locale: entry.locale === 'en' ? ('en' as const) : ('it' as const) }))
            : null,
        }
      }),
    }
  })
}

export interface SaveDigestBody {
  readonly enabled: boolean
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: 'it' | 'en'
  readonly sections: readonly DigestSection[]
  readonly companyId: string | null
  readonly version: number
}

async function lockSetting(tx: CommandTx, key: string): Promise<SettingRow | null> {
  await tx.$queryRaw`SELECT id FROM "DigestSetting" WHERE "key" = ${key} FOR UPDATE`
  return tx.digestSetting.findFirst({ where: { key }, select: SETTING })
}

/** PUT /insights/digest (command insights.saveDigest): my morning e-mail, at the version read. */
export async function saveDigest(caller: CommandCaller, body: SaveDigestBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const companies = await caller.withClient((db) => companiesReached(db, actor))
  if (body.companyId !== null && !companies.some((company) => company.id === body.companyId))
    throw new ValidationError('Choose a company you work in, or every company.', [{ path: 'body/companyId', message: 'Not a company you work in.' }])
  const timeZone = zoneOf(companies, body.companyId, context.companyId)
  const sections = sectionsInOrder(body.sections)
  const problems = settingProblems({ sendTime: body.sendTime, timeZone, weekdays: body.weekdays, locale: body.locale, sections: body.sections })
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The morning e-mail settings are not valid.', problems)
  const key = digestKey(context.actorId)
  const { result } = await command(caller, { name: 'insights.saveDigest', idempotencyKey, input: body }, async (tools) => {
    const existing = await lockSetting(tools.tx, key)
    if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('DigestSetting', existing?.id ?? key, existing?.version ?? 0, body.version)
    const turnedOn = body.enabled && !existing?.enabled
    const fields = {
      enabled: body.enabled,
      ...(body.enabled ? (turnedOn ? { enabledAt: tools.now, enabledById: context.actorId } : {}) : { enabledAt: null, enabledById: null }),
      companyId: body.companyId,
      sendTime: body.sendTime,
      timeZone,
      weekdays: [...body.weekdays],
      locale: body.locale,
      sections,
    }
    const row = existing
      ? await tools.tx.digestSetting.update({ where: { id: existing.id }, data: { ...fields, version: existing.version + 1, updatedAt: tools.now }, select: SETTING })
      : await tools.tx.digestSetting.create({ data: { id: newId(), userId: context.actorId, key, ...fields, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: SETTING })
    const change = !existing ? 'CREATED' : turnedOn ? 'TURNED_ON' : existing.enabled && !body.enabled ? 'TURNED_OFF' : 'CHANGED'
    tools.audit({
      recordType: 'DigestSetting',
      recordId: row.id,
      companyId: body.companyId,
      ...(existing ? { before: { enabled: existing.enabled, companyId: existing.companyId, sendTime: existing.sendTime, timeZone: existing.timeZone, weekdays: existing.weekdays, locale: existing.locale, sections: existing.sections } } : {}),
      after: { enabled: row.enabled, companyId: row.companyId, sendTime: row.sendTime, timeZone: row.timeZone, weekdays: row.weekdays, locale: row.locale, sections: row.sections },
    })
    tools.emit({ type: 'digest.changed', subject: row.id, ...(body.companyId ? { companyId: body.companyId } : {}), payload: { digestId: row.id, userId: context.actorId, enabled: row.enabled, change } })
    return row.id
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Your morning e-mail was just saved from another window: read it again.')
    throw error
  })
  void result
  return getDigest(caller)
}

export interface SwitchBody {
  readonly companyId: string
  readonly on: boolean
  readonly version: number
}

/** PUT /insights/digest/switch (command insights.switchDigestMail): a company's morning e-mail on or off. */
export async function switchDigestMail(caller: CommandCaller, body: SwitchBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const company = await caller.withClient((db) => db.company.findUnique({ where: { id: body.companyId }, select: { id: true, status: true } }))
  if (!company || company.status !== 'ACTIVE') throw new NotFoundError('Company not found.')
  if (!maySwitch(actor, company.id)) throw new ForbiddenError("Only the owner switches a company's morning e-mail on or off.")
  const key = insightsKey(company.id)
  await command(caller, { name: 'insights.switchDigestMail', idempotencyKey, input: body }, async (tools) => {
    await tools.tx.$queryRaw`SELECT id FROM "InsightsSettings" WHERE "key" = ${key} FOR UPDATE`
    const existing = await tools.tx.insightsSettings.findFirst({ where: { key }, select: SWITCH })
    if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('InsightsSettings', existing?.id ?? key, existing?.version ?? 0, body.version)
    if ((existing?.digestMailOn ?? false) === body.on) {
      tools.audit({ action: 'insights.switchDigestMail', recordType: 'InsightsSettings', recordId: existing?.id ?? company.id, companyId: company.id, after: { digestMailOn: body.on, unchanged: true } })
      return null
    }
    const fields = body.on ? { digestMailOn: true, digestMailOnAt: tools.now, digestMailOnById: context.actorId } : { digestMailOn: false, digestMailOnAt: null, digestMailOnById: null }
    const row = existing
      ? await tools.tx.insightsSettings.update({ where: { id: existing.id }, data: { ...fields, version: existing.version + 1, updatedAt: tools.now }, select: SWITCH })
      : await tools.tx.insightsSettings.create({ data: { id: newId(), companyId: company.id, key, ...fields, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: SWITCH })
    tools.audit({ action: 'insights.switchDigestMail', recordType: 'InsightsSettings', recordId: row.id, companyId: company.id, before: { digestMailOn: existing?.digestMailOn ?? false }, after: { digestMailOn: row.digestMailOn } })
    tools.emit({ type: 'digest.switch_changed', subject: row.id, companyId: company.id, payload: { settingsId: row.id, companyId: company.id, on: row.digestMailOn } })
    return null
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError("The company's morning e-mail was just switched from another window: read it again.")
    throw error
  })
  return getDigest(caller)
}
