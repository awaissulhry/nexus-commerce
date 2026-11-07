import { DOCUMENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { REQUIRED_DOCUMENTS_MANAGE } from '@nexus/factory-domain/files/required/permissions'
import { REQUIRED_CATEGORIES, REQUIRED_RECORD_TYPE_NAMES, REQUIRED_RECORD_TYPES, ruleDraftProblems, sameRuleKey, type RuleDraft } from '@nexus/factory-domain/files/required/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../files'
import { RULE_SELECT, type RuleRow } from './check'
import type { RuleView } from './contract'

/**
 * The company's required-document rules (COL-048; design admin.documents › Required documents: "Record type, document
 * type, required for (status), blocks the move (yes/no). Inline edit; feeds the record frame's GuardList."):
 *
 *   list     GET /files/required-rules?companyId= (documents.view per company): every rule, on and off, of the companies the
 *            person may see; what a rule may name (record types, statuses, documents); where the person may change them
 *   create   POST /files/required-rules (documents.required.manage on the company): one ACTIVE rule per record type, document,
 *            status and party role (the database's partial unique indexes hold it too); 409 in words for a second one
 *   change   PATCH /files/required-rules/:ruleId {level?, active?, version}: blocks or warns, switched off or on again (a rule
 *            is never deleted); switching one on again is refused while another active rule has its key
 *
 * Every write is one command with its audit row (before → after) and the version check.
 */

const viewOf = (row: RuleRow): RuleView => ({
  id: row.id,
  companyId: row.companyId,
  recordType: row.recordType,
  category: row.category as RuleView['category'],
  beforeStatus: row.beforeStatus,
  partyRole: row.partyRole,
  level: row.level,
  active: row.active,
  version: row.version,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
})

const audited = (row: RuleRow) => ({ recordType: row.recordType, category: row.category, beforeStatus: row.beforeStatus, partyRole: row.partyRole, level: row.level, active: row.active })

const mayOn = (caller: CommandCaller, permission: typeof DOCUMENTS_VIEW | typeof REQUIRED_DOCUMENTS_MANAGE, companyId: string): boolean =>
  can(actorOf(contextOf(caller)), permission, { companyId })

const DUPLICATE = 'An active rule already asks for this document before this status: change that rule instead.'

export async function listRules(caller: CommandCaller, companyId: string | undefined) {
  const rows = await caller.withClient((client) =>
    client.requiredDocumentRule.findMany({
      where: companyId ? { companyId } : {},
      select: RULE_SELECT,
      orderBy: [{ recordType: 'asc' }, { beforeStatus: 'asc' }, { category: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 1000,
    }),
  )
  const seen = rows.filter((row) => mayOn(caller, DOCUMENTS_VIEW, row.companyId))
  const companies = await caller.withClient((client) => client.company.findMany({ select: { id: true }, orderBy: { id: 'asc' }, take: 200 }))
  return {
    rules: seen.map(viewOf),
    recordTypes: REQUIRED_RECORD_TYPE_NAMES.map((recordType) => ({ recordType, statuses: [...REQUIRED_RECORD_TYPES[recordType].statuses] })),
    categories: [...REQUIRED_CATEGORIES],
    mayChange: companies.map((company) => company.id).filter((id) => mayOn(caller, REQUIRED_DOCUMENTS_MANAGE, id)),
  }
}

export async function createRule(caller: CommandCaller, body: RuleDraft & { readonly companyId: string }, idempotencyKey?: string): Promise<RuleView> {
  const problems = ruleDraftProblems(body)
  if (problems.length > 0) throw new ValidationError('The rule is not valid.', problems)
  if (!mayOn(caller, REQUIRED_DOCUMENTS_MANAGE, body.companyId)) throw new ForbiddenError()
  const { result } = await command(caller, { name: 'documents.createRequiredRule', idempotencyKey, input: body }, async ({ tx, now, context, audit }) => {
    if (!(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const active = await tx.requiredDocumentRule.findMany({ where: { companyId: body.companyId, recordType: body.recordType, active: true }, select: RULE_SELECT })
    if (active.some((row) => sameRuleKey(row, body))) throw new ConflictError(DUPLICATE)
    const id = newId()
    const row = await tx.requiredDocumentRule.create({
      data: {
        id,
        companyId: body.companyId,
        recordType: body.recordType,
        category: body.category as RuleRow['category'],
        beforeStatus: body.beforeStatus,
        partyRole: body.partyRole as RuleRow['partyRole'],
        level: body.level as RuleRow['level'],
        createdAt: now,
        updatedAt: now,
        createdById: context.audience === 'office' ? context.actorId : null,
      },
      select: RULE_SELECT,
    })
    audit({ recordType: 'RequiredDocumentRule', recordId: id, companyId: body.companyId, after: audited(row) })
    return viewOf(row)
  })
  return result
}

export async function changeRule(caller: CommandCaller, ruleId: string, body: { readonly level?: 'BLOCK' | 'WARN' | undefined; readonly active?: boolean | undefined; readonly version: number }, idempotencyKey?: string): Promise<RuleView> {
  const before = await caller.withClient((client) => client.requiredDocumentRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT }))
  if (!before || !mayOn(caller, DOCUMENTS_VIEW, before.companyId)) throw new NotFoundError('Rule not found.')
  if (!mayOn(caller, REQUIRED_DOCUMENTS_MANAGE, before.companyId)) throw new ForbiddenError()
  if (body.level === undefined && body.active === undefined) throw new ValidationError('Say what changes: blocks or warns, on or off.', [{ path: 'body', message: 'Nothing to change.' }])
  const { result } = await command(
    caller,
    { name: 'documents.changeRequiredRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'RequiredDocumentRule', id: ruleId, expectedVersion: body.version } },
    async ({ tx, now, audit }) => {
      const row = await tx.requiredDocumentRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_SELECT })
      if (body.active === true && !row.active) {
        const active = await tx.requiredDocumentRule.findMany({ where: { companyId: row.companyId, recordType: row.recordType, active: true }, select: RULE_SELECT })
        if (active.some((other) => other.id !== row.id && sameRuleKey(other, row))) throw new ConflictError(DUPLICATE)
      }
      const after = await tx.requiredDocumentRule.update({
        where: { id: ruleId },
        data: { ...(body.level !== undefined ? { level: body.level } : {}), ...(body.active !== undefined ? { active: body.active } : {}), updatedAt: now },
        select: RULE_SELECT,
      })
      audit({ recordType: 'RequiredDocumentRule', recordId: ruleId, companyId: row.companyId, before: audited(row), after: audited(after) })
      return viewOf(after)
    },
  )
  return result
}
