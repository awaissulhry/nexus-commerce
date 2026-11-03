import type { PlantLockBy, PlantSignSafeBy, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { lockSettingsRefusal, loosens, type LockBy, type LockSettings, type SignSafeBy } from '@nexus/factory-domain/plant/requests/lock'
import { orderRefusal, pickRule, ruleOrder, ruleProblems, ROUTING_LIMITS, routingWords, type RuleDraft } from '@nexus/factory-domain/plant/requests/routing'
import { PLANT_SETTINGS_MANAGE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, may, officeOf, problemsError, refused } from '../access'
import { lockSettingsOf } from './settings-read'

/**
 * A site's plant settings (B-W2b-96; QHS-179, QHS-183; design plant.settings "Request routing and escalation", "Unsafe
 * lock"; the screens are B-W2b-141's), office only:
 *
 *   GET  /plant/settings/routing?siteId                 the site's rules in their order, each with its worked example in
 *                                                       words and how many requests it routed (plant.view)
 *   GET  /plant/settings/routing/preview?siteId&…       where a request of a machine (or a class, with a symptom) would go
 *   POST /plant/settings/routing                        a rule (plant.settings.manage): a class or every class → a team of
 *                                                       the site or a technician (an employee of the company), push,
 *                                                       escalation after N minutes to a person and again after M (M > N)
 *   PATCH /plant/settings/routing/:ruleId               a change of it, or on / off
 *   POST /plant/settings/routing/:ruleId/remove         an unused rule is deleted; one a request names is switched off (it
 *                                                       stays, so the requests keep where they went)
 *   POST /plant/settings/routing/order                  the whole list in its new order (drag or keys)
 *   GET  /plant/settings/lock?siteId · PUT              the unsafe-lock settings (Owner answer H1 held: other choices are
 *                                                       refused in words; switching the hazard report off asks the
 *                                                       office's fresh code)
 *
 * Each write is one command: the site's rules locked (FOR UPDATE) first, the version, the rules, the change, its audit row
 * and plant_settings.changed. The team and the people are named while active.
 */

interface SiteRow {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
}

async function siteOf(caller: CommandCaller, siteId: string, permission: typeof PLANT_VIEW | typeof PLANT_SETTINGS_MANAGE): Promise<SiteRow> {
  const context = officeOf(caller)
  const site = isUuid(siteId) ? await caller.withClient((client) => client.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, code: true, name: true } })) : null
  if (!site) throw new NotFoundError('Site not found.')
  const scope = { companyId: site.companyId, siteId: site.id }
  assertMay(context, PLANT_VIEW, scope, 'Site')
  if (permission === PLANT_SETTINGS_MANAGE) assertMayWrite(context, PLANT_SETTINGS_MANAGE, scope, "A site's plant settings are kept by a role that does it (plant.settings.manage).")
  return site
}

const RULE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  seq: true,
  machineClassId: true,
  teamId: true,
  technicianId: true,
  push: true,
  escalateAfterMinutes: true,
  escalateToId: true,
  escalateAgainAfterMinutes: true,
  escalateAgainToId: true,
  active: true,
  version: true,
  updatedAt: true,
  machineClass: { select: { id: true, code: true, labelIt: true, labelEn: true } },
  team: { select: { id: true, code: true, name: true, status: true } },
  technician: { select: { id: true, displayName: true, status: true } },
  escalateTo: { select: { id: true, displayName: true, status: true } },
  escalateAgainTo: { select: { id: true, displayName: true, status: true } },
} as const satisfies Prisma.RequestRoutingRuleSelect
type RuleRow = Prisma.RequestRoutingRuleGetPayload<{ select: typeof RULE_COLUMNS }>
type Reader = Pick<CommandTx, 'requestRoutingRule' | 'maintenanceRequest'>

const personOf = (row: { id: string; displayName: string; status: string } | null) => (row ? { id: row.id, name: row.displayName, active: row.status === 'ACTIVE' } : null)

/** A rule as the settings screen shows it, with its worked example in words. */
function ruleView(row: RuleRow, site: SiteRow, used: number) {
  const target = row.team
    ? { kind: 'TEAM' as const, id: row.team.id, name: `${row.team.code} ${row.team.name}`, active: row.team.status === 'ACTIVE' }
    : { kind: 'TECHNICIAN' as const, id: row.technician!.id, name: row.technician!.displayName, active: row.technician!.status === 'ACTIVE' }
  const escalateTo = personOf(row.escalateTo)
  const escalateAgainTo = personOf(row.escalateAgainTo)
  return {
    id: row.id,
    siteId: row.siteId,
    seq: row.seq,
    machineClass: row.machineClass ? { id: row.machineClass.id, code: row.machineClass.code, labelIt: row.machineClass.labelIt, labelEn: row.machineClass.labelEn } : null,
    target,
    push: row.push,
    escalateAfterMinutes: row.escalateAfterMinutes,
    escalateTo,
    escalateAgainAfterMinutes: row.escalateAgainAfterMinutes,
    escalateAgainTo,
    active: row.active,
    requests: used,
    words: routingWords({
      symptom: null,
      machineClass: row.machineClass?.labelEn ?? 'machine of any class',
      site: site.code,
      target: target.name,
      escalate: row.escalateAfterMinutes !== null && escalateTo ? { minutes: row.escalateAfterMinutes, to: escalateTo.name } : null,
      again: row.escalateAgainAfterMinutes !== null && escalateAgainTo ? { minutes: row.escalateAgainAfterMinutes, to: escalateAgainTo.name } : null,
    }),
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

async function rulesOf(db: Reader, site: SiteRow) {
  const rows = ruleOrder(await db.requestRoutingRule.findMany({ where: { siteId: site.id }, select: RULE_COLUMNS }))
  const used = new Map<string, number>()
  if (rows.length > 0) {
    for (const row of await db.maintenanceRequest.groupBy({ by: ['routingRuleId'], where: { routingRuleId: { in: rows.map((rule) => rule.id) } }, _count: { _all: true } })) if (row.routingRuleId) used.set(row.routingRuleId, row._count._all)
  }
  return rows.map((row) => ruleView(row, site, used.get(row.id) ?? 0))
}

/** GET /plant/settings/routing. */
export async function listRouting(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  const site = await siteOf(caller, query.siteId, PLANT_VIEW)
  return caller.withClient(async (client) => ({ siteId: site.id, rules: await rulesOf(client, site), canManage: may(context, PLANT_SETTINGS_MANAGE, { companyId: site.companyId, siteId: site.id }) }))
}

/** GET /plant/settings/routing/preview: where a request would go now, in words. */
export async function previewRouting(caller: CommandCaller, query: { readonly siteId: string; readonly machineId?: string | undefined; readonly machineClassId?: string | undefined; readonly symptomId?: string | undefined }) {
  const site = await siteOf(caller, query.siteId, PLANT_VIEW)
  if (!query.machineId && !query.machineClassId) throw new ValidationError('Name a machine or a class of machine.', [{ path: 'query/machineClassId', message: 'Name a machine or a class of machine.' }])
  return caller.withClient(async (client) => {
    let classId = query.machineClassId ?? null
    if (query.machineId) {
      const machine = await client.machine.findFirst({ where: { id: query.machineId, siteId: site.id }, select: { classId: true } })
      if (!machine) throw new NotFoundError('No such machine at this site.')
      classId = machine.classId
    }
    const machineClass = await client.machineClass.findUnique({ where: { id: classId! }, select: { id: true, labelEn: true } })
    if (!machineClass) throw new NotFoundError('Machine class not found.')
    const symptom = query.symptomId ? await client.machineSymptom.findUnique({ where: { id: query.symptomId }, select: { labelEn: true } }) : null
    const rows = await client.requestRoutingRule.findMany({ where: { siteId: site.id }, select: RULE_COLUMNS })
    const rule = pickRule(rows, machineClass.id)
    const view = rule ? ruleView(rule, site, 0) : null
    return {
      rule: view ? { id: view.id, target: view.target, escalateAfterMinutes: view.escalateAfterMinutes, escalateTo: view.escalateTo, escalateAgainAfterMinutes: view.escalateAgainAfterMinutes, escalateAgainTo: view.escalateAgainTo } : null,
      words: routingWords({
        symptom: symptom?.labelEn ?? null,
        machineClass: machineClass.labelEn,
        site: site.code,
        target: view?.target.name ?? null,
        escalate: view && view.escalateAfterMinutes !== null && view.escalateTo ? { minutes: view.escalateAfterMinutes, to: view.escalateTo.name } : null,
        again: view && view.escalateAgainAfterMinutes !== null && view.escalateAgainTo ? { minutes: view.escalateAgainAfterMinutes, to: view.escalateAgainTo.name } : null,
      }),
    }
  })
}

export interface RuleBody {
  readonly machineClassId?: string | null | undefined
  readonly teamId?: string | null | undefined
  readonly technicianId?: string | null | undefined
  readonly push?: boolean | undefined
  readonly escalateAfterMinutes?: number | null | undefined
  readonly escalateToId?: string | null | undefined
  readonly escalateAgainAfterMinutes?: number | null | undefined
  readonly escalateAgainToId?: string | null | undefined
  readonly active?: boolean | undefined
  readonly seq?: number | undefined
}

/** The site's rules locked for the command (every routing write takes them: one lock order). */
async function lockRules(tx: CommandTx, siteId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "RequestRoutingRule" WHERE "siteId" = ${siteId}::uuid ORDER BY "id" FOR UPDATE`
}

/** The class, team and people a rule names, checked: the class active, the team the site's and active, people of the company and active. */
async function checkNamed(tx: CommandTx, site: SiteRow, rule: RuleBody, changed: ReadonlySet<string>): Promise<void> {
  if (changed.has('machineClassId') && rule.machineClassId) {
    const found = await tx.machineClass.findUnique({ where: { id: rule.machineClassId }, select: { active: true } })
    if (!found || !found.active) throw bodyIssue('machineClassId', 'Not an active machine class of the group.')
  }
  if (changed.has('teamId') && rule.teamId) {
    const found = await tx.team.findFirst({ where: { id: rule.teamId, siteId: site.id }, select: { status: true } })
    if (!found || found.status !== 'ACTIVE') throw bodyIssue('teamId', 'Not an active team of the site.')
  }
  for (const field of ['technicianId', 'escalateToId', 'escalateAgainToId'] as const) {
    const id = rule[field]
    if (!changed.has(field) || !id) continue
    const found = await tx.employee.findFirst({ where: { id, companyId: site.companyId }, select: { status: true } })
    if (!found || found.status !== 'ACTIVE') throw bodyIssue(field, "Not an active person of the site's company.")
  }
}

function emitChanged(tools: CommandTools, site: SiteRow, change: 'ADDED' | 'CHANGED' | 'REMOVED' | 'ORDERED', ruleId: string | null, part: 'ROUTING' | 'LOCK' = 'ROUTING'): void {
  tools.emit({ type: 'plant_settings.changed', subject: site.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, part, change, ruleId } })
}

const draftOf = (rule: RuleBody): RuleDraft => ({
  seq: rule.seq,
  teamId: rule.teamId,
  technicianId: rule.technicianId,
  escalateAfterMinutes: rule.escalateAfterMinutes,
  escalateToId: rule.escalateToId,
  escalateAgainAfterMinutes: rule.escalateAgainAfterMinutes,
  escalateAgainToId: rule.escalateAgainToId,
})

/** POST /plant/settings/routing. */
export async function addRule(caller: CommandCaller, body: RuleBody & { readonly siteId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const site = await siteOf(caller, body.siteId, PLANT_SETTINGS_MANAGE)
  const problems = ruleProblems(draftOf(body))
  if (problems.length > 0) throw problemsError(problems, 'The rule is not complete.')
  const { result, replayed } = await command(caller, { name: 'plant.addRoutingRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockRules(tx, site.id)
    const count = await tx.requestRoutingRule.count({ where: { siteId: site.id } })
    if (count >= ROUTING_LIMITS.rules) throw new ConflictError(`A site has at most ${ROUTING_LIMITS.rules} routing rules.`)
    await checkNamed(tx, site, body, new Set(['machineClassId', 'teamId', 'technicianId', 'escalateToId', 'escalateAgainToId']))
    const last = await tx.requestRoutingRule.aggregate({ where: { siteId: site.id }, _max: { seq: true } })
    const id = newId()
    const data: Prisma.RequestRoutingRuleUncheckedCreateInput = {
      id,
      companyId: site.companyId,
      siteId: site.id,
      seq: body.seq ?? (last._max.seq === null ? 0 : last._max.seq + 1),
      machineClassId: body.machineClassId ?? null,
      teamId: body.teamId ?? null,
      technicianId: body.technicianId ?? null,
      push: body.push ?? true,
      escalateAfterMinutes: body.escalateAfterMinutes ?? null,
      escalateToId: body.escalateToId ?? null,
      escalateAgainAfterMinutes: body.escalateAgainAfterMinutes ?? null,
      escalateAgainToId: body.escalateAgainToId ?? null,
      active: body.active ?? true,
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    await tx.requestRoutingRule.create({ data, select: { id: true } })
    const { id: _id, companyId: _company, siteId: _site, createdAt: _at, updatedAt: _up, createdById: _by, ...audited } = data
    tools.audit({ action: 'plant.addRoutingRule', recordType: 'RequestRoutingRule', recordId: id, companyId: site.companyId, siteId: site.id, after: audited })
    emitChanged(tools, site, 'ADDED', id)
    return { rules: await rulesOf(tx, site) }
  })
  return { ...result, replayed }
}

const RULE_FIELDS = ['machineClassId', 'teamId', 'technicianId', 'push', 'escalateAfterMinutes', 'escalateToId', 'escalateAgainAfterMinutes', 'escalateAgainToId', 'active', 'seq'] as const

async function knownRule(caller: CommandCaller, ruleId: string) {
  const known = isUuid(ruleId) ? await caller.withClient((client) => client.requestRoutingRule.findUnique({ where: { id: ruleId }, select: { id: true, siteId: true } })) : null
  if (!known) throw new NotFoundError('Routing rule not found.')
  return known
}

/** PATCH /plant/settings/routing/:ruleId. */
export async function changeRule(caller: CommandCaller, ruleId: string, body: RuleBody & { readonly version: number }, idempotencyKey?: string) {
  const known = await knownRule(caller, ruleId)
  const site = await siteOf(caller, known.siteId, PLANT_SETTINGS_MANAGE)
  const { result, replayed } = await command(caller, { name: 'plant.changeRoutingRule', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockRules(tx, site.id)
    const row = (await tx.requestRoutingRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))!
    assertVersion('rule', row.version, body.version)
    const changed = new Set<string>(RULE_FIELDS.filter((field) => body[field] !== undefined && body[field] !== row[field]))
    // Naming a team replaces a technician and the other way round (a rule has exactly one).
    const next: RuleBody = {
      ...row,
      ...Object.fromEntries([...changed].map((field) => [field, body[field as keyof RuleBody]])),
      ...(changed.has('teamId') && body.teamId ? { technicianId: null } : {}),
      ...(changed.has('technicianId') && body.technicianId ? { teamId: null } : {}),
    }
    const problems = ruleProblems(draftOf(next))
    if (problems.length > 0) throw problemsError(problems, 'The rule is not complete.')
    if (changed.size === 0) {
      tools.audit({ action: 'plant.changeRoutingRule', recordType: 'RequestRoutingRule', recordId: row.id, companyId: site.companyId, siteId: site.id, after: { unchanged: true } })
      return { rules: await rulesOf(tx, site) }
    }
    await checkNamed(tx, site, next, changed)
    const data: Prisma.RequestRoutingRuleUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const field of RULE_FIELDS) {
      const value = next[field] ?? (field === 'push' || field === 'active' ? row[field] : null)
      if (value === row[field]) continue
      ;(data as Record<string, unknown>)[field] = value
      before[field] = row[field]
      after[field] = value
    }
    await tx.requestRoutingRule.update({ where: { id: row.id }, data, select: { id: true } })
    tools.audit({ action: 'plant.changeRoutingRule', recordType: 'RequestRoutingRule', recordId: row.id, companyId: site.companyId, siteId: site.id, before, after })
    emitChanged(tools, site, 'CHANGED', row.id)
    return { rules: await rulesOf(tx, site) }
  })
  return { ...result, replayed }
}

/** POST /plant/settings/routing/:ruleId/remove: deleted when unused, else switched off. */
export async function removeRule(caller: CommandCaller, ruleId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const known = await knownRule(caller, ruleId)
  const site = await siteOf(caller, known.siteId, PLANT_SETTINGS_MANAGE)
  const { result, replayed } = await command(caller, { name: 'plant.removeRoutingRule', idempotencyKey, input: { ruleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await lockRules(tx, site.id)
    const row = (await tx.requestRoutingRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }))!
    assertVersion('rule', row.version, body.version)
    const used = await tx.maintenanceRequest.count({ where: { routingRuleId: row.id } })
    if (used === 0) await tx.requestRoutingRule.delete({ where: { id: row.id }, select: { id: true } })
    else if (row.active) await tx.requestRoutingRule.update({ where: { id: row.id }, data: { active: false, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const outcome: 'DELETED' | 'SWITCHED_OFF' = used === 0 ? 'DELETED' : 'SWITCHED_OFF'
    tools.audit({ action: 'plant.removeRoutingRule', recordType: 'RequestRoutingRule', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { active: row.active }, after: { outcome, requests: used } })
    emitChanged(tools, site, used === 0 ? 'REMOVED' : 'CHANGED', row.id)
    return { outcome, rules: await rulesOf(tx, site) }
  })
  return { ...result, replayed }
}

/** POST /plant/settings/routing/order: every rule of the site, in its new order (seq = its place). */
export async function orderRules(caller: CommandCaller, body: { readonly siteId: string; readonly rules: readonly { readonly id: string; readonly version: number }[] }, idempotencyKey?: string) {
  const site = await siteOf(caller, body.siteId, PLANT_SETTINGS_MANAGE)
  const { result, replayed } = await command(caller, { name: 'plant.orderRoutingRules', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockRules(tx, site.id)
    const rows = await tx.requestRoutingRule.findMany({ where: { siteId: site.id }, select: { id: true, seq: true, version: true } })
    const refusal = orderRefusal(rows.map((row) => row.id), body.rules.map((rule) => rule.id))
    if (refusal) refused(refusal)
    const before = ruleOrder(rows).map((row) => row.id)
    for (const [index, entry] of body.rules.entries()) {
      const row = rows.find((rule) => rule.id === entry.id)!
      assertVersion('rule', row.version, entry.version)
      if (row.seq !== index) await tx.requestRoutingRule.update({ where: { id: row.id }, data: { seq: index, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    }
    tools.audit({ action: 'plant.orderRoutingRules', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, before: { order: before }, after: { order: body.rules.map((rule) => rule.id) } })
    emitChanged(tools, site, 'ORDERED', null)
    return { rules: await rulesOf(tx, site) }
  })
  return { ...result, replayed }
}

// ---- the unsafe lock (QHS-183) -------------------------------------------------------------------------------------------

const lockView = (site: SiteRow, settings: LockSettings & { readonly version: number | null }, canManage: boolean) => ({
  siteId: site.id,
  lockBy: settings.lockBy,
  signSafeBy: settings.signSafeBy,
  hazardReportOnLock: settings.hazardReportOnLock,
  /** null: the site has no row yet (Owner answer H1's defaults); send null to make it. */
  version: settings.version,
  canManage,
})

/** GET /plant/settings/lock. */
export async function readLockSettings(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  const site = await siteOf(caller, query.siteId, PLANT_VIEW)
  return caller.withClient(async (client) => lockView(site, await lockSettingsOf(client, site.id), may(context, PLANT_SETTINGS_MANAGE, { companyId: site.companyId, siteId: site.id })))
}

export interface LockBody {
  readonly siteId: string
  readonly version: number | null
  readonly lockBy?: LockBy | undefined
  readonly signSafeBy?: SignSafeBy | undefined
  readonly hazardReportOnLock?: boolean | undefined
}

/**
 * PUT /plant/settings/lock: H1 held (other choices refused in words before anything); `stepUp` is asked when the change
 * loosens a safety rule (the hazard report switched off), after every other check.
 */
export async function setLockSettings(caller: CommandCaller, body: LockBody, stepUp: () => void | Promise<void>, idempotencyKey?: string) {
  const context = officeOf(caller)
  const site = await siteOf(caller, body.siteId, PLANT_SETTINGS_MANAGE)
  const current = await caller.withClient((client) => lockSettingsOf(client, site.id))
  const next: LockSettings = { lockBy: body.lockBy ?? current.lockBy, signSafeBy: body.signSafeBy ?? current.signSafeBy, hazardReportOnLock: body.hazardReportOnLock ?? current.hazardReportOnLock }
  const refusal = lockSettingsRefusal(next)
  if (refusal) refused(refusal)
  if (loosens(current, next)) await stepUp()
  const { result, replayed } = await command(caller, { name: 'plant.setLockSettings', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.plantSettings.findUnique({ where: { id: site.id }, select: { version: true, lockBy: true, signSafeBy: true, hazardReportOnLock: true } })
    if ((row?.version ?? null) !== body.version) throw new ConflictError(`The lock settings of this site changed since you read them (version ${row?.version ?? 'none'}, not ${body.version ?? 'none'}): read them again.`)
    const data = { lockBy: next.lockBy as PlantLockBy, signSafeBy: next.signSafeBy as PlantSignSafeBy, hazardReportOnLock: next.hazardReportOnLock }
    const unchanged = row !== null && row.lockBy === data.lockBy && row.signSafeBy === data.signSafeBy && row.hazardReportOnLock === data.hazardReportOnLock
    if (!unchanged) {
      if (row) await tx.plantSettings.update({ where: { id: site.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else await tx.plantSettings.create({ data: { id: site.id, companyId: site.companyId, siteId: site.id, ...data, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      emitChanged(tools, site, 'CHANGED', null, 'LOCK')
    }
    tools.audit({ action: 'plant.setLockSettings', recordType: 'PlantSettings', recordId: site.id, companyId: site.companyId, siteId: site.id, ...(row ? { before: { lockBy: row.lockBy, signSafeBy: row.signSafeBy, hazardReportOnLock: row.hazardReportOnLock } } : {}), after: unchanged ? { unchanged: true } : data })
    return lockView(site, { ...next, version: unchanged ? row!.version : (row?.version ?? 0) + 1 }, true)
  })
  return { ...result, replayed }
}
