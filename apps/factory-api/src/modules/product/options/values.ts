import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CreateValueBody, GroupView, StatusBody, UpdateValueBody } from '@nexus/factory-domain/product/options/contracts'
import { freeTextRuleProblems, type FreeTextRule } from '@nexus/factory-domain/product/options/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertMayManage, bumpValue, contextOf, groupViewInTx, invalid, lockGroupShared, namesOf, optionsGuarded, postgresReadsPattern, prefixed, readGroup, valueIn, type LockedGroup } from './store'

/**
 * A group's values (B-W2b-229; PRD-206, PRD-211; design products.options › Option group › Options: "autosave per cell"):
 *
 *   POST  /product/option-groups/:groupId/values                        a value at the end of the list (or at `seq`)
 *   PATCH /product/option-groups/:groupId/values/:valueId               its code, names, place and free-text rule, at the
 *                                                                       value's version
 *   POST  /product/option-groups/:groupId/values/:valueId/archive | restore   archived, never deleted (quotes and orders
 *                                                                       name it); kept while an active rule requires it
 *
 * product.options.manage over the group's company. Each write takes the group row FOR SHARE (its kind does not change under
 * it), then the value's version; one command with its audit row and option_group.changed (VALUES). The answer is the
 * group's record.
 */

const words = (value: Record<string, string> | null | undefined): Record<string, string> | null => (value && Object.keys(value).length > 0 ? value : null)

async function openGroup(tools: CommandTools, groupId: string): Promise<LockedGroup> {
  const group = await lockGroupShared(tools.tx, groupId)
  if (group.status === 'ARCHIVED') throw new InvalidStateError(`Option group ${group.code} is archived: restore it before changing its options.`)
  return group
}

/** The free-text rule against the group and, for a pattern, PostgreSQL's reading of it (the database's check). */
async function freeTextIssues(tx: CommandTx, group: LockedGroup, rule: FreeTextRule, patternChanged: boolean): Promise<Issue[]> {
  const issues = prefixed(freeTextRuleProblems(rule, group.kind))
  if (issues.length === 0 && patternChanged && rule.freeTextPattern !== null && !(await postgresReadsPattern(tx, rule.freeTextPattern))) {
    issues.push({ path: 'body/freeTextPattern', message: 'The database does not read this pattern as a regular expression: write it with plain characters, ranges and ^ $.' })
  }
  return issues
}

async function codeTaken(tx: CommandTx, groupId: string, code: string, except: string | null): Promise<Issue[]> {
  const other = await tx.optionValue.findFirst({ where: { groupId, code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })
  return other ? [{ path: 'body/code', message: `The group has an option ${code} already.` }] : []
}

/** POST /product/option-groups/:groupId/values */
export async function addValue(caller: CommandCaller, groupId: string, body: CreateValueBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const { result } = await optionsGuarded(
    () =>
      command(caller, { name: 'product.options.addValue', idempotencyKey, input: { groupId, ...body } }, async (tools) => {
        const { tx, now } = tools
        const group = await openGroup(tools, groupId)
        const freeText = body.freeText ?? group.kind === 'FREE_TEXT'
        const rule: FreeTextRule = { freeText, freeTextMaxLength: body.freeTextMaxLength ?? null, freeTextPattern: body.freeTextPattern ?? null }
        const issues = [...(await codeTaken(tx, groupId, body.code, null)), ...(await freeTextIssues(tx, group, rule, true))]
        if (issues.length > 0) throw invalid(issues, 'option')
        const last = await tx.optionValue.findFirst({ where: { groupId }, select: { seq: true }, orderBy: { seq: 'desc' } })
        const seq = body.seq ?? (last ? last.seq + 10 : 10)
        const id = newId()
        const fields = { code: body.code, name: body.name, nameI18n: words(body.nameI18n), seq, ...rule }
        const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
        await tx.optionValue.create({ data: { id, groupId, ...fields, nameI18n: fields.nameI18n ?? undefined, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
        tools.audit({ recordType: 'OptionValue', recordId: id, companyId: group.companyId, after: { groupId, ...fields } })
        tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'VALUES', valueIds: [id] } })
        return groupViewInTx(tx, groupId, tools.context)
      }),
    `The group has an option ${body.code} already.`,
  )
  return result
}

const FIELDS = ['code', 'name', 'nameI18n', 'seq', 'freeText', 'freeTextMaxLength', 'freeTextPattern'] as const
type Field = (typeof FIELDS)[number]
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** PATCH /product/option-groups/:groupId/values/:valueId */
export async function updateValue(caller: CommandCaller, groupId: string, valueId: string, body: UpdateValueBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.updateValue', idempotencyKey, input: { groupId, valueId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const group = await openGroup(tools, groupId)
      const row = await valueIn(tx, groupId, valueId)
      await bumpValue(tx, groupId, valueId, body.version, now)
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Option ${row.code} is archived: restore it before changing it.`)
      const before = { code: row.code, name: row.name, nameI18n: namesOf(row.nameI18n), seq: row.seq, freeText: row.freeText, freeTextMaxLength: row.freeTextMaxLength, freeTextPattern: row.freeTextPattern }
      const next: Record<Field, unknown> = { ...before }
      for (const field of FIELDS) if (body[field] !== undefined) next[field] = field === 'nameI18n' ? words(body.nameI18n) : body[field]
      // A value that no longer takes a text drops its length and pattern unless the person sends them.
      if (next.freeText === false && before.freeText) {
        if (body.freeTextMaxLength === undefined) next.freeTextMaxLength = null
        if (body.freeTextPattern === undefined) next.freeTextPattern = null
      }
      const changed = FIELDS.filter((field) => !same(next[field], before[field as keyof typeof before]))
      if (changed.length > 0) {
        const rule = { freeText: next.freeText as boolean, freeTextMaxLength: next.freeTextMaxLength as number | null, freeTextPattern: next.freeTextPattern as string | null }
        const issues = [...(changed.includes('code') ? await codeTaken(tx, groupId, next.code as string, valueId) : []), ...(await freeTextIssues(tx, group, rule, changed.includes('freeTextPattern')))]
        if (issues.length > 0) throw invalid(issues, 'option')
        if (changed.includes('nameI18n') && next.nameI18n === null) await tx.$executeRaw`UPDATE "OptionValue" SET "nameI18n" = NULL WHERE "id" = ${valueId}::uuid`
        const data = Object.fromEntries(changed.filter((field) => field !== 'nameI18n' || next.nameI18n !== null).map((field) => [field, next[field]])) as Prisma.OptionValueUncheckedUpdateInput
        await tx.optionValue.update({ where: { id: valueId }, data, select: { id: true } })
        tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'VALUES', valueIds: [valueId] } })
      }
      tools.audit({
        recordType: 'OptionValue',
        recordId: valueId,
        companyId: group.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field as keyof typeof before]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}

/** POST …/values/:valueId/archive | restore */
export async function moveValue(caller: CommandCaller, groupId: string, valueId: string, direction: 'archive' | 'restore', body: StatusBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const to = direction === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const { result } = await optionsGuarded(() =>
    command(caller, { name: direction === 'archive' ? 'product.options.archiveValue' : 'product.options.restoreValue', idempotencyKey, input: { groupId, valueId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const group = await openGroup(tools, groupId)
      const row = await valueIn(tx, groupId, valueId)
      await bumpValue(tx, groupId, valueId, body.version, now)
      if (row.status === to) throw new InvalidStateError(`Option ${row.code} is already ${to.toLowerCase()}.`)
      if (to === 'ARCHIVED') {
        // An active rule that requires it could never be met again: the person changes the rule first.
        const requiring = await tx.optionRule.findMany({ where: { otherValueId: valueId, kind: 'REQUIRES', status: 'ACTIVE' }, select: { groupId: true } })
        if (requiring.length > 0) {
          const codes = (await tx.optionGroup.findMany({ where: { id: { in: [...new Set(requiring.map((rule) => rule.groupId))] } }, select: { code: true } })).map((entry) => entry.code).sort()
          throw new InvalidStateError(`Option ${row.code} is required by ${requiring.length} active rule(s) of group(s) ${codes.join(', ')}: change or archive those rules first.`)
        }
      }
      await tx.optionValue.update({ where: { id: valueId }, data: { status: to }, select: { id: true } })
      tools.audit({ recordType: 'OptionValue', recordId: valueId, companyId: group.companyId, before: { status: row.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'VALUES', valueIds: [valueId] } })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}
