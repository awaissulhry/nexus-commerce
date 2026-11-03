import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import {
  ALERT_LIMITS,
  alertRuleProblems,
  alertRuleSentence,
  EVENT_FACTS,
  missingStarterRules,
  QUALITY_ALERT_EVENTS,
  shadowedFor,
  sortedDays,
  type AlertAudience,
  type AlertChannel,
  type AlertRuleDraft,
  type QualityAlertEvent,
} from '@nexus/factory-domain/quality/rules/alerts'
import { QUALITY_ALERTS_MANAGE, QUALITY_RULES_VIEW } from '@nexus/factory-domain/quality/rules/permissions'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import type { AlertRuleView } from './contract'
import { officeOf } from './duties'
import { FIRED_ACTION, RULE_COLUMNS, type Db, type RuleRow } from './store'

/**
 * The quality alert and escalation rules (B-W2b-118; QHS-154; design quality.settings qs-alerts): QualityAlertRule rows
 * (B-W2b-79), a company's or every company's. The company and the event never change (the database's guard).
 *
 *   GET    /quality/alert-rules?companyId   quality.rules.view: the rules of every company and of the companies the reader
 *                                           sees (one company asked: its own and every company's, with `inForce`), each
 *                                           as a sentence, its last firing and firings in 7 days; the events, the office
 *                                           roles, where the reader may keep rules, the starter rules missing
 *   POST   /quality/alert-rules             quality.alerts.manage over the rule's company (every company: over every
 *                                           company); the draft's problems in words (factory-domain alertRuleProblems)
 *   PATCH  /quality/alert-rules/:id         the same, at the version read
 *   DELETE /quality/alert-rules/:id         the same (the audit row keeps it)
 *   POST   /quality/alert-rules/starter     the design's rules of every company that are missing (a grant over every company)
 *   POST   /quality/alert-rules/:id/test    a firing to the person asking only (quality.alert_fired with testFor): their bell
 *
 * B-W2b-108 reads CAPA_ACTION_OVERDUE (its escalation); this file keeps those rules like the others.
 */

const RULES_PER_SCOPE = ALERT_LIMITS.rulesPerScope

async function rolesOf(db: Db) {
  return db.role.findMany({ where: { audience: 'OFFICE' }, orderBy: [{ system: 'desc' }, { name: 'asc' }], take: 200, select: { id: true, key: true, name: true } })
}

/** Firings of rules (the rule's audit trail): the last one and how many in 7 days (tests left out). */
async function firingsOf(db: Db, ruleIds: readonly string[], now: Date) {
  if (ruleIds.length === 0) return new Map<string, { last: Date | null; week: number }>()
  const rows = await db.auditLog.findMany({ where: { recordType: 'QualityAlertRule', recordId: { in: [...ruleIds] }, action: FIRED_ACTION, at: { gte: new Date(now.getTime() - 30 * 86_400_000) } }, select: { recordId: true, at: true }, orderBy: [{ at: 'desc' }], take: 5000 })
  const out = new Map<string, { last: Date | null; week: number }>()
  for (const row of rows) {
    const entry = out.get(row.recordId) ?? { last: null, week: 0 }
    if (!entry.last) entry.last = row.at
    if (row.at.getTime() >= now.getTime() - 7 * 86_400_000) entry.week += 1
    out.set(row.recordId, entry)
  }
  return out
}

type Place = { id: string; code: string; name: string }

async function viewsOf(db: Db, rows: readonly RuleRow[], all: readonly RuleRow[], askedCompany: string | null, now: Date): Promise<AlertRuleView[]> {
  const roles = new Map((await rolesOf(db)).map((role) => [role.id, role]))
  const companyIds = [...new Set(rows.map((row) => row.companyId).filter((id): id is string => !!id))]
  const companies = companyIds.length ? new Map((await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.legalName } as Place])) : new Map<string, Place>()
  const fired = await firingsOf(db, rows.map((row) => row.id), now)
  return rows.map((row) => {
    const role = row.roleId ? (roles.get(row.roleId) ?? null) : null
    const shape = { event: row.event, audience: row.audience, withinMinutes: row.withinMinutes, daysBefore: row.daysBefore, channels: row.channels }
    const firing = fired.get(row.id)
    return {
      id: row.id,
      companyId: row.companyId,
      company: row.companyId ? (companies.get(row.companyId) ?? null) : null,
      event: row.event,
      audience: row.audience,
      roleId: row.roleId,
      role: role ? { id: role.id, key: role.key, name: role.name } : null,
      withinMinutes: row.withinMinutes,
      daysBefore: [...row.daysBefore],
      channels: [...row.channels],
      enabled: row.enabled,
      inForce: askedCompany === null ? true : !shadowedFor(row, all, askedCompany),
      sentence: { it: alertRuleSentence(shape, role?.name ?? null, 'it'), en: alertRuleSentence(shape, role?.name ?? null, 'en') },
      lastFiredAt: firing?.last ? toUtcIso(firing.last) : null,
      fired7d: firing?.week ?? 0,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

const ORDER = (a: RuleRow, b: RuleRow) => QUALITY_ALERT_EVENTS.indexOf(a.event) - QUALITY_ALERT_EVENTS.indexOf(b.event) || (a.companyId === null ? 0 : 1) - (b.companyId === null ? 0 : 1) || a.createdAt.getTime() - b.createdAt.getTime()

/** Where the reader may keep rules: every company (a grant over every company) and each company of their manage grants. */
async function placesOf(db: Db, context: OfficeContext) {
  const actor = actorOf(context)
  const everywhere = mayWrite(actor, QUALITY_ALERTS_MANAGE, null)
  const grants = grantsFor(actor, QUALITY_ALERTS_MANAGE)
  const all = grants.some((grant) => grant.companies === 'all')
  const ids = all ? null : [...new Set(grants.flatMap((grant) => (grant.companies === 'all' ? [] : [...grant.companies])))]
  const companies = await db.company.findMany({ where: ids === null ? {} : { id: { in: ids } }, orderBy: [{ code: 'asc' }], take: 200, select: { id: true, code: true, legalName: true } })
  return { everywhere, companies: companies.filter((company) => mayWrite(actor, QUALITY_ALERTS_MANAGE, company.id)).map((company) => ({ id: company.id, code: company.code, name: company.legalName })) }
}

/** GET /quality/alert-rules */
export async function listAlertRules(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const companyId = query.companyId ?? null
  if (companyId !== null && (!isUuid(companyId) || !can(actor, QUALITY_RULES_VIEW, { companyId }))) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const now = new Date()
    const all = (await db.qualityAlertRule.findMany({ select: RULE_COLUMNS, take: 1000 })) as unknown as RuleRow[]
    // Every company's rules, and the rules of the companies the reader sees (one company asked: that one only).
    const shown = all.filter((row) => row.companyId === null || (companyId === null ? can(actor, QUALITY_RULES_VIEW, { companyId: row.companyId }) : row.companyId === companyId)).sort(ORDER)
    const places = await placesOf(db, context)
    return {
      companyId,
      rules: await viewsOf(db, shown, all, companyId, now),
      events: QUALITY_ALERT_EVENTS.map((event) => ({ event, timing: EVENT_FACTS[event].timing, ownerNamed: EVENT_FACTS[event].owner !== null })),
      roles: (await rolesOf(db)).map((role) => ({ id: role.id, key: role.key, name: role.name })),
      places,
      starterMissing: missingStarterRules(new Set(all.filter((row) => row.companyId === null).map((row) => row.event))).map((rule) => rule.event),
      mayManage: places.everywhere || places.companies.length > 0,
    }
  })
}

function assertMayManage(context: OfficeContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), QUALITY_ALERTS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The alert rules of every company are kept only by a role over every company.' : 'Keeping the alert rules of this company needs quality.alerts.manage for it.')
  }
}

function problemsOrThrow(draft: AlertRuleDraft): void {
  const issues = alertRuleProblems(draft)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
}

async function assertRole(caller: CommandCaller, roleId: string | null): Promise<void> {
  if (!roleId) return
  const role = await caller.withClient((db) => db.role.findUnique({ where: { id: roleId }, select: { audience: true } }))
  if (!role || role.audience !== 'OFFICE') throw new ValidationError('Choose an office role.', [{ path: 'body/roleId', message: 'An office role of this company group.' }])
}

async function readRule(caller: CommandCaller, ruleId: string): Promise<RuleRow> {
  const row = isUuid(ruleId) ? ((await caller.withClient((db) => db.qualityAlertRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))) as unknown as RuleRow | null) : null
  const context = officeOf(caller)
  if (!row || (row.companyId !== null && !can(actorOf(context), QUALITY_RULES_VIEW, { companyId: row.companyId }))) throw new NotFoundError('Alert rule not found.')
  return row
}

async function oneView(caller: CommandCaller, ruleId: string): Promise<AlertRuleView> {
  return caller.withClient(async (db) => {
    const all = (await db.qualityAlertRule.findMany({ select: RULE_COLUMNS, take: 1000 })) as unknown as RuleRow[]
    const row = all.find((entry) => entry.id === ruleId)!
    return (await viewsOf(db, [row], all, null, new Date()))[0]!
  })
}

export interface CreateAlertRuleBody {
  readonly companyId: string | null
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  readonly roleId: string | null
  readonly withinMinutes: number
  readonly daysBefore: readonly number[]
  readonly channels: readonly AlertChannel[]
  readonly enabled?: boolean | undefined
}

/** POST /quality/alert-rules */
export async function createAlertRule(caller: CommandCaller, body: CreateAlertRuleBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMayManage(context, body.companyId)
  if (body.companyId !== null) {
    const company = isUuid(body.companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: body.companyId! }, select: { id: true } })) : null
    if (!company) throw new ValidationError('Choose a company.', [{ path: 'body/companyId', message: 'Not a company you keep rules for.' }])
  }
  const draft: AlertRuleDraft = { event: body.event, audience: body.audience, roleId: body.roleId, withinMinutes: body.withinMinutes, daysBefore: sortedDays(body.daysBefore), channels: [...new Set(body.channels)] }
  problemsOrThrow({ ...draft, daysBefore: body.daysBefore })
  await assertRole(caller, body.roleId)
  const id = newId()
  await command(caller, { name: 'quality.alertRules.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One scope's rules at most RULES_PER_SCOPE (a list a person can read).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.quality-alert-rules|${context.tenantId}|${body.companyId ?? 'all'}`}, 0))`
    const count = await tx.qualityAlertRule.count({ where: { companyId: body.companyId } })
    if (count >= RULES_PER_SCOPE) throw new ConflictError(`A company keeps at most ${RULES_PER_SCOPE} alert rules: remove one first.`)
    await tx.qualityAlertRule.create({
      data: { id, companyId: body.companyId, event: body.event, audience: body.audience, roleId: body.roleId, withinMinutes: body.withinMinutes, daysBefore: [...draft.daysBefore], channels: [...draft.channels], enabled: body.enabled ?? true, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({ recordType: 'QualityAlertRule', recordId: id, companyId: body.companyId, after: { ...draft, companyId: body.companyId, enabled: body.enabled ?? true } })
    tools.emit({ type: 'quality.alert_rule_changed', subject: id, companyId: body.companyId, payload: { ruleIds: [id], companyId: body.companyId, events: [body.event], change: 'CREATED' } })
    return { id }
  })
  return { rule: await oneView(caller, id) }
}

export interface EditAlertRuleBody {
  readonly version: number
  readonly audience?: AlertAudience | undefined
  readonly roleId?: string | null | undefined
  readonly withinMinutes?: number | undefined
  readonly daysBefore?: readonly number[] | undefined
  readonly channels?: readonly AlertChannel[] | undefined
  readonly enabled?: boolean | undefined
}

/** PATCH /quality/alert-rules/:ruleId */
export async function editAlertRule(caller: CommandCaller, ruleId: string, body: EditAlertRuleBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const current = await readRule(caller, ruleId)
  assertMayManage(context, current.companyId)
  const audience = body.audience ?? current.audience
  // Telling the owner alone names no role: switching to OWNER drops the role unless one is sent.
  const roleId = body.roleId !== undefined ? body.roleId : audience === 'OWNER' ? null : current.roleId
  const draft: AlertRuleDraft = {
    event: current.event,
    audience,
    roleId,
    withinMinutes: body.withinMinutes ?? current.withinMinutes,
    daysBefore: body.daysBefore ?? current.daysBefore,
    channels: body.channels ? [...new Set(body.channels)] : current.channels,
  }
  problemsOrThrow(draft)
  if (body.roleId !== undefined) await assertRole(caller, body.roleId)
  await command(caller, { name: 'quality.alertRules.edit', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "QualityAlertRule" WHERE "id" = ${ruleId}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('Alert rule not found.')
    if (locked.version !== body.version) throw new StaleVersionError('QualityAlertRule', ruleId, locked.version, body.version)
    const data = { audience: draft.audience, roleId: draft.roleId, withinMinutes: draft.withinMinutes, daysBefore: sortedDays(draft.daysBefore), channels: [...draft.channels], enabled: body.enabled ?? current.enabled }
    await tx.qualityAlertRule.update({ where: { id: ruleId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({
      recordType: 'QualityAlertRule',
      recordId: ruleId,
      companyId: current.companyId,
      before: { audience: current.audience, roleId: current.roleId, withinMinutes: current.withinMinutes, daysBefore: current.daysBefore, channels: current.channels, enabled: current.enabled },
      after: data,
    })
    tools.emit({ type: 'quality.alert_rule_changed', subject: ruleId, companyId: current.companyId, payload: { ruleIds: [ruleId], companyId: current.companyId, events: [current.event], change: 'EDITED' } })
    return { id: ruleId }
  })
  return { rule: await oneView(caller, ruleId) }
}

/** DELETE /quality/alert-rules/:ruleId?version= */
export async function deleteAlertRule(caller: CommandCaller, ruleId: string, query: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const current = await readRule(caller, ruleId)
  assertMayManage(context, current.companyId)
  await command(caller, { name: 'quality.alertRules.delete', idempotencyKey, input: { ruleId, version: query.version } }, async (tools) => {
    const { tx } = tools
    const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "QualityAlertRule" WHERE "id" = ${ruleId}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('Alert rule not found.')
    if (locked.version !== query.version) throw new StaleVersionError('QualityAlertRule', ruleId, locked.version, query.version)
    await tx.qualityAlertRule.delete({ where: { id: ruleId }, select: { id: true } })
    tools.audit({ recordType: 'QualityAlertRule', recordId: ruleId, companyId: current.companyId, before: { event: current.event, audience: current.audience, roleId: current.roleId, withinMinutes: current.withinMinutes, daysBefore: current.daysBefore, channels: current.channels, enabled: current.enabled } })
    tools.emit({ type: 'quality.alert_rule_changed', subject: ruleId, companyId: current.companyId, payload: { ruleIds: [ruleId], companyId: current.companyId, events: [current.event], change: 'REMOVED' } })
    return { id: ruleId }
  })
  return { deleted: ruleId, event: current.event }
}

/** POST /quality/alert-rules/starter: the design's rules of every company that are missing, telling the system roles. */
export async function addStarterAlertRules(caller: CommandCaller, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMayManage(context, null)
  const { result } = await command(caller, { name: 'quality.alertRules.starter', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.quality-alert-rules|${context.tenantId}|all`}, 0))`
    const tenantWide = await tx.qualityAlertRule.findMany({ where: { companyId: null }, select: { event: true } })
    const missing = missingStarterRules(new Set(tenantWide.map((row) => row.event)))
    if (missing.length === 0) return { added: [] as QualityAlertEvent[], ruleIds: [] as string[] }
    const roles = await tx.role.findMany({ where: { system: true, audience: 'OFFICE', key: { in: missing.map((rule) => rule.roleKey).filter((key): key is string => !!key) } }, select: { id: true, key: true } })
    const added: QualityAlertEvent[] = []
    const ruleIds: string[] = []
    for (const rule of missing) {
      const roleId = rule.roleKey ? (roles.find((role) => role.key === rule.roleKey)?.id ?? null) : null
      // A system role missing (never in a synced tenant): tell the owner of the record alone where the event names one.
      const audience: AlertAudience = rule.roleKey && !roleId ? 'OWNER' : rule.audience
      if (audience === 'OWNER' && EVENT_FACTS[rule.event].owner === null) continue
      const id = newId()
      await tx.qualityAlertRule.create({
        data: { id, companyId: null, event: rule.event, audience, roleId: audience === 'OWNER' ? null : roleId, withinMinutes: rule.withinMinutes, daysBefore: [...rule.daysBefore], channels: [...rule.channels], enabled: true, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: { id: true },
      })
      tools.audit({ recordType: 'QualityAlertRule', recordId: id, companyId: null, after: { ...rule, roleId, audience, starter: true } })
      added.push(rule.event)
      ruleIds.push(id)
    }
    if (ruleIds.length > 0) tools.emit({ type: 'quality.alert_rule_changed', subject: ruleIds[0]!, companyId: null, payload: { ruleIds, companyId: null, events: added, change: 'STARTER_ADDED' } })
    return { added, ruleIds }
  })
  return result
}

/** POST /quality/alert-rules/:ruleId/test: one firing to the person asking (their bell), whatever the rule's audience. */
export async function testAlertRule(caller: CommandCaller, ruleId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  const current = await readRule(caller, ruleId)
  assertMayManage(context, current.companyId)
  if (!holds(actorOf(context), HOME_VIEW)) throw new ConflictError('A test reaches you through the bell of Home: you need home.view to see it.')
  const view = await oneView(caller, ruleId)
  await command(caller, { name: 'quality.alertRules.test', idempotencyKey, input: { ruleId } }, async (tools) => {
    tools.audit({ action: 'quality.alertTested', recordType: 'QualityAlertRule', recordId: ruleId, companyId: current.companyId, after: { event: current.event, testFor: context.actorId } })
    tools.emit({
      type: 'quality.alert_fired',
      subject: ruleId,
      companyId: current.companyId,
      payload: { ruleId, event: current.event, audience: current.audience, recordType: 'QualityAlertRule', recordId: ruleId, label: current.event.slice(0, 80), companyId: current.companyId, siteId: null, step: 0, date: null, testFor: context.actorId },
    })
    return { ruleId }
  })
  return { sent: true, sentence: view.sentence }
}
