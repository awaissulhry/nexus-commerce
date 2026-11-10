import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { CreateGroupBody, GroupListView, GroupView, ListGroupsQuery, StatusBody, UpdateGroupBody } from '@nexus/factory-domain/product/options/contracts'
import { defaultPicks, groupPicksProblems, kindChangeProblem, offerPicksProblems, type OptionGroupKind, type Picks } from '@nexus/factory-domain/product/options/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayManage, contextOf, countsOf, GROUP_COLUMNS, GROUP_SCOPE, groupRowViewOf, groupViewInTx, groupViewOf, invalid, namesOf, optionsGuarded, prefixed, readGroup } from './store'

/**
 * Option groups (B-W2b-229; PRD-206; design products.options: the grid, New option group, the record's header):
 *
 *   GET   /product/option-groups[?status&companyId&kind&q&outsideCertificate]   product.styles.view: every group the caller
 *                                                    may see with its counts, and the tiles' counts (all; with a value
 *                                                    outside the certificate)
 *   GET   /product/option-groups/:groupId            product.styles.view: the record (values, rules, effects, styles)
 *   POST  /product/option-groups                     product.options.manage over its company (tenant-wide: every company)
 *   PATCH /product/option-groups/:groupId            the same, at the group's version
 *   POST  /product/option-groups/:groupId/archive | restore   the same: archived, never deleted (styles, quotes and orders
 *                                                    name its values); an archived group is offered anew by no style
 *
 * Every rule of the database's OptionGroup_check is said here first, in words; each write is ONE command with its audit row
 * and option_group.changed.
 */

const words = (value: Record<string, string> | null | undefined): Record<string, string> | null => (value && Object.keys(value).length > 0 ? value : null)

/** GET /product/option-groups */
export async function listGroups(caller: CommandCaller, query: ListGroupsQuery): Promise<GroupListView> {
  const context = contextOf(caller)
  const contains = (text: string) => ({ contains: text, mode: 'insensitive' as const })
  const base: Prisma.OptionGroupWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, GROUP_SCOPE) as Prisma.OptionGroupWhereInput,
      query.status === 'ALL' ? {} : { status: query.status },
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
      query.kind ? { kind: query.kind } : {},
      query.q ? { OR: [{ code: contains(query.q) }, { name: contains(query.q) }, { values: { some: { OR: [{ code: contains(query.q) }, { name: contains(query.q) }] } } }] } : {},
    ],
  }
  const outside: Prisma.OptionGroupWhereInput = { values: { some: { status: 'ACTIVE', effects: { some: { kind: 'CERTIFICATE' } } } } }
  const where: Prisma.OptionGroupWhereInput = query.outsideCertificate === undefined ? base : { AND: [base, query.outsideCertificate ? outside : { NOT: outside }] }
  return caller.withClient(async (client) => {
    const rows = await client.optionGroup.findMany({ where, select: GROUP_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const counts = await countsOf(
      client,
      rows.map((row) => row.id),
    )
    return {
      groups: rows.map((row) => groupRowViewOf(row, counts.get(row.id)!)),
      counts: { all: await client.optionGroup.count({ where: base }), outsideCertificate: await client.optionGroup.count({ where: { AND: [base, outside] } }) },
    }
  })
}

/** GET /product/option-groups/:groupId */
export async function getGroup(caller: CommandCaller, groupId: string): Promise<GroupView> {
  const row = await readGroup(caller, groupId)
  return caller.withClient((client) => groupViewOf(client, row, contextOf(caller)))
}

async function codeTaken(tx: CommandTx, code: string, except: string | null): Promise<Issue[]> {
  const other = await tx.optionGroup.findFirst({ where: { code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })
  return other ? [{ path: 'body/code', message: `The option group code ${code} is taken.` }] : []
}

/** The ACTIVE offers that would contradict the group's new picks or kind, in words. */
async function offerProblems(tx: CommandTx, groupId: string, kind: OptionGroupKind, picks: Picks): Promise<Issue[]> {
  const offers = await tx.styleOptionGroup.findMany({ where: { groupId, status: 'ACTIVE' }, select: { styleId: true, minPicks: true, maxPicks: true } })
  if (offers.length === 0) return []
  const codes = new Map((await tx.style.findMany({ where: { id: { in: offers.map((offer) => offer.styleId) } }, select: { id: true, code: true } })).map((style) => [style.id, style.code]))
  const clashing = offers.filter((offer) => offerPicksProblems(kind, picks, offer).length > 0).map((offer) => codes.get(offer.styleId) ?? '?')
  return clashing.length === 0 ? [] : [{ path: 'body/maxPicks', message: `Style(s) ${clashing.sort().join(', ')} ask other picks of the group: change their own minimum and maximum first.` }]
}

/** POST /product/option-groups */
export async function createGroup(caller: CommandCaller, body: CreateGroupBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayManage(context, companyId)
  const picks = defaultPicks(body.kind)
  const draft = { minPicks: body.minPicks ?? picks.minPicks, maxPicks: body.maxPicks === undefined ? picks.maxPicks : body.maxPicks }
  const { result } = await optionsGuarded(
    () =>
      command(caller, { name: 'product.options.createGroup', idempotencyKey, input: body }, async (tools) => {
        const { tx, now } = tools
        const issues: Issue[] = []
        if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) issues.push({ path: 'body/companyId', message: 'No such company.' })
        issues.push(...(await codeTaken(tx, body.code, null)), ...prefixed(groupPicksProblems(body.kind, draft)))
        if (issues.length > 0) throw invalid(issues)
        const id = newId()
        const fields = { code: body.code, name: body.name, nameI18n: words(body.nameI18n), description: body.description ?? null, kind: body.kind, ...draft }
        const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
        await tx.optionGroup.create({ data: { id, companyId, ...fields, nameI18n: fields.nameI18n ?? undefined, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
        tools.audit({ action: 'product.options.createGroup', recordType: 'OptionGroup', recordId: id, companyId, after: { companyId, ...fields } })
        tools.emit({ type: 'option_group.changed', subject: id, companyId, payload: { optionGroupId: id, code: body.code, change: 'CREATED', valueIds: [] } })
        return groupViewInTx(tx, id, tools.context)
      }),
    `The option group code ${body.code} is taken.`,
  )
  return result
}

const FIELDS = ['code', 'name', 'nameI18n', 'description', 'kind', 'minPicks', 'maxPicks'] as const
type Field = (typeof FIELDS)[number]
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** PATCH /product/option-groups/:groupId */
export async function updateGroup(caller: CommandCaller, groupId: string, body: UpdateGroupBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const sent = (row: typeof seen, field: Field): unknown => (field === 'nameI18n' ? words(body.nameI18n) : body[field]) ?? (field === 'nameI18n' || field === 'description' || field === 'maxPicks' ? null : row[field])
  const asked = (field: Field) => body[field] !== undefined
  // The same values again change nothing: no command, no version bump.
  if (FIELDS.every((field) => !asked(field) || same(sent(seen, field), field === 'nameI18n' ? namesOf(seen.nameI18n) : seen[field]))) return getGroup(caller, groupId)
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.updateGroup', idempotencyKey, input: { groupId, ...body }, record: { type: 'OptionGroup', id: groupId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const row = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: GROUP_COLUMNS })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Option group ${row.code} is archived: restore it before changing it.`)
      const before = { code: row.code, name: row.name, nameI18n: namesOf(row.nameI18n), description: row.description, kind: row.kind, minPicks: row.minPicks, maxPicks: row.maxPicks }
      const next = { ...before }
      for (const field of FIELDS) if (asked(field)) (next as Record<Field, unknown>)[field] = sent(row, field)
      // A group made single-choice takes at most 1 unless the person says otherwise.
      if (next.kind === 'SINGLE' && before.kind !== 'SINGLE' && !asked('maxPicks')) next.maxPicks = 1
      const changed = FIELDS.filter((field) => !same(next[field], before[field]))
      if (changed.length === 0) {
        tools.audit({ recordType: 'OptionGroup', recordId: groupId, companyId: row.companyId, before: {}, after: {} })
        return groupViewOf(tx, row, tools.context)
      }
      const issues: Issue[] = [...prefixed(groupPicksProblems(next.kind, next))]
      if (changed.includes('code')) issues.push(...(await codeTaken(tx, next.code, groupId)))
      if (changed.includes('kind')) {
        const valuesWithoutText = next.kind === 'FREE_TEXT' ? await tx.optionValue.count({ where: { groupId, freeText: false } }) : 0
        const asking = next.kind === 'SINGLE' ? await tx.styleOptionGroup.findMany({ where: { groupId, status: 'ACTIVE', OR: [{ maxPicks: { gt: 1 } }, { minPicks: { gt: 1 } }] }, select: { styleId: true } }) : []
        const codes = asking.length === 0 ? [] : (await tx.style.findMany({ where: { id: { in: asking.map((offer) => offer.styleId) } }, select: { code: true } })).map((style) => style.code).sort()
        const problem = kindChangeProblem(next.kind, { valuesWithoutText, offersAskingMore: codes })
        if (problem) issues.push({ path: 'body/kind', message: problem })
      }
      if (issues.length === 0 && (changed.includes('kind') || changed.includes('minPicks') || changed.includes('maxPicks'))) issues.push(...(await offerProblems(tx, groupId, next.kind, next)))
      if (issues.length > 0) throw invalid(issues)
      const data = Object.fromEntries(changed.filter((field) => field !== 'nameI18n' || next.nameI18n !== null).map((field) => [field, next[field]])) as Prisma.OptionGroupUncheckedUpdateInput
      if (changed.includes('nameI18n') && next.nameI18n === null) await tx.$executeRaw`UPDATE "OptionGroup" SET "nameI18n" = NULL WHERE "id" = ${groupId}::uuid`
      await tx.optionGroup.update({ where: { id: groupId }, data: { ...data, updatedAt: tools.now }, select: { id: true } })
      tools.audit({
        recordType: 'OptionGroup',
        recordId: groupId,
        companyId: row.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: row.companyId, payload: { optionGroupId: groupId, code: next.code, change: 'UPDATED', valueIds: [] } })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}

/** POST /product/option-groups/:groupId/archive | restore: out of new use (the styles that offer it keep their offers), and back. */
export async function moveGroup(caller: CommandCaller, groupId: string, direction: 'archive' | 'restore', body: StatusBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const to = direction === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const { result } = await optionsGuarded(() =>
    command(
      caller,
      { name: direction === 'archive' ? 'product.options.archiveGroup' : 'product.options.restoreGroup', idempotencyKey, input: { groupId, ...body }, record: { type: 'OptionGroup', id: groupId, expectedVersion: body.version } },
      async (tools) => {
        const { tx } = tools
        const row = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: GROUP_COLUMNS })
        if (row.status === to) throw new InvalidStateError(`Option group ${row.code} is already ${to.toLowerCase()}.`)
        await tx.optionGroup.update({ where: { id: groupId }, data: { status: to, updatedAt: tools.now }, select: { id: true } })
        tools.audit({ recordType: 'OptionGroup', recordId: groupId, companyId: row.companyId, before: { status: row.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
        tools.emit({ type: 'option_group.changed', subject: groupId, companyId: row.companyId, payload: { optionGroupId: groupId, code: row.code, change: direction === 'archive' ? 'ARCHIVED' : 'RESTORED', valueIds: [] } })
        return groupViewInTx(tx, groupId, tools.context)
      },
    ),
  )
  return result
}
