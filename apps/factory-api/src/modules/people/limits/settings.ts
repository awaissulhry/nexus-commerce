import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { PEOPLE_LIMITS_MANAGE } from '@nexus/factory-domain/people/limits/permissions'
import { LAW_VALUES, RULE_KINDS, ruleProblems, type RuleAction, type RuleKind, type RuleSource } from '@nexus/factory-domain/people/limits/rules'
import { PEOPLE_SHIFTS_VIEW } from '@nexus/factory-domain/people/shifts/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertVersion, officeOf, refuse } from '../employees/access'
import type { Client } from '../attendance/store'
import type { ListLimitsQuery, SaveLimitBody } from './contract'

/**
 * People settings › Working-time limits (B-W2b-42; MES-232; design people.settings "Working-time limits"): the value, warn
 * or block, who is alerted and the law or CCNL article, per limit, for the group (no company), a company or one site; the
 * most specific ACTIVE one is in force, else the law's value warns. Settings, not a person's data: no legal gate. The
 * roster's, attendance's or this permission reads; people.limits.manage writes (a group limit: a role over every company).
 * One write is one command with the version read (none yet: version null makes the row).
 *
 *   GET  /people/limits                  the six limits in force at a company or a site, and the row kept at that scope
 *   PUT  /people/limits                  sets one limit at a scope
 *   POST /people/limits/:ruleId/archive  back to the wider limit, else the law's
 */

const RULE_SELECT = { id: true, companyId: true, siteId: true, kind: true, limitMinutes: true, breakMinutes: true, referenceMonths: true, action: true, alertRoles: true, source: true, legalReference: true, status: true, version: true } as const satisfies Prisma.WorkingTimeRuleSelect
type RuleRow = Prisma.WorkingTimeRuleGetPayload<{ select: typeof RULE_SELECT }>

const READERS = [PEOPLE_LIMITS_MANAGE, PEOPLE_ATTENDANCE_VIEW, PEOPLE_SHIFTS_VIEW] as const

const WRITE_WORDS = 'The working-time limits are kept by a role with people.limits.manage.'
const GROUP_WORDS = 'A limit of the whole group is kept by a role over every company: set it for one company instead.'

const view = (row: RuleRow) => ({
  id: row.id,
  companyId: row.companyId,
  siteId: row.siteId,
  kind: row.kind as RuleKind,
  limitMinutes: row.limitMinutes,
  breakMinutes: row.breakMinutes,
  referenceMonths: row.referenceMonths,
  action: row.action as RuleAction,
  alertRoles: row.alertRoles,
  source: row.source as RuleSource,
  legalReference: row.legalReference,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
  version: row.version,
})

interface Scope {
  readonly companyId: string | null
  readonly siteId: string | null
}

function mayKeep(context: OfficeContext, scope: Scope): boolean {
  const actor = actorOf(context)
  if (scope.companyId) return can(actor, PEOPLE_LIMITS_MANAGE, { companyId: scope.companyId, ...(scope.siteId ? { siteId: scope.siteId } : {}) })
  return grantsFor(actor, PEOPLE_LIMITS_MANAGE).some((grant) => grant.companies === 'all')
}

/** The site named belongs to the company named (404 out of reach or not found). */
async function scopeOf(db: Client, query: { readonly companyId?: string | null | undefined; readonly siteId?: string | null | undefined }): Promise<Scope> {
  const siteId = query.siteId ?? null
  if (!siteId) return { companyId: query.companyId ?? null, siteId: null }
  const site = isUuid(siteId) ? await db.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }) : null
  if (!site || (query.companyId && query.companyId !== site.companyId)) throw new NotFoundError('Site not found.')
  return { companyId: site.companyId, siteId: site.id }
}

/** GET /people/limits: the limits in force at a place, with the law's value and the row of that very scope. */
export async function listLimits(caller: CommandCaller, query: ListLimitsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const scope = await scopeOf(db, query)
    const actor = actorOf(context)
    const place = { ...(scope.companyId ? { companyId: scope.companyId } : {}), ...(scope.siteId ? { siteId: scope.siteId } : {}) }
    if (!READERS.some((permission) => can(actor, permission, place))) throw new NotFoundError('Not found.')
    const rows = await db.workingTimeRule.findMany({ where: { status: 'ACTIVE', OR: [{ companyId: null, siteId: null }, ...(scope.companyId ? [{ companyId: scope.companyId, siteId: null }] : []), ...(scope.siteId ? [{ siteId: scope.siteId }] : [])] }, select: RULE_SELECT })
    const rank = (row: RuleRow) => (row.siteId ? 0 : row.companyId ? 1 : 2)
    const limits = RULE_KINDS.map((kind) => {
      const ofKind = rows.filter((row) => row.kind === kind).sort((a, b) => rank(a) - rank(b))
      const own = ofKind.find((row) => row.companyId === scope.companyId && row.siteId === scope.siteId) ?? null
      const law = LAW_VALUES[kind]
      return { kind, inForce: ofKind[0] ? view(ofKind[0]) : null, own: own ? view(own) : null, law: { limitMinutes: law.limitMinutes, breakMinutes: law.breakMinutes, referenceMonths: law.referenceMonths, legalReference: law.legalReference, words: law.words } }
    })
    const roles = await db.role.findMany({ where: { audience: 'OFFICE' }, select: { key: true, name: true }, orderBy: [{ key: 'asc' }] })
    return { companyId: scope.companyId, siteId: scope.siteId, limits, roles, canManage: mayKeep(context, scope) }
  })
}

/** PUT /people/limits: one limit at a scope (the row kept there, or a new one with version null). */
export async function saveLimit(caller: CommandCaller, body: SaveLimitBody, key?: string) {
  const context = officeOf(caller)
  const values = { kind: body.kind, limitMinutes: body.limitMinutes, breakMinutes: body.breakMinutes ?? null, referenceMonths: body.referenceMonths ?? null, action: body.action, alertRoles: body.alertRoles, source: body.source, legalReference: body.legalReference.trim() }
  const problems = ruleProblems(values)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  const scope = await caller.withClient((db) => scopeOf(db, body))
  if (!mayKeep(context, scope)) throw new ForbiddenError(scope.companyId ? WRITE_WORDS : GROUP_WORDS)
  const { result } = await command(caller, { name: 'people.saveWorkingTimeLimit', idempotencyKey: key, input: body }, async (tools) => {
    const { tx } = tools
    const known = await tx.role.findMany({ where: { audience: 'OFFICE', key: { in: values.alertRoles } }, select: { key: true } })
    if (known.length !== values.alertRoles.length) throw new ValidationError('A role named is not one of the office roles.', [{ path: 'body/alertRoles', message: 'Name the office roles by their key.' }])
    const existing = await tx.workingTimeRule.findFirst({ where: { companyId: scope.companyId, siteId: scope.siteId, kind: body.kind, status: 'ACTIVE' }, select: RULE_SELECT })
    if (existing === null && body.version !== null) throw new ConflictError('This limit changed since you read it: read it again.')
    if (existing && body.version === null) throw new ConflictError('This limit was set meanwhile: read it again.')
    if (existing) assertVersion('limit', existing.version, body.version!)
    const { kind, ...columns } = values
    const id = existing?.id ?? newId()
    const row = existing
      ? await tx.workingTimeRule.update({ where: { id }, data: { ...columns, version: { increment: 1 } }, select: RULE_SELECT })
      : await tx.workingTimeRule.create({ data: { id, ...scope, kind, ...columns, createdById: context.actorId }, select: RULE_SELECT })
    tools.audit({ recordType: 'WorkingTimeRule', recordId: id, ...(scope.companyId ? { companyId: scope.companyId } : {}), ...(scope.siteId ? { siteId: scope.siteId } : {}), ...(existing ? { before: view(existing) } : {}), after: view(row) })
    tools.emit({ type: 'working_time_rule.changed', subject: id, ...(scope.companyId ? { companyId: scope.companyId } : {}), ...(scope.siteId ? { siteId: scope.siteId } : {}), payload: { ruleId: id, companyId: scope.companyId, siteId: scope.siteId, kind, change: 'SET' } })
    return view(row)
  })
  return result
}

/** POST /people/limits/:ruleId/archive: this scope's limit goes; the wider one, else the law's, is in force. */
export async function archiveLimit(caller: CommandCaller, ruleId: string, body: { readonly version: number }, key?: string) {
  const context = officeOf(caller)
  const found = isUuid(ruleId) ? await caller.withClient((db) => db.workingTimeRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT })) : null
  if (!found) throw new NotFoundError('Limit not found.')
  if (!mayKeep(context, found)) throw new ForbiddenError(found.companyId ? WRITE_WORDS : GROUP_WORDS)
  const { result } = await command(caller, { name: 'people.archiveWorkingTimeLimit', idempotencyKey: key, input: { ruleId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = (await tx.workingTimeRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT }))!
    assertVersion('limit', row.version, body.version)
    if (row.status !== 'ACTIVE') refuse('ALREADY_ARCHIVED', 'This limit is archived already.')
    const after = await tx.workingTimeRule.update({ where: { id: ruleId }, data: { status: 'ARCHIVED', version: { increment: 1 } }, select: RULE_SELECT })
    const place = { ...(row.companyId ? { companyId: row.companyId } : {}), ...(row.siteId ? { siteId: row.siteId } : {}) }
    tools.audit({ recordType: 'WorkingTimeRule', recordId: ruleId, ...place, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'working_time_rule.changed', subject: ruleId, ...place, payload: { ruleId, companyId: row.companyId, siteId: row.siteId, kind: row.kind as RuleKind, change: 'ARCHIVED' } })
    return view(after)
  })
  return result
}
