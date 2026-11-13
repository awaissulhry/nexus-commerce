import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { EffectView, GroupRowView, GroupView, RuleView, ValueView } from '@nexus/factory-domain/product/options/contracts'
import { PRODUCT_OPTIONS_MANAGE, PRODUCT_OPTIONS_PRICE } from '@nexus/factory-domain/product/options/permissions'
import {
  ANY_OPTION,
  brokenWords,
  effectivePicks,
  effectWords,
  nameIn,
  picksWords,
  ruleDraftOf,
  ruleWords,
  type EffectFacts,
  type NameFacts,
  type OptionEffectKind,
  type RuleFacts,
  type ValueNameFacts,
} from '@nexus/factory-domain/product/options/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../materials/store'

/**
 * The option library's rows (B-W2b-229; factory-db options.prisma: OptionGroup, OptionValue, OptionRule, OptionEffect,
 * StyleOptionGroup), the columns every read names, how they become the contracts' views, who may see and write a group, the
 * locks the writes take and the last net under a database refusal. Every read names its columns and selects no relation
 * (inside a command's transaction Prisma would send them at once on its one connection).
 *
 * Lock order, so two writes never wait on each other in a circle:
 *   a group's own fields, archive and rules   the group row FOR UPDATE (command()'s record guard), then the values its rules
 *                                             name FOR SHARE (id order)
 *   a value, its effects and its price        the group row FOR SHARE, then the value's version compared and set
 *   a style's offer                           the style row FOR UPDATE (W1's lockStyle), the group FOR SHARE, the default
 *                                             value FOR SHARE, then the offer
 *   a draft BOM line's option                 W1's lockDraft (the style, the revision), then the value FOR SHARE
 */

export { contextOf }

export type Db = FactoryClient | CommandTx

export const GROUP_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

export const GROUP_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  description: true,
  kind: true,
  minPicks: true,
  maxPicks: true,
  // B-W2b-374 (XF3:05): what a chosen value takes with it.
  takes: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.OptionGroupSelect
export type GroupRow = Prisma.OptionGroupGetPayload<{ select: typeof GROUP_COLUMNS }>

export const VALUE_COLUMNS = {
  id: true,
  groupId: true,
  code: true,
  name: true,
  nameI18n: true,
  seq: true,
  freeText: true,
  freeTextMaxLength: true,
  freeTextPattern: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.OptionValueSelect
export type ValueRow = Prisma.OptionValueGetPayload<{ select: typeof VALUE_COLUMNS }>

export const RULE_COLUMNS = { id: true, groupId: true, valueId: true, kind: true, otherValueId: true, severity: true, messageI18n: true, status: true, version: true } as const satisfies Prisma.OptionRuleSelect
export type RuleRow = Prisma.OptionRuleGetPayload<{ select: typeof RULE_COLUMNS }>

export const EFFECT_COLUMNS = {
  id: true,
  valueId: true,
  kind: true,
  itemId: true,
  itemColourId: true,
  targetItemId: true,
  qty: true,
  uom: true,
  sizeQuantities: true,
  section: true,
  operationId: true,
  minutes: true,
  priceDelta: true,
  currency: true,
  pricePct: true,
  note: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.OptionEffectSelect
export type EffectRow = Prisma.OptionEffectGetPayload<{ select: typeof EFFECT_COLUMNS }>

export const OFFER_COLUMNS = { id: true, styleId: true, groupId: true, seq: true, minPicks: true, maxPicks: true, defaultValueId: true, status: true, version: true, updatedAt: true } as const satisfies Prisma.StyleOptionGroupSelect
export type OfferRow = Prisma.StyleOptionGroupGetPayload<{ select: typeof OFFER_COLUMNS }>

type Names = Readonly<Record<string, string>> | null
export const namesOf = (value: Prisma.JsonValue | null): Names => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : null)
const textOf = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

/** An effect row as the domain reads it (decimals as plain strings). */
export const effectFactsOf = (row: EffectRow): EffectFacts => ({
  id: row.id,
  valueId: row.valueId,
  kind: row.kind as OptionEffectKind,
  itemId: row.itemId,
  itemColourId: row.itemColourId,
  targetItemId: row.targetItemId,
  qty: textOf(row.qty),
  uom: row.uom,
  sizeQuantities: namesOf(row.sizeQuantities),
  section: row.section,
  operationId: row.operationId,
  minutes: textOf(row.minutes),
  priceDelta: textOf(row.priceDelta),
  currency: row.currency,
  pricePct: textOf(row.pricePct),
  note: row.note,
})

export const ruleFactsOf = (row: RuleRow): RuleFacts => ({
  id: row.id,
  groupId: row.groupId,
  valueId: row.valueId,
  kind: row.kind,
  otherValueId: row.otherValueId,
  severity: row.severity,
  messageI18n: namesOf(row.messageI18n),
})

// ---- who may see and write ------------------------------------------------------------------------------------------------

/** The caller holds the price grain (money.price): price surcharges are read and set. */
export const seesPrice = (context: RequestContext): boolean => heldGrains(actorOf(context)).has('price')

export function assertMayManage(context: RequestContext, companyId: string | null, permission: typeof PRODUCT_OPTIONS_MANAGE | typeof PRODUCT_OPTIONS_PRICE = PRODUCT_OPTIONS_MANAGE): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? 'An option group for every company is changed only by a role over every company.' : undefined)
  }
}

/** The group as the caller may see it (product.styles.view over its company); else not found. */
export async function readGroup(caller: CommandCaller, groupId: string): Promise<GroupRow> {
  const context = contextOf(caller)
  if (!isUuid(groupId)) throw new NotFoundError('Option group not found.')
  const row = await caller.withClient((client) => client.optionGroup.findUnique({ where: { id: groupId }, select: GROUP_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Option group not found.')
  return row
}

// ---- locks and versions ---------------------------------------------------------------------------------------------------

export interface LockedGroup {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly kind: GroupRow['kind']
  readonly status: GroupRow['status']
}

/** The group row FOR SHARE (a value, its effects or its price change: the group's kind does not change under them). */
export async function lockGroupShared(tx: CommandTx, groupId: string): Promise<LockedGroup> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "id"::text AS "id", "code", "companyId"::text AS "companyId", "kind"::text AS "kind", "status"::text AS "status"
      FROM "OptionGroup" WHERE "id" = ${groupId}::uuid FOR SHARE`
  const row = rows[0]
  if (!row) throw new NotFoundError('Option group not found.')
  return row
}

/** Values FOR SHARE, in id order (a rule or an offer names them: they are not archived under it). */
export async function lockValuesShared(tx: CommandTx, valueIds: readonly string[]): Promise<void> {
  const ids = [...new Set(valueIds)].sort()
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT "id" FROM "OptionValue" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`
}

/** Compare-and-set of a value's version, after its group's lock: a stale version is a 409; a value of another group 404. */
export async function bumpValue(tx: CommandTx, groupId: string, valueId: string, expected: number, now: Date): Promise<number> {
  const { count } = await tx.optionValue.updateMany({ where: { id: valueId, groupId, version: expected }, data: { version: expected + 1, updatedAt: now } })
  if (count === 1) return expected + 1
  const current = await tx.optionValue.findFirst({ where: { id: valueId, groupId }, select: { version: true } })
  if (!current) throw new NotFoundError('Option value not found.')
  throw new StaleVersionError('OptionValue', valueId, current.version, expected)
}

/** PostgreSQL reads the pattern as the database will (the …_bom_options_w2b_guards helper). */
export async function postgresReadsPattern(tx: CommandTx, pattern: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`SELECT "factory_bom_options_regex_ok"(${pattern}::text) AS "ok"`
  return rows[0]?.ok === true
}

/**
 * The last net: a refusal of the …_bom_options_w2b_guards triggers that the checks before did not foresee (a race) is a 409
 * in its words, never a 500; a code or an active offer taken meanwhile likewise.
 */
export async function optionsGuarded<T>(work: () => Promise<T>, taken = 'This code is taken.'): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const known = error as { code?: unknown; meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null
    const cause = known?.meta?.driverAdapterError?.cause
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('product: ')) {
      const words = cause.originalMessage.slice('product: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the options again.`)
    }
    if (known?.code === 'P2002' || cause?.originalCode === '23505') throw new ConflictError(taken)
    throw error
  }
}

export const invalid = (issues: readonly Issue[], what = 'option group'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))

// ---- views ----------------------------------------------------------------------------------------------------------------

export interface RowCounts {
  readonly values: number
  readonly styles: number
  readonly rules: number
  readonly outsideCertificate: number
}

/** The list's counts of many groups at once: active values, active offers, active rules, active values outside the certificate. */
export async function countsOf(db: Db, groupIds: readonly string[]): Promise<Map<string, RowCounts>> {
  const counts = new Map<string, { values: number; styles: number; rules: number; outsideCertificate: number }>(groupIds.map((id) => [id, { values: 0, styles: 0, rules: 0, outsideCertificate: 0 }]))
  if (groupIds.length === 0) return counts
  const ids = [...groupIds]
  const active = await db.optionValue.findMany({ where: { groupId: { in: ids }, status: 'ACTIVE' }, select: { id: true, groupId: true } })
  for (const value of active) counts.get(value.groupId)!.values++
  for (const row of await db.styleOptionGroup.groupBy({ by: ['groupId'], where: { groupId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })) counts.get(row.groupId)!.styles = row._count._all
  for (const row of await db.optionRule.groupBy({ by: ['groupId'], where: { groupId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })) counts.get(row.groupId)!.rules = row._count._all
  const groupOfValue = new Map(active.map((value) => [value.id, value.groupId]))
  const outside = active.length === 0 ? [] : await db.optionEffect.findMany({ where: { kind: 'CERTIFICATE', valueId: { in: active.map((value) => value.id) } }, select: { valueId: true } })
  for (const valueId of new Set(outside.map((row) => row.valueId))) counts.get(groupOfValue.get(valueId)!)!.outsideCertificate++
  return counts
}

export function groupRowViewOf(row: GroupRow, counts: RowCounts): GroupRowView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameI18n: namesOf(row.nameI18n),
    description: row.description,
    companyId: row.companyId,
    kind: row.kind,
    minPicks: row.minPicks,
    maxPicks: row.maxPicks,
    picks: { ...picksWords(row) },
    values: counts.values,
    styles: counts.styles,
    rules: counts.rules,
    outsideCertificate: counts.outsideCertificate,
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** Values (with their groups) by id, as a rule's words name them. */
export async function valueNames(db: Db, valueIds: readonly string[]): Promise<Map<string, ValueNameFacts & { readonly status: ValueRow['status']; readonly companyId: string | null }>> {
  const ids = [...new Set(valueIds)]
  if (ids.length === 0) return new Map()
  const values = await db.optionValue.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, nameI18n: true, groupId: true, status: true } })
  const groups = new Map(
    (await db.optionGroup.findMany({ where: { id: { in: [...new Set(values.map((value) => value.groupId))] } }, select: { id: true, code: true, name: true, nameI18n: true, companyId: true } })).map((group) => [group.id, group]),
  )
  return new Map(
    values.map((value) => {
      const group = groups.get(value.groupId)
      return [
        value.id,
        {
          id: value.id,
          code: value.code,
          name: value.name,
          nameI18n: namesOf(value.nameI18n),
          groupId: value.groupId,
          group: { code: group?.code ?? '?', name: group?.name ?? '?', nameI18n: namesOf(group?.nameI18n ?? null) },
          status: value.status,
          companyId: group?.companyId ?? null,
        },
      ]
    }),
  )
}

export function ruleViewOf(row: RuleRow, names: ReadonlyMap<string, ValueNameFacts & { readonly status: ValueRow['status'] }>, groupOf: (groupId: string) => (NameFacts & { readonly code: string }) | undefined): RuleView {
  const facts = ruleFactsOf(row)
  const other = names.get(row.otherValueId)
  return {
    id: row.id,
    valueId: row.valueId,
    when: ruleDraftOf(row.valueId) as RuleView['when'],
    kind: row.kind,
    otherValueId: row.otherValueId,
    other: {
      id: row.otherValueId,
      code: other?.code ?? '?',
      name: other?.name ?? '?',
      nameI18n: other?.nameI18n ?? null,
      groupId: other?.groupId ?? row.otherValueId,
      groupCode: other?.group.code ?? '?',
      groupName: other?.group.name ?? '?',
      status: other?.status ?? 'ARCHIVED',
    },
    severity: row.severity,
    messageI18n: namesOf(row.messageI18n),
    words: { ...ruleWords(facts, (id) => names.get(id), groupOf) },
    broken: { ...brokenWords(facts, (id) => names.get(id), groupOf) },
    status: row.status,
    version: row.version,
  }
}

type Ref = { id: string; code: string; name: string }

export interface EffectRefs {
  readonly items: ReadonlyMap<string, Ref>
  readonly operations: ReadonlyMap<string, Ref>
}

export async function effectRefsOf(db: Db, rows: readonly Pick<EffectRow, 'itemId' | 'targetItemId' | 'operationId'>[]): Promise<EffectRefs> {
  const itemIds = [...new Set(rows.flatMap((row) => [row.itemId, row.targetItemId].filter((id): id is string => id !== null)))]
  const operationIds = [...new Set(rows.flatMap((row) => (row.operationId ? [row.operationId] : [])))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })
  const operations = operationIds.length === 0 ? [] : await db.operation.findMany({ where: { id: { in: operationIds } }, select: { id: true, code: true, name: true } })
  return { items: new Map(items.map((row) => [row.id, row])), operations: new Map(operations.map((row) => [row.id, row])) }
}

export function effectViewOf(row: EffectRow, refs: EffectRefs, price: boolean): EffectView {
  const facts = effectFactsOf(row)
  const item = row.itemId ? (refs.items.get(row.itemId) ?? null) : null
  const target = row.targetItemId ? (refs.items.get(row.targetItemId) ?? null) : null
  const operation = row.operationId ? (refs.operations.get(row.operationId) ?? null) : null
  return {
    id: row.id,
    valueId: row.valueId,
    kind: row.kind,
    item: item ? { ...item } : null,
    itemColourId: row.itemColourId,
    targetItem: target ? { ...target } : null,
    qty: facts.qty,
    uom: row.uom,
    sizeQuantities: facts.sizeQuantities ? { ...facts.sizeQuantities } : null,
    section: row.section,
    operation: operation ? { ...operation } : null,
    minutes: facts.minutes,
    ...(price ? { priceDelta: asMoney('price', facts.priceDelta), pricePct: asMoney('price', facts.pricePct) } : {}),
    currency: row.currency,
    note: row.note,
    words: { ...effectWords(facts, { item: item?.code ?? null, target: target?.code ?? null, operation: operation?.code ?? null }) },
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The values of the groups, each group's in its order. */
export const readValues = (db: Db, groupIds: readonly string[]): Promise<ValueRow[]> =>
  db.optionValue.findMany({ where: { groupId: { in: [...groupIds] } }, select: VALUE_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }, { id: 'asc' }] })

export const readEffects = (db: Db, valueIds: readonly string[]): Promise<EffectRow[]> =>
  valueIds.length === 0 ? Promise.resolve([]) : db.optionEffect.findMany({ where: { valueId: { in: [...valueIds] } }, select: EFFECT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

/** How many BOM lines and routing steps (any style, any revision) are only for each value. */
async function usageOf(db: Db, valueIds: readonly string[]): Promise<Map<string, { lines: number; steps: number }>> {
  const usage = new Map(valueIds.map((id) => [id, { lines: 0, steps: 0 }]))
  if (valueIds.length === 0) return usage
  for (const row of await db.bomLine.groupBy({ by: ['optionValueId'], where: { optionValueId: { in: [...valueIds] } }, _count: { _all: true } })) {
    if (row.optionValueId) usage.get(row.optionValueId)!.lines = row._count._all
  }
  for (const step of await db.routingOperation.findMany({ where: { appliesToOptionValueIds: { hasSome: [...valueIds] } }, select: { appliesToOptionValueIds: true } })) {
    for (const id of step.appliesToOptionValueIds) {
      const entry = usage.get(id)
      if (entry) entry.steps++
    }
  }
  return usage
}

/** One group's record: its values, rules, effects and the styles that offer it, as the caller may see them. */
export async function groupViewOf(db: Db, row: GroupRow, context: RequestContext): Promise<GroupView> {
  const actor = actorOf(context)
  const price = seesPrice(context)
  const values = await readValues(db, [row.id])
  const effects = await readEffects(
    db,
    values.map((value) => value.id),
  )
  const rules = await db.optionRule.findMany({ where: { groupId: row.id }, select: RULE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const names = await valueNames(db, [...values.map((value) => value.id), ...rules.map((rule) => rule.otherValueId)])
  const groupFacts = { code: row.code, name: row.name, nameI18n: namesOf(row.nameI18n) }
  const groupOf = (groupId: string) => (groupId === row.id ? groupFacts : [...names.values()].find((value) => value.groupId === groupId)?.group)
  const refs = await effectRefsOf(db, effects)
  const usage = await usageOf(
    db,
    values.map((value) => value.id),
  )
  const offers = await db.styleOptionGroup.findMany({ where: { groupId: row.id }, select: OFFER_COLUMNS, orderBy: [{ status: 'asc' }, { seq: 'asc' }, { createdAt: 'asc' }] })
  const styles = new Map(
    (await db.style.findMany({ where: { id: { in: [...new Set(offers.map((offer) => offer.styleId))] } }, select: { id: true, code: true, name: true, companyId: true, status: true } })).map((style) => [style.id, style]),
  )
  const counts = (await countsOf(db, [row.id])).get(row.id)!
  const outside = new Set(effects.filter((effect) => effect.kind === 'CERTIFICATE').map((effect) => effect.valueId))
  const valueViews: ValueView[] = values.map((value) => ({
    id: value.id,
    groupId: value.groupId,
    code: value.code,
    name: value.name,
    nameI18n: namesOf(value.nameI18n),
    seq: value.seq,
    freeText: value.freeText,
    freeTextMaxLength: value.freeTextMaxLength,
    freeTextPattern: value.freeTextPattern,
    outsideCertificate: outside.has(value.id),
    effects: effects.filter((effect) => effect.valueId === value.id).length,
    usedBy: usage.get(value.id) ?? { lines: 0, steps: 0 },
    status: value.status,
    version: value.version,
    updatedAt: toUtcIso(value.updatedAt),
  }))
  return {
    ...groupRowViewOf(row, counts),
    values: valueViews,
    rules: rules.map((rule) => ruleViewOf(rule, names, groupOf)),
    effects: effects.map((effect) => effectViewOf(effect, refs, price)),
    styles: offers.flatMap((offer) => {
      const style = styles.get(offer.styleId)
      if (!style || !can(actor, PRODUCT_STYLES_VIEW, { companyId: style.companyId })) return []
      return [
        {
          id: offer.id,
          style: { ...style },
          seq: offer.seq,
          minPicks: offer.minPicks,
          maxPicks: offer.maxPicks,
          picks: { ...picksWords(effectivePicks(row, offer)) },
          defaultValueId: offer.defaultValueId,
          status: offer.status,
          version: offer.version,
        },
      ]
    }),
    subjectOptions: [
      { value: ANY_OPTION, code: null, words: { it: `Qualsiasi opzione di ${nameIn(groupFacts, 'it')}`, en: `Any option of ${nameIn(groupFacts, 'en')}` }, status: 'ACTIVE' as const },
      ...values.map((value) => ({ value: value.id, code: value.code, words: { it: nameIn({ name: value.name, nameI18n: namesOf(value.nameI18n) }, 'it'), en: nameIn({ name: value.name, nameI18n: namesOf(value.nameI18n) }, 'en') }, status: value.status })),
    ],
    counts: { ...counts },
    may: {
      manage: row.status === 'ACTIVE' && mayWrite(actor, PRODUCT_OPTIONS_MANAGE, row.companyId),
      price: row.status === 'ACTIVE' && price && mayWrite(actor, PRODUCT_OPTIONS_PRICE, row.companyId),
    },
  }
}

/** The record as the command left it (its answer). */
export async function groupViewInTx(tx: CommandTx, groupId: string, context: RequestContext): Promise<GroupView> {
  const row = await tx.optionGroup.findUnique({ where: { id: groupId }, select: GROUP_COLUMNS })
  if (!row) throw new NotFoundError('Option group not found.')
  return groupViewOf(tx, row, context)
}

/** A value of the group, read inside the command (after the group's lock). */
export async function valueIn(tx: CommandTx, groupId: string, valueId: string): Promise<ValueRow> {
  const row = isUuid(valueId) ? await tx.optionValue.findFirst({ where: { id: valueId, groupId }, select: VALUE_COLUMNS }) : null
  if (!row) throw new NotFoundError('Option value not found.')
  return row
}
