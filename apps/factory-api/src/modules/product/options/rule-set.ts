import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { GroupView, RulesBody } from '@nexus/factory-domain/product/options/contracts'
import { rulesProblems, subjectOfDraft, type PlannedRule } from '@nexus/factory-domain/product/options/rules'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayManage, contextOf, GROUP_COLUMNS, groupViewInTx, invalid, lockValuesShared, namesOf, optionsGuarded, readGroup, RULE_COLUMNS, valueNames } from './store'

/**
 * A group's rules as a set (B-W2b-229; PRD-207; design products.options › Option group › Rules: "explicit: EditModeBar"):
 *
 *   PUT /product/option-groups/:groupId/rules   {version (the group's), rules: [{id?, when, kind, otherValueId, severity,
 *                                               message?, status?}]}   product.options.manage over the group's company
 *
 * Each rule's subject is the design system's RuleBuilder draft (one row: field `option`, operator `eq`, the value id or `*`
 * for any option of the group); a rule left out is removed, one with its id changed in place, one without an id added. The
 * group row FOR UPDATE (command()'s record guard, its version +1), then every value the rules name FOR SHARE; every rule of
 * the database's OptionRule_check said first in words (plus no rule twice, no subject both requiring and excluding the same
 * option). One audit row on the group, option_group.changed (RULES).
 */

const words = (value: Record<string, string> | null | undefined): Record<string, string> | null => (value && Object.keys(value).length > 0 ? value : null)
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

export async function setRules(caller: CommandCaller, groupId: string, body: RulesBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  // The subjects as the RuleBuilder drafts name them, said first (no database read needed).
  const issues: Issue[] = []
  const planned: PlannedRule[] = body.rules.map((rule, index) => {
    const subject = subjectOfDraft(rule.when)
    let valueId: string | null = null
    if (!subject.ok) issues.push({ path: `body/rules/${index}/${subject.issue.path}`, message: subject.issue.message })
    else if (subject.valueId !== null && !isUuid(subject.valueId)) issues.push({ path: `body/rules/${index}/when/rows/0/value`, message: 'Pick an option of the group, or any option of it (*).' })
    else valueId = subject.valueId
    return { id: rule.id ?? null, valueId, kind: rule.kind, otherValueId: rule.otherValueId, severity: rule.severity }
  })
  if (issues.length > 0) throw invalid(issues, 'rule set')

  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.setRules', idempotencyKey, input: { groupId, ...body }, record: { type: 'OptionGroup', id: groupId, expectedVersion: body.version } }, async (tools) => {
      const { tx, now } = tools
      const group = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: GROUP_COLUMNS })
      if (group.status === 'ARCHIVED') throw new InvalidStateError(`Option group ${group.code} is archived: restore it before changing its rules.`)
      const existing = await tx.optionRule.findMany({ where: { groupId }, select: RULE_COLUMNS })
      const named = [...planned.flatMap((rule) => [rule.valueId, rule.otherValueId].filter((id): id is string => id !== null))]
      await lockValuesShared(tx, named)
      const values = await valueNames(tx, named)
      const before = new Map(existing.map((rule) => [rule.id, { valueId: rule.valueId, otherValueId: rule.otherValueId }]))
      const problems = rulesProblems({ id: groupId, companyId: group.companyId }, planned, (id) => values.get(id), before).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
      if (problems.length > 0) throw invalid(problems, 'rule set')

      const keep = new Set(planned.flatMap((rule) => (rule.id ? [rule.id] : [])))
      const removed = existing.filter((rule) => !keep.has(rule.id))
      if (removed.length > 0) await tx.optionRule.deleteMany({ where: { id: { in: removed.map((rule) => rule.id) }, groupId } })
      const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
      const added: string[] = []
      const changed: string[] = []
      for (const [index, rule] of planned.entries()) {
        const input = body.rules[index]!
        const was = rule.id === null ? undefined : existing.find((entry) => entry.id === rule.id)
        // Left out: a saved rule keeps its message and status (a client that does not send them loses nothing); null clears the message.
        const messageI18n = input.message === undefined ? (was ? namesOf(was.messageI18n) : null) : words(input.message as Record<string, string> | null)
        const fields = { valueId: rule.valueId, kind: rule.kind, otherValueId: rule.otherValueId, severity: rule.severity, messageI18n, status: input.status ?? was?.status ?? 'ACTIVE' }
        if (rule.id === null) {
          const id = newId()
          await tx.optionRule.create({ data: { id, groupId, ...fields, messageI18n: fields.messageI18n ?? undefined, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
          added.push(id)
          continue
        }
        const old = { valueId: was!.valueId, kind: was!.kind, otherValueId: was!.otherValueId, severity: was!.severity, messageI18n: namesOf(was!.messageI18n), status: was!.status }
        if (same(old, fields)) continue
        if (fields.messageI18n === null && old.messageI18n !== null) await tx.$executeRaw`UPDATE "OptionRule" SET "messageI18n" = NULL WHERE "id" = ${rule.id}::uuid`
        const data: Prisma.OptionRuleUncheckedUpdateInput = { valueId: fields.valueId, kind: fields.kind, otherValueId: fields.otherValueId, severity: fields.severity, status: fields.status, version: { increment: 1 }, updatedAt: now }
        if (fields.messageI18n !== null) data.messageI18n = fields.messageI18n
        await tx.optionRule.update({ where: { id: rule.id }, data, select: { id: true } })
        changed.push(rule.id)
      }
      tools.audit({
        recordType: 'OptionGroup',
        recordId: groupId,
        companyId: group.companyId,
        before: { rules: existing.map((rule) => ({ id: rule.id, valueId: rule.valueId, kind: rule.kind, otherValueId: rule.otherValueId, severity: rule.severity, status: rule.status })) },
        after: { rules: { added, changed, removed: removed.map((rule) => rule.id), count: planned.length } },
      })
      if (added.length > 0 || changed.length > 0 || removed.length > 0) {
        tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'RULES', valueIds: [] } })
      }
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}
