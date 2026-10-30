import type { Prisma } from '@nexus/factory-db'
import { events as alertEvents } from '@nexus/factory-domain/alerts/events'
import { KINDS, RULE_KINDS, isRuleKind, readThreshold, thresholdOf, type AlertChannel, type AlertSeverity, type RuleKind, type RuleTrigger } from '@nexus/factory-domain/alerts/kinds'
import { ALERTS_RULES_MANAGE, ALERTS_VIEW } from '@nexus/factory-domain/alerts/permissions'
import { cooldownWords, phraseText, alertPhrase, RULE_REFUSALS, ruleSentence, kindLabel, type RuleRefusal } from '@nexus/factory-domain/alerts/rules'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { cancelTimersOfRule } from '../timers/service'
import { datedFor, findFor, FIND_LIMIT } from './evaluators'
import { officeOf, placeNames, RULE_COLUMNS, RULE_SCOPE, type Reader, type RuleRow } from './store'

/**
 * The exception rules (B-W2a-33; ANA-036, PLT-100; design home.alerts "Rules" with the popup rule, admin.automation
 * "Reminders & timers"): the rules list (sentence, numbers, place, whom it tells, cooldown, last fired, fired in 7 days,
 * on/off; with the kinds a new rule may watch), one rule, a new rule of a kind, a rule's change (its numbers, place,
 * recipients, channels, cooldown, severity, name, on or off; its kind and built-in mark never change), a dry run of a
 * rule's numbers against the records now ("would find 6"), and a DATE rule's timers. Seeing them is alerts.view over the
 * rule's place; changing them is alerts.rules.manage there (a rule of every company: over every company). A DATE rule
 * switched off, or whose numbers or place change, cancels its PENDING timers in the same command; the next evaluation sets
 * the ones still needed.
 */

const [, , , , , ruleChanged] = alertEvents

const refused = (code: RuleRefusal, path: string): DomainError => new DomainError('conflict', RULE_REFUSALS[code], [{ path, message: RULE_REFUSALS[code] }])

/** May the actor change a rule of this place: over its company and site, or (everywhere) in a grant over every company and site. */
export function mayManage(actor: Actor, place: { readonly companyId: string | null; readonly siteId: string | null }): boolean {
  if (place.companyId !== null) return can(actor, ALERTS_RULES_MANAGE, { companyId: place.companyId, siteId: place.siteId })
  return grantsFor(actor, ALERTS_RULES_MANAGE).some((grant) => grant.companies === 'all' && grant.sites === 'all')
}

type RuleSentenceInput = Pick<RuleRow, 'ruleKind' | 'threshold' | 'channels' | 'cooldownMinutes' | 'companyId' | 'siteId' | 'recipientRoleId'>

/** A rule's sentence in both languages, with its place's and role's names. */
export async function ruleSentenceOf(db: Reader, rule: RuleSentenceInput): Promise<{ en: string; it: string }> {
  const names = await placeNames(db, [rule])
  return sentencesWith(rule, names)
}

function placeLabel(rule: Pick<RuleRow, 'companyId' | 'siteId'>, names: Awaited<ReturnType<typeof placeNames>>): string | null {
  if (rule.siteId) return names.sites.get(rule.siteId) ?? null
  if (rule.companyId) return names.companies.get(rule.companyId) ?? null
  return null
}

function sentencesWith(rule: RuleSentenceInput, names: Awaited<ReturnType<typeof placeNames>>): { en: string; it: string } {
  if (!isRuleKind(rule.ruleKind)) return { en: rule.ruleKind, it: rule.ruleKind }
  const input = { ruleKind: rule.ruleKind, threshold: rule.threshold, channels: rule.channels as AlertChannel[], cooldownMinutes: rule.cooldownMinutes }
  const words = { place: placeLabel(rule, names), recipient: rule.recipientRoleId ? (names.roles.get(rule.recipientRoleId) ?? null) : null }
  return { en: ruleSentence(input, words, 'en'), it: ruleSentence(input, words, 'it') }
}

const WEEK_MS = 7 * 86_400_000

async function ruleViews(db: Reader, actor: Actor, rules: readonly RuleRow[], now: Date) {
  const names = await placeNames(db, rules)
  const ids = rules.map((rule) => rule.id)
  const last = ids.length ? await db.alert.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids } }, _max: { raisedAt: true } }) : []
  const week = ids.length ? await db.alert.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, raisedAt: { gte: new Date(now.getTime() - WEEK_MS) } }, _count: { _all: true } }) : []
  const open = ids.length ? await db.alert.groupBy({ by: ['ruleId'], where: { ruleId: { in: ids }, state: { not: 'RESOLVED' } }, _count: { _all: true } }) : []
  const dateIds = rules.filter((rule) => rule.trigger === 'DATE').map((rule) => rule.id)
  const timers = dateIds.length ? await db.dueTimer.groupBy({ by: ['ruleId'], where: { ruleId: { in: dateIds }, status: 'PENDING' }, _count: { _all: true }, _min: { fireAt: true } }) : []
  return rules.filter((rule) => isRuleKind(rule.ruleKind)).map((rule) => {
    const kind = rule.ruleKind as RuleKind
    const timer = timers.find((entry) => entry.ruleId === rule.id)
    const lastAt = last.find((entry) => entry.ruleId === rule.id)?._max.raisedAt ?? null
    return {
      id: rule.id,
      ruleKind: kind,
      trigger: rule.trigger as RuleTrigger,
      kindLabel: kindLabel(kind),
      name: rule.name,
      sentence: sentencesWith(rule, names),
      threshold: thresholdOf(kind, rule.threshold),
      severity: rule.severity as AlertSeverity,
      place: { companyId: rule.companyId, siteId: rule.siteId, label: placeLabel(rule, names) },
      recipient: rule.recipientRoleId ? { roleId: rule.recipientRoleId, name: names.roles.get(rule.recipientRoleId) ?? '' } : null,
      channels: rule.channels as AlertChannel[],
      cooldownMinutes: rule.cooldownMinutes,
      cooldownWords: cooldownWords(rule.cooldownMinutes),
      enabled: rule.enabled,
      builtIn: rule.builtIn,
      lastFiredAt: lastAt ? toUtcIso(lastAt) : null,
      fired7Days: week.find((entry) => entry.ruleId === rule.id)?._count._all ?? 0,
      openAlerts: open.find((entry) => entry.ruleId === rule.id)?._count._all ?? 0,
      timers: rule.trigger === 'DATE' ? { pending: timer?._count._all ?? 0, nextFireAt: timer?._min.fireAt ? toUtcIso(timer._min.fireAt) : null } : null,
      canChange: mayManage(actor, rule),
      version: rule.version,
    }
  })
}

const visibleRules = (actor: Actor): Prisma.AlertRuleWhereInput => scopeWhere(actor, ALERTS_VIEW, RULE_SCOPE) as Prisma.AlertRuleWhereInput

/** GET /alerts/rules: every rule the reader may see (a trigger's, a kind's), with the kinds a new rule may watch. */
export async function listRules(caller: CommandCaller, query: { readonly trigger?: RuleTrigger | undefined; readonly ruleKind?: RuleKind | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const rules = await db.alertRule.findMany({
      where: { AND: [visibleRules(actor), query.trigger ? { trigger: query.trigger } : {}, query.ruleKind ? { ruleKind: query.ruleKind } : {}] },
      orderBy: [{ trigger: 'asc' }, { ruleKind: 'asc' }, { builtIn: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: RULE_COLUMNS,
    })
    return {
      asOf: toUtcIso(now),
      rules: await ruleViews(db, actor, rules, now),
      kinds: RULE_KINDS.filter((kind) => (!query.trigger || KINDS[kind].trigger === query.trigger) && (!query.ruleKind || kind === query.ruleKind)).map((kind) => ({
        kind,
        trigger: KINDS[kind].trigger,
        recordType: KINDS[kind].recordType,
        label: KINDS[kind].label,
        defaults: { ...KINDS[kind].builtIn.threshold },
      })),
      canAdd: holds(actor, ALERTS_RULES_MANAGE),
    }
  })
}

async function readRule(db: Reader, actor: Actor, id: string): Promise<RuleRow> {
  const rule = await db.alertRule.findFirst({ where: { AND: [{ id }, visibleRules(actor)] }, select: RULE_COLUMNS })
  if (!rule || !isRuleKind(rule.ruleKind)) throw new NotFoundError('Rule not found.')
  return rule
}

/** GET /alerts/rules/:id */
export async function getRule(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => ({ rule: (await ruleViews(db, actor, [await readRule(db, actor, id)], serverClock.now()))[0]! }))
}

export interface RuleFields {
  readonly name?: string | undefined
  readonly threshold?: Record<string, number | boolean> | undefined
  readonly severity?: AlertSeverity | undefined
  readonly companyId?: string | null | undefined
  readonly siteId?: string | null | undefined
  readonly recipientRoleId?: string | null | undefined
  readonly channels?: readonly AlertChannel[] | undefined
  readonly cooldownMinutes?: number | undefined
  readonly enabled?: boolean | undefined
}

/** Checks the fields of a rule of this kind against the database: the place, the role, the channels, the numbers. */
async function checkFields(tx: CommandTx, kind: RuleKind, next: { companyId: string | null; siteId: string | null; recipientRoleId: string | null; channels: readonly AlertChannel[]; threshold: unknown }): Promise<Record<string, number | boolean>> {
  const issues: Issue[] = []
  const threshold = readThreshold(kind, next.threshold)
  if (!threshold.ok) for (const problem of threshold.problems) issues.push({ path: 'body/threshold', message: problem })
  if (next.siteId !== null && next.companyId === null) throw refused('SITE_NEEDS_COMPANY', 'body/siteId')
  if (!next.channels.includes('IN_APP')) throw refused('NO_BELL', 'body/channels')
  if (new Set(next.channels).size !== next.channels.length) issues.push({ path: 'body/channels', message: 'Each channel once.' })
  if (next.companyId !== null && !(await tx.company.findUnique({ where: { id: next.companyId }, select: { id: true } }))) issues.push({ path: 'body/companyId', message: 'No such company.' })
  if (next.siteId !== null) {
    const site = await tx.site.findUnique({ where: { id: next.siteId }, select: { companyId: true } })
    if (!site || site.companyId !== next.companyId) issues.push({ path: 'body/siteId', message: 'No such site of this company.' })
  }
  if (next.recipientRoleId !== null) {
    const role = await tx.role.findUnique({ where: { id: next.recipientRoleId }, select: { audience: true } })
    if (!role || role.audience !== 'OFFICE') issues.push({ path: 'body/recipientRoleId', message: 'Choose an office role.' })
  }
  if (issues.length > 0) throw new ValidationError('The rule is not valid.', issues)
  return (threshold as { threshold: Record<string, number | boolean> }).threshold
}

function emitChanged(tools: CommandTools, rule: Pick<RuleRow, 'id' | 'ruleKind' | 'enabled' | 'companyId' | 'siteId'>, fields: readonly string[]): void {
  tools.emit(eventFor(ruleChanged, { subject: rule.id, companyId: rule.companyId, siteId: rule.siteId, payload: { ruleId: rule.id, ruleKind: rule.ruleKind, enabled: rule.enabled, fields: [...fields] } }))
}

/** POST /alerts/rules: a new rule of a kind (for a company or a site, other numbers, other recipients). */
export async function createRule(caller: CommandCaller, body: RuleFields & { readonly ruleKind: RuleKind }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const place = { companyId: body.companyId ?? null, siteId: body.siteId ?? null }
  if (!mayManage(actor, place)) throw new ForbiddenError('You may not keep the rules of this place.')
  const { result } = await command(caller, { name: 'alerts.createRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const spec = KINDS[body.ruleKind]
    const channels = body.channels ?? ['IN_APP']
    const recipientRoleId = body.recipientRoleId === undefined ? null : body.recipientRoleId
    const threshold = await checkFields(tx, body.ruleKind, { ...place, recipientRoleId, channels, threshold: body.threshold ?? spec.builtIn.threshold })
    const id = newId()
    await tx.alertRule.create({
      data: {
        id,
        ruleKind: body.ruleKind,
        trigger: spec.trigger,
        name: (body.name ?? spec.builtIn.name.en).trim(),
        threshold: threshold as Prisma.InputJsonValue,
        severity: body.severity ?? spec.builtIn.severity,
        ...place,
        recipientRoleId,
        channels: [...channels],
        cooldownMinutes: body.cooldownMinutes ?? spec.builtIn.cooldownMinutes,
        enabled: body.enabled ?? true,
        builtIn: false,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const row = await tx.alertRule.findUniqueOrThrow({ where: { id }, select: RULE_COLUMNS })
    tools.audit({ action: 'alerts.createRule', recordType: 'AlertRule', recordId: id, companyId: row.companyId, siteId: row.siteId, after: { ruleKind: row.ruleKind, threshold, enabled: row.enabled, recipientRoleId } })
    emitChanged(tools, row, ['created'])
    return { rule: (await ruleViews(tx, actor, [row], now))[0]! }
  })
  return result
}

/** PUT /alerts/rules/:id: its numbers, place, recipients, channels, cooldown, severity, name, on or off. */
export async function updateRule(caller: CommandCaller, id: string, body: RuleFields & { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'alerts.updateRule', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT id FROM "AlertRule" WHERE id = ${id}::uuid FOR UPDATE`
    const row = await readRule(tx, actor, id)
    if (!mayManage(actor, row)) throw new ForbiddenError('You may see this rule but not change it.')
    if (row.version !== body.version) throw new StaleVersionError('AlertRule', id, row.version, body.version)
    const kind = row.ruleKind as RuleKind
    const next = {
      companyId: body.companyId === undefined ? row.companyId : body.companyId,
      siteId: body.siteId === undefined ? (body.companyId === undefined ? row.siteId : null) : body.siteId,
      recipientRoleId: body.recipientRoleId === undefined ? row.recipientRoleId : body.recipientRoleId,
      channels: body.channels ?? (row.channels as AlertChannel[]),
      threshold: body.threshold === undefined ? row.threshold : { ...thresholdOf(kind, row.threshold), ...body.threshold },
    }
    if (!mayManage(actor, next)) throw new ForbiddenError('You may not keep the rules of that place.')
    const threshold = await checkFields(tx, kind, next)
    const data: Prisma.AlertRuleUncheckedUpdateManyInput = {}
    const fields: string[] = []
    const set = <Key extends keyof Prisma.AlertRuleUncheckedUpdateManyInput>(field: Key, value: Prisma.AlertRuleUncheckedUpdateManyInput[Key], changed: boolean) => {
      if (!changed) return
      data[field] = value
      fields.push(field)
    }
    set('name', body.name?.trim(), body.name !== undefined && body.name.trim() !== row.name)
    set('threshold', threshold as Prisma.InputJsonValue, JSON.stringify(threshold) !== JSON.stringify(thresholdOf(kind, row.threshold)))
    set('severity', body.severity, body.severity !== undefined && body.severity !== row.severity)
    set('companyId', next.companyId, next.companyId !== row.companyId)
    set('siteId', next.siteId, next.siteId !== row.siteId)
    set('recipientRoleId', next.recipientRoleId, next.recipientRoleId !== row.recipientRoleId)
    set('channels', [...next.channels], JSON.stringify([...next.channels].sort()) !== JSON.stringify([...row.channels].sort()))
    set('cooldownMinutes', body.cooldownMinutes, body.cooldownMinutes !== undefined && body.cooldownMinutes !== row.cooldownMinutes)
    set('enabled', body.enabled, body.enabled !== undefined && body.enabled !== row.enabled)
    if (fields.length === 0) throw new DomainError('conflict', 'Nothing to change: the rule is like that already.', [{ path: 'rule/UNCHANGED', message: 'Nothing to change.' }])
    const { count } = await tx.alertRule.updateMany({ where: { id, version: row.version }, data: { ...(data as Prisma.AlertRuleUpdateManyMutationInput), version: row.version + 1, updatedAt: now } })
    if (count === 0) throw new StaleVersionError('AlertRule', id, row.version + 1, row.version)
    const updated = await tx.alertRule.findUniqueOrThrow({ where: { id }, select: RULE_COLUMNS })
    // A DATE rule's timers follow it: switched off, or its numbers or place changed → its PENDING timers are cancelled.
    let timersCancelled = 0
    if (row.trigger === 'DATE') {
      if (!updated.enabled && row.enabled) timersCancelled = await cancelTimersOfRule(tools, id, 'RULE_OFF')
      else if (updated.enabled && (fields.includes('threshold') || fields.includes('companyId') || fields.includes('siteId'))) timersCancelled = await cancelTimersOfRule(tools, id, 'RULE_CHANGED')
    }
    tools.audit({
      action: 'alerts.updateRule',
      recordType: 'AlertRule',
      recordId: id,
      companyId: updated.companyId,
      siteId: updated.siteId,
      before: Object.fromEntries(fields.map((field) => [field, (row as Record<string, unknown>)[field] ?? null])),
      after: { ...Object.fromEntries(fields.map((field) => [field, (updated as Record<string, unknown>)[field] ?? null])), timersCancelled },
    })
    emitChanged(tools, updated, fields)
    return { rule: (await ruleViews(tx, actor, [updated], now))[0]! }
  })
  return result
}

/** POST /alerts/rules/:id/test: what these numbers and this place would find now (nothing is saved). */
export async function testRule(caller: CommandCaller, id: string, body: { readonly threshold?: Record<string, number | boolean> | undefined; readonly companyId?: string | null | undefined; readonly siteId?: string | null | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const rule = await readRule(db, actor, id)
    const kind = rule.ruleKind as RuleKind
    const threshold = body.threshold === undefined ? rule.threshold : { ...thresholdOf(kind, rule.threshold), ...body.threshold }
    const read = readThreshold(kind, threshold)
    if (!read.ok) throw new ValidationError('The numbers are not valid.', read.problems.map((message) => ({ path: 'body/threshold', message })))
    const tried = { threshold: read.threshold, companyId: body.companyId === undefined ? rule.companyId : body.companyId, siteId: body.siteId === undefined ? rule.siteId : body.siteId }
    const tx = db as CommandTx
    let found: { recordType: string; recordId: string; label: string; scope: { companyId: string | null; siteId: string | null; partyId: string | null }; facts: unknown }[]
    if (KINDS[kind].trigger === 'CONDITION') found = await findFor(kind, tx, tried, now)
    else {
      // A DATE rule's window: the records whose lead time has begun (calendar days for the dry run).
      const daysBefore = Number(read.threshold.daysBefore ?? 0)
      const today = now.toISOString().slice(0, 10)
      const lead = new Date(`${today}T00:00:00.000Z`).getTime() + daysBefore * 86_400_000
      found = (await datedFor(kind, tx, tried, now)).filter((record) => new Date(`${record.date}T00:00:00.000Z`).getTime() <= lead).map((record) => ({ ...record, facts: { dueDate: record.date, daysLeft: Math.round((new Date(`${record.date}T00:00:00.000Z`).getTime() - new Date(`${today}T00:00:00.000Z`).getTime()) / 86_400_000) } }))
    }
    // Only what the reader may see of the records (the kind's view permission over each one's place).
    const seen = found.filter((record) => can(actor, KINDS[kind].view, record.scope))
    const fired7Days = await db.alert.count({ where: { ruleId: id, raisedAt: { gte: new Date(now.getTime() - WEEK_MS) } } })
    return {
      wouldFind: seen.length,
      complete: found.length < FIND_LIMIT,
      sample: seen.slice(0, 5).map((record) => ({ record: { type: record.recordType, id: record.recordId, label: record.label }, sentence: phraseText(alertPhrase(kind, record.label, record.facts), record.label) })),
      fired7Days,
    }
  })
}

/** GET /alerts/rules/:id/timers: a DATE rule's timers, the waiting ones first (at most 100). */
export async function ruleTimers(caller: CommandCaller, id: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => {
    const rule = await readRule(db, actor, id)
    const rows = await db.dueTimer.findMany({ where: { ruleId: id }, orderBy: [{ status: 'asc' }, { fireAt: 'asc' }, { id: 'asc' }], take: 100 })
    const kind = rule.ruleKind as RuleKind
    return {
      timers: rows
        .filter((row) => can(actor, KINDS[kind].view, { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId }))
        .map((row) => ({
          id: row.id,
          timerKey: row.timerKey,
          record: { type: row.recordType, id: row.recordId, label: row.recordLabel },
          dueAt: toUtcIso(row.dueAt),
          fireAt: toUtcIso(row.fireAt),
          status: row.status,
          firedAt: row.firedAt ? toUtcIso(row.firedAt) : null,
          cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
          cancelReason: row.cancelReason,
        })),
    }
  })
}

