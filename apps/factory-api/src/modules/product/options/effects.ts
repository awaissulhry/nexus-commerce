import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CreateEffectBody, GroupView, PriceBody, UpdateEffectBody } from '@nexus/factory-domain/product/options/contracts'
import { PRODUCT_OPTIONS_PRICE } from '@nexus/factory-domain/product/options/permissions'
import { effectProblems, OPTION_LIMITS, type EffectInput, type OptionEffectKind } from '@nexus/factory-domain/product/options/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import {
  assertMayManage,
  bumpValue,
  contextOf,
  EFFECT_COLUMNS,
  effectFactsOf,
  groupViewInTx,
  invalid,
  lockGroupShared,
  optionsGuarded,
  prefixed,
  readGroup,
  seesPrice,
  valueIn,
  type EffectRow,
  type LockedGroup,
  type ValueRow,
} from './store'

/**
 * What an option does (B-W2b-229; PRD-208, PRD-081; design products.options › Option group › Price & BOM effects, and the
 * Options grid's "Price surcharge (fixed or %)"):
 *
 *   POST   /product/option-groups/:groupId/values/:valueId/effects             a BOM line added, replaced or left out, an
 *                                                                              operation added, minutes, "outside the
 *                                                                              certificate"   (product.options.manage)
 *   PATCH  /product/option-groups/:groupId/values/:valueId/effects/:effectId   its fields (the kind stays)
 *   DELETE /product/option-groups/:groupId/values/:valueId/effects/:effectId?version=
 *   PUT    /product/option-groups/:groupId/values/:valueId/price               the value's price surcharge: an amount in a
 *                                                                              currency or a percent, or none
 *                                                                              (product.options.price + money.price)
 *
 * Every write sends the VALUE's version (its effects are its parts): the group row FOR SHARE, the value's version compared
 * and set, then the effect; the materials and the operation it names FOR SHARE. Each rule of the database's
 * OptionEffect_check is said first in words, and what it names is checked: a material put in ACTIVE and not BLOCKED, the
 * colour one of its ACTIVE colours, an ACTIVE operation, all of the group's company or tenant-wide (a tenant-wide group's:
 * tenant-wide). One value keeps one price surcharge. The audit rows mark the price with its grain.
 */

async function openValue(tools: CommandTools, groupId: string, valueId: string, version: number): Promise<{ group: LockedGroup; value: ValueRow }> {
  const { tx, now } = tools
  const group = await lockGroupShared(tx, groupId)
  if (group.status === 'ARCHIVED') throw new InvalidStateError(`Option group ${group.code} is archived: restore it before changing what its options do.`)
  const value = await valueIn(tx, groupId, valueId)
  await bumpValue(tx, groupId, valueId, version, now)
  if (value.status === 'ARCHIVED') throw new InvalidStateError(`Option ${value.code} is archived: restore it before changing what it does.`)
  return { group, value }
}

const fits = (rowCompany: string | null, groupCompany: string | null): boolean => rowCompany === null || rowCompany === groupCompany

/** What the effect newly names, against the database (locked FOR SHARE so it does not change under the write). */
async function namedProblems(tx: CommandTx, group: LockedGroup, effect: EffectInput, newly: ReadonlySet<keyof EffectInput>): Promise<Issue[]> {
  const issues: Issue[] = []
  const whose = group.companyId === null ? 'every company (the group is tenant-wide)' : "the group's company or every company"
  const itemIds = [effect.itemId, effect.targetItemId].filter((id): id is string => id !== null && isUuid(id)).sort()
  if (itemIds.length > 0) await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ANY(${itemIds}::uuid[]) ORDER BY "id" FOR SHARE`
  if (effect.itemId !== null && (newly.has('itemId') || newly.has('itemColourId'))) {
    const item = await tx.item.findUnique({ where: { id: effect.itemId }, select: { code: true, companyId: true, status: true, approval: true } })
    if (!item) issues.push({ path: 'body/itemId', message: 'No such material.' })
    else {
      if (newly.has('itemId') && item.status !== 'ACTIVE') issues.push({ path: 'body/itemId', message: `Material ${item.code} is archived.` })
      if (newly.has('itemId') && item.approval === 'BLOCKED') issues.push({ path: 'body/itemId', message: `Material ${item.code} is blocked: no option puts it in.` })
      if (newly.has('itemId') && !fits(item.companyId, group.companyId)) issues.push({ path: 'body/itemId', message: `Material ${item.code} is not of ${whose}.` })
      if (effect.itemColourId !== null) {
        const colour = await tx.itemColour.findFirst({ where: { id: effect.itemColourId, itemId: effect.itemId }, select: { code: true, status: true } })
        if (!colour) issues.push({ path: 'body/itemColourId', message: `Not a colour of ${item.code}.` })
        else if (newly.has('itemColourId') && colour.status !== 'ACTIVE') issues.push({ path: 'body/itemColourId', message: `Colour ${colour.code} of ${item.code} is archived.` })
      }
    }
  }
  if (effect.targetItemId !== null && newly.has('targetItemId')) {
    const target = await tx.item.findUnique({ where: { id: effect.targetItemId }, select: { code: true, companyId: true } })
    if (!target) issues.push({ path: 'body/targetItemId', message: 'No such material.' })
    else if (!fits(target.companyId, group.companyId)) issues.push({ path: 'body/targetItemId', message: `Material ${target.code} is not of ${whose}.` })
  }
  if (effect.operationId !== null && newly.has('operationId')) {
    const rows = await tx.$queryRaw<{ code: string; companyId: string | null; status: string }[]>`
      SELECT "code", "companyId"::text AS "companyId", "status"::text AS "status" FROM "Operation" WHERE "id" = ${effect.operationId}::uuid FOR SHARE`
    const operation = rows[0]
    if (!operation) issues.push({ path: 'body/operationId', message: 'No such operation.' })
    else if (operation.status !== 'ACTIVE') issues.push({ path: 'body/operationId', message: `Operation ${operation.code} is archived.` })
    else if (!fits(operation.companyId, group.companyId)) issues.push({ path: 'body/operationId', message: `Operation ${operation.code} is not of ${whose}.` })
  }
  return issues
}

const INPUT_FIELDS = ['itemId', 'itemColourId', 'targetItemId', 'qty', 'uom', 'sizeQuantities', 'section', 'operationId', 'minutes', 'note'] as const

const inputOf = (row: EffectRow): EffectInput & { kind: OptionEffectKind } => {
  const facts = effectFactsOf(row)
  return {
    kind: facts.kind,
    itemId: facts.itemId,
    itemColourId: facts.itemColourId,
    targetItemId: facts.targetItemId,
    qty: facts.qty,
    uom: facts.uom,
    sizeQuantities: facts.sizeQuantities,
    section: facts.section,
    operationId: facts.operationId,
    minutes: facts.minutes,
    priceDelta: facts.priceDelta,
    currency: facts.currency,
    pricePct: facts.pricePct,
    note: facts.note,
  }
}

const dataOf = (effect: EffectInput): Prisma.OptionEffectUncheckedUpdateInput => ({
  itemId: effect.itemId,
  itemColourId: effect.itemColourId,
  targetItemId: effect.targetItemId,
  qty: effect.qty,
  uom: effect.uom as Prisma.OptionEffectUncheckedUpdateInput['uom'],
  section: effect.section as Prisma.OptionEffectUncheckedUpdateInput['section'],
  operationId: effect.operationId,
  minutes: effect.minutes,
  priceDelta: effect.priceDelta,
  currency: effect.currency,
  pricePct: effect.pricePct,
  note: effect.note,
})

const audited = (effect: EffectInput & { kind: OptionEffectKind }): Record<string, unknown> => ({
  kind: effect.kind,
  itemId: effect.itemId,
  itemColourId: effect.itemColourId,
  targetItemId: effect.targetItemId,
  qty: effect.qty,
  uom: effect.uom,
  sizeQuantities: effect.sizeQuantities,
  section: effect.section,
  operationId: effect.operationId,
  minutes: effect.minutes,
  note: effect.note,
})

async function effectIn(tx: CommandTx, valueId: string, effectId: string): Promise<EffectRow> {
  const row = isUuid(effectId) ? await tx.optionEffect.findFirst({ where: { id: effectId, valueId }, select: EFFECT_COLUMNS }) : null
  if (!row) throw new NotFoundError('Option effect not found.')
  return row
}

const notPrice = (row: EffectRow): void => {
  if (row.kind === 'PRICE') throw new ConflictError("This is the option's price surcharge: change it with …/price (the price grain).")
}

/** POST …/values/:valueId/effects */
export async function addEffect(caller: CommandCaller, groupId: string, valueId: string, body: CreateEffectBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const effect: EffectInput & { kind: OptionEffectKind } = {
    kind: body.kind,
    itemId: body.itemId ?? null,
    itemColourId: body.itemColourId ?? null,
    targetItemId: body.targetItemId ?? null,
    qty: body.qty ?? null,
    uom: body.uom ?? null,
    sizeQuantities: body.sizeQuantities ?? null,
    section: body.section ?? null,
    operationId: body.operationId ?? null,
    minutes: body.minutes ?? null,
    priceDelta: null,
    currency: null,
    pricePct: null,
    note: body.note ?? null,
  }
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.addEffect', idempotencyKey, input: { groupId, valueId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const { group } = await openValue(tools, groupId, valueId, body.version)
      if ((await tx.optionEffect.count({ where: { valueId } })) >= OPTION_LIMITS.effects) throw new ConflictError(`An option has at most ${OPTION_LIMITS.effects} effects.`)
      const issues = prefixed(effectProblems(effect))
      if (issues.length === 0) issues.push(...(await namedProblems(tx, group, effect, new Set(INPUT_FIELDS))))
      if (issues.length > 0) throw invalid(issues, 'option effect')
      const id = newId()
      const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
      await tx.optionEffect.create({
        data: { id, valueId, kind: effect.kind, ...(dataOf(effect) as object), sizeQuantities: effect.sizeQuantities ?? undefined, createdAt: now, updatedAt: now, createdById } as Prisma.OptionEffectUncheckedCreateInput,
        select: { id: true },
      })
      tools.audit({ recordType: 'OptionEffect', recordId: id, companyId: group.companyId, after: { valueId, ...audited(effect) } })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'EFFECTS', valueIds: [valueId] } })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** PATCH …/values/:valueId/effects/:effectId */
export async function updateEffect(caller: CommandCaller, groupId: string, valueId: string, effectId: string, body: UpdateEffectBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.updateEffect', idempotencyKey, input: { groupId, valueId, effectId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const { group } = await openValue(tools, groupId, valueId, body.version)
      const row = await effectIn(tx, valueId, effectId)
      notPrice(row)
      const before = inputOf(row)
      const next = { ...before }
      for (const field of INPUT_FIELDS) if (body[field] !== undefined) (next as Record<string, unknown>)[field] = body[field] ?? null
      const changed = INPUT_FIELDS.filter((field) => !same(next[field], before[field]))
      if (changed.length > 0) {
        const issues = prefixed(effectProblems(next))
        if (issues.length === 0) issues.push(...(await namedProblems(tx, group, next, new Set(changed))))
        if (issues.length > 0) throw invalid(issues, 'option effect')
        if (changed.includes('sizeQuantities') && next.sizeQuantities === null) await tx.$executeRaw`UPDATE "OptionEffect" SET "sizeQuantities" = NULL WHERE "id" = ${effectId}::uuid`
        const data = dataOf(next)
        await tx.optionEffect.update({
          where: { id: effectId },
          data: { ...data, ...(next.sizeQuantities !== null ? { sizeQuantities: next.sizeQuantities } : {}), version: { increment: 1 }, updatedAt: now },
          select: { id: true },
        })
        tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'EFFECTS', valueIds: [valueId] } })
      }
      tools.audit({
        recordType: 'OptionEffect',
        recordId: effectId,
        companyId: group.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}

/** DELETE …/values/:valueId/effects/:effectId?version= */
export async function removeEffect(caller: CommandCaller, groupId: string, valueId: string, effectId: string, version: number, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId)
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.removeEffect', idempotencyKey, input: { groupId, valueId, effectId, version } }, async (tools) => {
      const { tx } = tools
      const { group } = await openValue(tools, groupId, valueId, version)
      const row = await effectIn(tx, valueId, effectId)
      notPrice(row)
      await tx.optionEffect.delete({ where: { id: effectId }, select: { id: true } })
      tools.audit({ recordType: 'OptionEffect', recordId: effectId, companyId: group.companyId, before: { valueId, ...audited(inputOf(row)) }, after: null })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'EFFECTS', valueIds: [valueId] } })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}

/** PUT …/values/:valueId/price: the value's one price surcharge (an amount in a currency, or a percent), or none. */
export async function setPrice(caller: CommandCaller, groupId: string, valueId: string, body: PriceBody, idempotencyKey?: string): Promise<GroupView> {
  const context = contextOf(caller)
  const seen = await readGroup(caller, groupId)
  assertMayManage(context, seen.companyId, PRODUCT_OPTIONS_PRICE)
  if (!seesPrice(context)) throw new ForbiddenError('A price surcharge is set only with the price grain (money.price).')
  const priceDelta = (body.priceDelta as string | undefined) ?? null
  const pricePct = (body.pricePct as string | undefined) ?? null
  const currency = body.currency ?? null
  const { result } = await optionsGuarded(() =>
    command(caller, { name: 'product.options.setPrice', idempotencyKey, input: { groupId, valueId, version: body.version, priceDelta: markMoney('price', priceDelta), currency, pricePct: markMoney('price', pricePct) } }, async (tools) => {
      const { tx, now } = tools
      const { group } = await openValue(tools, groupId, valueId, body.version)
      const rows = await tx.optionEffect.findMany({ where: { valueId, kind: 'PRICE' }, select: EFFECT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const was = rows[0] ? effectFactsOf(rows[0]) : null
      const none = priceDelta === null && pricePct === null
      if (none) {
        if (rows.length > 0) await tx.optionEffect.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } })
      } else {
        const effect: EffectInput & { kind: OptionEffectKind } = { kind: 'PRICE', itemId: null, itemColourId: null, targetItemId: null, qty: null, uom: null, sizeQuantities: null, section: null, operationId: null, minutes: null, priceDelta, currency, pricePct, note: null }
        const issues = prefixed(effectProblems(effect))
        if (issues.length > 0) throw invalid(issues, 'price surcharge')
        if (rows[0]) {
          await tx.optionEffect.update({ where: { id: rows[0].id }, data: { priceDelta, currency, pricePct, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
          if (rows.length > 1) await tx.optionEffect.deleteMany({ where: { id: { in: rows.slice(1).map((row) => row.id) } } })
        } else {
          const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
          await tx.optionEffect.create({ data: { id: newId(), valueId, kind: 'PRICE', priceDelta, currency, pricePct, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
        }
      }
      tools.audit({
        recordType: 'OptionValue',
        recordId: valueId,
        companyId: group.companyId,
        before: { priceDelta: markMoney('price', was?.priceDelta ?? null), currency: was?.currency ?? null, pricePct: markMoney('price', was?.pricePct ?? null) },
        after: { priceDelta: markMoney('price', priceDelta), currency, pricePct: markMoney('price', pricePct) },
      })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: group.companyId, payload: { optionGroupId: groupId, code: group.code, change: 'PRICES', valueIds: [valueId] } })
      return groupViewInTx(tx, groupId, tools.context)
    }),
  )
  return result
}
