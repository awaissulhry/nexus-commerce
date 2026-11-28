import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { anyOf, can, NO_ROWS, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { PRODUCTION_STRUCTURES_MANAGE, PRODUCTION_STRUCTURES_RULES } from '@nexus/factory-domain/production/structures/permissions'
import { openRules, ruleDead, ruleLive, structureOf, type RuleNames, type StructureOverrideFacts, type StructureRuleFacts } from '@nexus/factory-domain/production/structures/rules'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { teamFaces } from '../../people/teams/faces'

/**
 * Order structures and their rules (owb-ss6): the facts the reads, the writes and the Confirm handler share — a company's rules,
 * an order's made lines with their category, its open structure by hand, its first print — and the rows the Shape sends
 * (StructureRow, RuleRow). One read per table; names only of what the caller may see.
 */

type Client = FactoryClient | CommandTx

/** An order that is not started yet follows the rules live (waiting for a yes, or confirmed and not printed). */
export const OPEN_ORDER_STATUSES = ['PENDING_APPROVAL', 'CONFIRMED'] as const
export const isOpenStatus = (status: string): boolean => (OPEN_ORDER_STATUSES as readonly string[]).includes(status)

/** The most open orders one list reads for its rules' "fits now". */
const FITS_NOW_READ = 2000
/** The orders a rule's "fits now" names (the count is whole). */
const FITS_NOW_SHOWN = 5

/** The caller reads the structures and rules over this company (and customer): production.structures.manage or .rules. */
export function readsAt(context: OfficeContext, scope: { readonly companyId: string; readonly partyId?: string | null }): boolean {
  const actor = actorOf(context)
  const record = { companyId: scope.companyId, partyId: scope.partyId ?? null }
  return can(actor, PRODUCTION_STRUCTURES_MANAGE, record) || can(actor, PRODUCTION_STRUCTURES_RULES, record)
}

/** The caller changes the rules (and one order by hand) over this company and customer. */
export const writesRulesAt = (context: OfficeContext, scope: { readonly companyId: string; readonly partyId?: string | null }): boolean =>
  can(actorOf(context), PRODUCTION_STRUCTURES_RULES, { companyId: scope.companyId, partyId: scope.partyId ?? null })

/**
 * The company a list, a try or a new structure is about: the screen's (`x-factory-company`), else `fallback` (a team's, a
 * customer's), else the only company the caller reaches with these rights; none: a 400 in words.
 */
export async function companyOf(client: Client, context: OfficeContext, permissions: readonly Permission[], fallback: string | null): Promise<string> {
  const companyId = context.companyId ?? fallback ?? (await onlyCompany(client, context, permissions))
  if (!companyId) throw new ValidationError('Open this from the page of one company: structures and their rules belong to a company.', [{ path: 'headers/x-factory-company', message: 'Name the company.' }])
  return companyId
}

async function onlyCompany(client: Client, context: OfficeContext, permissions: readonly Permission[]): Promise<string | null> {
  const actor = actorOf(context)
  const where = anyOf(permissions.map((permission) => scopeWhere(actor, permission, { company: 'id' })))
  if (where === NO_ROWS) return null
  const rows = await client.company.findMany({ where: { AND: [where as Prisma.CompanyWhereInput, { status: 'ACTIVE' }] }, orderBy: { id: 'asc' }, select: { id: true }, take: 2 })
  return rows.length === 1 ? rows[0]!.id : null
}

/** One rule of a company, as the rules and the rows read it. */
export interface RuleRecord extends StructureRuleFacts {
  readonly companyId: string
  readonly note: string | null
  readonly version: number
}

/** Every rule of the company (open and closed), in its place on the list. */
export async function rulesOfCompany(client: Client, companyId: string): Promise<RuleRecord[]> {
  const rows = await client.orderStructureRule.findMany({
    where: { companyId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, companyId: true, sortOrder: true, partyId: true, category: true, structureId: true, active: true, note: true, closedAt: true, version: true, structure: { select: { closedAt: true } } },
  })
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    sortOrder: row.sortOrder,
    partyId: row.partyId,
    category: row.category === null ? null : String(row.category),
    structureId: row.structureId,
    active: row.active,
    closed: row.closedAt !== null,
    structureClosed: row.structure.closedAt !== null,
    note: row.note,
    version: row.version,
  }))
}

/** One made line of an order (a FEE line is never made: it takes no structure). */
export interface MadeLine {
  readonly id: string
  readonly orderId: string
  readonly seq: number
  /** Its pieces (a split's share counts them). */
  readonly pieces: number
  /** Its style's product type. */
  readonly category: string | null
  /** Its words: style code, style name, colour (or its description). Never a price. */
  readonly label: string
}

/** The made lines of these orders, in their order. */
export async function madeLinesOf(client: Client, orderIds: readonly string[]): Promise<MadeLine[]> {
  if (orderIds.length === 0) return []
  const lines = await client.salesOrderLine.findMany({
    where: { orderId: { in: [...orderIds] }, kind: { not: 'FEE' } },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
    select: { id: true, orderId: true, seq: true, quantity: true, description: true, styleId: true, colourwayId: true },
  })
  const styleIds = [...new Set(lines.map((line) => line.styleId))]
  const colourIds = [...new Set(lines.map((line) => line.colourwayId))]
  const styles = new Map((styleIds.length === 0 ? [] : await client.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true, name: true, productType: true } })).map((style) => [style.id, style]))
  const colours = new Map((colourIds.length === 0 ? [] : await client.colourway.findMany({ where: { id: { in: colourIds } }, select: { id: true, name: true } })).map((colour) => [colour.id, colour.name]))
  return lines.map((line) => {
    const style = styles.get(line.styleId)
    const words = [style?.code, style?.name, colours.get(line.colourwayId)].filter((word): word is string => typeof word === 'string' && word.trim() !== '')
    return {
      id: line.id,
      orderId: line.orderId,
      seq: line.seq,
      pieces: Number(line.quantity),
      category: style ? String(style.productType) : null,
      label: words.length > 0 ? words.join(' · ') : (line.description ?? `Line ${line.seq}`),
    }
  })
}

/** An order's open structure by hand. */
export interface OverrideRecord extends StructureOverrideFacts {
  readonly id: string
  readonly createdAt: Date
  readonly createdById: string | null
}

/** The open structure by hand of each of these orders (one at most: OrderStructureOverride_one_open). */
export async function openOverridesOf(client: Client, orderIds: readonly string[]): Promise<Map<string, OverrideRecord>> {
  if (orderIds.length === 0) return new Map()
  const rows = await client.orderStructureOverride.findMany({
    where: { salesOrderId: { in: [...orderIds] }, endedAt: null },
    select: { id: true, salesOrderId: true, structureId: true, why: true, createdAt: true, createdById: true, structure: { select: { closedAt: true } } },
  })
  return new Map(rows.map((row) => [row.salesOrderId, { id: row.id, structureId: row.structureId, why: row.why, createdAt: row.createdAt, createdById: row.createdById, structureClosed: row.structure !== null && row.structure.closedAt !== null }]))
}

/** The order's FIRST print happened (the work started; it keeps its structure). */
export async function isPrinted(client: Client, orderId: string): Promise<boolean> {
  return (await client.orderPrint.findFirst({ where: { salesOrderId: orderId, kind: 'FIRST' }, select: { id: true } })) !== null
}

/** One structure, as the rows and the handler read it. */
export interface StructureRecord {
  readonly id: string
  readonly companyId: string
  readonly name: string
  readonly teamIds: readonly string[]
  readonly peopleUserIds: readonly string[]
  readonly note: string | null
  readonly closed: boolean
  readonly version: number
}

const STRUCTURE_SELECT = { id: true, companyId: true, name: true, teamIds: true, peopleUserIds: true, note: true, closedAt: true, version: true } as const
type StructureSelected = { id: string; companyId: string; name: string; teamIds: string[]; peopleUserIds: string[]; note: string | null; closedAt: Date | null; version: number }
const structureRecord = (row: StructureSelected): StructureRecord => ({ id: row.id, companyId: row.companyId, name: row.name, teamIds: row.teamIds, peopleUserIds: row.peopleUserIds, note: row.note, closed: row.closedAt !== null, version: row.version })

/** These structures, keyed by id (an id this session cannot read is left out). */
export async function structuresByIds(client: Client, ids: readonly (string | null)[]): Promise<Map<string, StructureRecord>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await client.orderStructure.findMany({ where: { id: { in: wanted } }, select: STRUCTURE_SELECT })
  return new Map(rows.map((row) => [row.id, structureRecord(row)]))
}

/** The structures matching `where`, by name. */
export async function structuresWhere(client: Client, where: Prisma.OrderStructureWhereInput): Promise<StructureRecord[]> {
  return (await client.orderStructure.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: STRUCTURE_SELECT })).map(structureRecord)
}

/** A customer's name (trade name, else legal name), keyed by id. */
export async function partyNames(client: Client, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await client.party.findMany({ where: { id: { in: wanted } }, select: { id: true, tradeName: true, legalName: true } })).map((party) => [party.id, party.tradeName ?? party.legalName]))
}

/** An office person's name, keyed by user id. */
export async function userNames(client: Client, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The answer rows of these structures (StructureRow of the Shape). */
export async function structureRows(client: Client, structures: readonly StructureRecord[]) {
  const faces = await teamFaces(client, structures.flatMap((structure) => structure.teamIds))
  const people = await userNames(client, structures.flatMap((structure) => structure.peopleUserIds))
  const ids = structures.map((structure) => structure.id)
  const naming = ids.length === 0 ? [] : await client.orderStructureRule.findMany({ where: { structureId: { in: ids }, closedAt: null }, select: { structureId: true } })
  return structures.map((structure) => ({
    id: structure.id,
    name: structure.name,
    teams: structure.teamIds.flatMap((teamId) => {
      const face = faces.get(teamId)
      return face ? [{ id: face.id, name: face.name, picture: face.picture }] : []
    }),
    people: structure.peopleUserIds.flatMap((userId) => {
      const name = people.get(userId)
      return name === undefined ? [] : [{ userId, name }]
    }),
    note: structure.note,
    closed: structure.closed,
    usedByRules: naming.filter((rule) => rule.structureId === structure.id).length,
    version: structure.version,
  }))
}

/** What a rule does now: the open orders not printed yet that it gives their structure (count, and the first few). */
export interface FitsNow {
  count: number
  orders: Array<{ id: string; number: string }>
}

/**
 * Each rule's "fits now" over the company's open orders that are not printed yet (PENDING_APPROVAL, CONFIRMED; no FIRST print)
 * and that `reach` lets the caller see — only this customer's when `partyId` is given. A line given by hand counts for no rule.
 */
export async function fitsNowOf(client: Client, companyId: string, rules: readonly RuleRecord[], reach: (order: { readonly companyId: string; readonly partyId: string }) => boolean, partyId?: string): Promise<Map<string, FitsNow>> {
  const result = new Map<string, FitsNow>()
  if (!rules.some(ruleLive)) return result
  const orders = await client.salesOrder.findMany({
    where: { companyId, status: { in: [...OPEN_ORDER_STATUSES] }, prints: { none: { kind: 'FIRST' } }, ...(partyId ? { partyId } : {}) },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
    take: FITS_NOW_READ,
    select: { id: true, number: true, companyId: true, partyId: true },
  })
  const seen = orders.filter(reach)
  if (seen.length === 0) return result
  const ids = seen.map((order) => order.id)
  const linesOf = new Map<string, MadeLine[]>()
  for (const line of await madeLinesOf(client, ids)) linesOf.set(line.orderId, [...(linesOf.get(line.orderId) ?? []), line])
  const overrides = await openOverridesOf(client, ids)
  for (const order of seen) {
    const override = overrides.get(order.id) ?? null
    const winners = new Set<string>()
    for (const line of linesOf.get(order.id) ?? []) {
      const taken = structureOf({ partyId: order.partyId, category: line.category }, rules, override)
      if (taken.from === 'RULE' && taken.ruleId !== null) winners.add(taken.ruleId)
    }
    for (const ruleId of winners) {
      const entry = result.get(ruleId) ?? { count: 0, orders: [] }
      entry.count += 1
      if (entry.orders.length < FITS_NOW_SHOWN) entry.orders.push({ id: order.id, number: order.number })
      result.set(ruleId, entry)
    }
  }
  return result
}

/** The words' names: customers the caller reaches, structures by id. */
export function namesFor(context: OfficeContext, companyId: string, parties: ReadonlyMap<string, string>, structures: ReadonlyMap<string, StructureRecord>): RuleNames {
  return {
    party: (partyId) => (readsAt(context, { companyId, partyId }) ? (parties.get(partyId) ?? null) : null),
    structure: (structureId) => structures.get(structureId)?.name ?? null,
  }
}

/**
 * The answer rows of a company's rules (RuleRow of the Shape): the open ones in their place, then the closed ones; a rule naming a
 * customer the caller does not reach is left out (its place still counts: "never used" and "fits now" read the whole list).
 * `only` keeps some rows; `partyId` limits "fits now" to that customer's orders.
 */
export async function ruleRows(client: Client, context: OfficeContext, companyId: string, rules: readonly RuleRecord[], options: { readonly only?: (rule: RuleRecord) => boolean; readonly partyId?: string } = {}) {
  const shown = rules.filter((rule) => (rule.partyId === null || readsAt(context, { companyId, partyId: rule.partyId })) && (options.only ? options.only(rule) : true))
  const dead = ruleDead(rules)
  const fits = shown.length === 0 ? new Map<string, FitsNow>() : await fitsNowOf(client, companyId, rules, (order) => readsAt(context, order), options.partyId)
  const structures = await structuresByIds(client, shown.map((rule) => rule.structureId))
  const parties = await partyNames(client, shown.map((rule) => rule.partyId))
  const closed = shown.filter((rule) => rule.closed).sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
  return [...openRules(shown), ...closed].map((rule) => {
    const structure = structures.get(rule.structureId)
    const because = rule.closed ? undefined : dead.get(rule.id)
    return {
      id: rule.id,
      sortOrder: rule.sortOrder,
      party: rule.partyId === null ? null : { id: rule.partyId, name: parties.get(rule.partyId) ?? '' },
      category: rule.category,
      structure: { id: rule.structureId, name: structure?.name ?? '', closed: rule.structureClosed },
      active: rule.active,
      note: rule.note,
      closed: rule.closed,
      dead: because !== undefined,
      deadBecause: because === undefined ? null : { ruleId: because },
      fitsNow: rule.closed ? { count: 0, orders: [] } : (fits.get(rule.id) ?? { count: 0, orders: [] }),
      version: rule.version,
    }
  })
}

/** How many of the rows the caller sees are "Never used" (open and dead). */
export const neverUsedOf = (rows: readonly { readonly dead: boolean; readonly closed: boolean }[]): number => rows.filter((row) => row.dead && !row.closed).length
