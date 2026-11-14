import type { Prisma } from '@nexus/factory-db'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { fieldSeenBy } from '@nexus/factory-domain/fields/access'
import { clauseProblem, meets, parseFilter } from '@nexus/factory-domain/fields/filters'
import type { FieldAudience, FieldStatus, FieldType } from '@nexus/factory-domain/fields/rules'
import { checkValue, isMoneyValue, sameStored, storedOf, type OptionFacts, type StoredValue } from '@nexus/factory-domain/fields/values'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTools } from '../../core/command'
import { recordFactsOf, recordsOfModel, isCustomModel, type CustomModel, type CustomRecord, type RecordFacts } from './records'

/**
 * The ONE registry of custom fields (B-W2b-421; PLT-111, PLT-115): how every list frame, record form, filter, export and
 * import reads a record type's fields and values, and how a command writes values. Pass your own client (`tools.tx` in
 * a command, `caller.withClient` outside); who may see the RECORD is your route's check — who may see each FIELD is
 * decided here, with factory-domain fields/access (money only with its grain, personal data only with
 * fields.personal.view, a partner only what the portal shows).
 *
 *   fieldsOfModel(client, model)              the fields of a record type with their lists (archived ones on request)
 *   fieldsSeen(actor, fields, companyId)      the ones this person sees, of the record's company or every company
 *   valuesOfRecords(client, model, ids)       the values of records, by record and field
 *   referenceWords(client, actor, …)          the words of person, link and file values (a link only when its record
 *                                             may be seen; else null)
 *   customFilter(client, model, term, actor)  a list's `cf` term → the records it keeps (`include`) and drops (`exclude`)
 *   writeValuesInCommand(tools, …)            set or clear values inside a command: checked, audited, one event
 */

type Client = Prisma.TransactionClient

export interface OptionRow extends OptionFacts {
  readonly id: string
  readonly colour: string | null
  readonly icon: string | null
  readonly description: string | null
  readonly version: number
}

export interface PicklistRow {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly status: FieldStatus
  readonly version: number
  readonly options: readonly OptionRow[]
}

export interface FieldRow {
  readonly id: string
  readonly companyId: string | null
  readonly recordType: string
  readonly code: string
  readonly type: FieldType
  readonly labelIt: string
  readonly labelEn: string
  readonly section: string
  readonly sortOrder: number
  readonly required: boolean
  readonly unit: string | null
  readonly audience: FieldAudience
  readonly grain: Grain | null
  readonly shownInPortal: boolean
  readonly picklistId: string | null
  readonly linkTo: string | null
  readonly status: FieldStatus
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly picklist: PicklistRow | null
  /** The list's values as a value check reads them (empty for a field without a list). */
  readonly options: readonly OptionFacts[]
}

export interface ValueRow {
  readonly id: string
  readonly fieldId: string
  readonly recordId: string
  readonly value: StoredValue
  readonly version: number
  readonly changedAt: Date
  readonly changedById: string
}

const FIELD_ORDER = [{ section: 'asc' as const }, { sortOrder: 'asc' as const }, { code: 'asc' as const }]

/** Lists with their values in their order. */
export async function picklistsOf(client: Client, where: Prisma.PicklistWhereInput = {}): Promise<PicklistRow[]> {
  const lists = await client.picklist.findMany({ where, orderBy: { code: 'asc' }, include: { values: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } } })
  return lists.map((list) => ({
    id: list.id,
    companyId: list.companyId,
    code: list.code,
    labelIt: list.labelIt,
    labelEn: list.labelEn,
    status: list.status as FieldStatus,
    version: list.version,
    options: list.values.map((value) => ({ id: value.id, code: value.code, labelIt: value.labelIt, labelEn: value.labelEn, colour: value.colour, icon: value.icon, sortOrder: value.sortOrder, description: value.description, active: value.active, version: value.version })),
  }))
}

type FieldRecord = Awaited<ReturnType<Client['customField']['findMany']>>[number]

function fieldRowOf(row: FieldRecord, lists: ReadonlyMap<string, PicklistRow>): FieldRow {
  const picklist = row.picklistId ? (lists.get(row.picklistId) ?? null) : null
  return {
    id: row.id,
    companyId: row.companyId,
    recordType: row.recordType,
    code: row.code,
    type: row.type as FieldType,
    labelIt: row.labelIt,
    labelEn: row.labelEn,
    section: row.section,
    sortOrder: row.sortOrder,
    required: row.required,
    unit: row.unit,
    audience: row.audience as FieldAudience,
    grain: (row.grain as Grain | null) ?? null,
    shownInPortal: row.shownInPortal,
    picklistId: row.picklistId,
    linkTo: row.linkTo,
    status: row.status as FieldStatus,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    picklist,
    options: picklist?.options ?? [],
  }
}

/** The fields of a record type (a model), in section and place order, with their lists; archived ones on request. */
export async function fieldsOfModel(client: Client, model: string, options: { readonly archived?: boolean } = {}): Promise<FieldRow[]> {
  const rows = await client.customField.findMany({ where: { recordType: model, ...(options.archived ? {} : { status: 'ACTIVE' }) }, orderBy: FIELD_ORDER })
  const listIds = [...new Set(rows.flatMap((row) => (row.picklistId ? [row.picklistId] : [])))]
  const lists = new Map((listIds.length > 0 ? await picklistsOf(client, { id: { in: listIds } }) : []).map((list) => [list.id, list]))
  return rows.map((row) => fieldRowOf(row, lists))
}

/** One field by id, with its list. */
export async function fieldById(client: Client, fieldId: string): Promise<FieldRow | null> {
  const row = await client.customField.findUnique({ where: { id: fieldId } })
  if (!row) return null
  const lists = new Map((row.picklistId ? await picklistsOf(client, { id: row.picklistId }) : []).map((list) => [list.id, list]))
  return fieldRowOf(row, lists)
}

/** A field of every company applies to every record; a company's field to that company's records and tenant-wide ones. */
export const appliesTo = (field: Pick<FieldRow, 'companyId'>, companyId: string | null): boolean => field.companyId === null || companyId === null || field.companyId === companyId

/** The fields this person sees, of the record's company (undefined: any company — a list across companies). */
export const fieldsSeen = (actor: Actor, fields: readonly FieldRow[], companyId?: string | null): FieldRow[] =>
  fields.filter((field) => fieldSeenBy(actor, field) && (companyId === undefined || appliesTo(field, companyId)))

/** The values of records of a model, by record id then field id. */
export async function valuesOfRecords(client: Client, model: string, recordIds: readonly string[], fieldIds?: readonly string[]): Promise<Map<string, Map<string, ValueRow>>> {
  const byRecord = new Map<string, Map<string, ValueRow>>()
  if (recordIds.length === 0 || fieldIds?.length === 0) return byRecord
  const rows = await client.customFieldValue.findMany({
    where: { recordType: model, recordId: { in: [...new Set(recordIds)] }, ...(fieldIds ? { fieldId: { in: [...fieldIds] } } : {}) },
    select: { id: true, fieldId: true, recordId: true, value: true, version: true, changedAt: true, changedById: true },
  })
  for (const row of rows) {
    const value = storedOf(row.value)
    if (value === null) continue
    const values = byRecord.get(row.recordId) ?? new Map<string, ValueRow>()
    values.set(row.fieldId, { id: row.id, fieldId: row.fieldId, recordId: row.recordId, value, version: row.version, changedAt: row.changedAt, changedById: row.changedById })
    byRecord.set(row.recordId, values)
  }
  return byRecord
}

/** How many records have a value of each field (Admin › Fields & lists). */
export async function valueCounts(client: Client, fieldIds: readonly string[]): Promise<Map<string, number>> {
  if (fieldIds.length === 0) return new Map()
  const groups = await client.customFieldValue.groupBy({ by: ['fieldId'], where: { fieldId: { in: [...fieldIds] } }, _count: { _all: true } })
  return new Map(groups.map((group) => [group.fieldId, group._count._all]))
}

/**
 * The words of person, link and file values: a person's name, a linked record's code and name (only when this person may
 * see that record: its type's view permission over its company, site and party; else no words), a file's name. By id.
 */
export async function referenceWords(client: Client, actor: Actor, fields: readonly FieldRow[], values: Iterable<ValueRow>): Promise<Map<string, string>> {
  const byId = new Map(fields.map((field) => [field.id, field]))
  const people = new Set<string>()
  const files = new Set<string>()
  const links = new Map<CustomModel, Set<string>>()
  for (const row of values) {
    const field = byId.get(row.fieldId)
    if (!field || typeof row.value !== 'string') continue
    if (field.type === 'PERSON') people.add(row.value)
    else if (field.type === 'FILE') files.add(row.value)
    else if (field.type === 'LINK' && field.linkTo && isCustomModel(field.linkTo)) links.set(field.linkTo, (links.get(field.linkTo) ?? new Set()).add(row.value))
  }
  const words = new Map<string, string>()
  if (people.size > 0) for (const user of await client.user.findMany({ where: { id: { in: [...people] } }, select: { id: true, displayName: true } })) words.set(user.id, user.displayName)
  if (files.size > 0) for (const file of await client.storedFile.findMany({ where: { id: { in: [...files] }, status: 'AVAILABLE' }, select: { id: true, originalName: true } })) words.set(file.id, file.originalName)
  for (const [model, ids] of links) {
    const permission = recordsOfModel(model)[0]!.view
    for (const facts of (await recordFactsOf(client, model, [...ids])).values()) if (can(actor, permission, facts)) words.set(facts.id, facts.label)
  }
  return words
}

// ---- filters --------------------------------------------------------------------------------------------------------

export interface CustomMatch {
  /** The records every positive clause keeps (null: no positive clause — every record). */
  readonly include: ReadonlySet<string> | null
  /** The records a "has none" clause drops. */
  readonly exclude: ReadonlySet<string>
}

/** Keeps a record id? */
export const kept = (match: CustomMatch, id: string): boolean => (match.include === null || match.include.has(id)) && !match.exclude.has(id)

/**
 * A list's `cf` term over a record type's fields this person sees (null term: null). A clause on a field the person does
 * not see is refused as an unknown field (400 at `query/cf`), never answered.
 */
export async function customFilter(client: Client, model: string, term: string | null | undefined, actor: Actor): Promise<CustomMatch | null> {
  const { clauses, problems } = parseFilter(term)
  const issues: Issue[] = problems.map((problem) => ({ path: `query/${problem.path}`, message: problem.message }))
  if (clauses.length === 0 && issues.length === 0) return null
  const fields = new Map(fieldsSeen(actor, await fieldsOfModel(client, model)).map((field) => [field.code, field]))
  for (const clause of clauses) {
    const field = fields.get(clause.code)
    if (!field) issues.push({ path: 'query/cf', message: `No custom field ${clause.code} here.` })
    else {
      const problem = clauseProblem(field.type, clause)
      if (problem) issues.push({ path: 'query/cf', message: problem })
    }
  }
  if (issues.length > 0) throw new ValidationError('The custom field filter is not valid.', issues)
  let include = null as Set<string> | null
  const exclude = new Set<string>()
  for (const clause of clauses) {
    const field = fields.get(clause.code)!
    const rows = await client.customFieldValue.findMany({ where: { fieldId: field.id }, select: { recordId: true, value: true } })
    if (clause.op === 'unset') {
      for (const row of rows) exclude.add(row.recordId)
      continue
    }
    const meeting = new Set(rows.filter((row) => meets(field.type, storedOf(row.value), clause)).map((row) => row.recordId))
    const before: Set<string> | null = include
    include = before === null ? meeting : new Set([...before].filter((id: string) => meeting.has(id)))
  }
  return { include, exclude }
}

// ---- values as answers and audit rows -------------------------------------------------------------------------------

/**
 * A value as an answer or audit row holds it: a money field's value marked with its grain (the amount itself marked too,
 * so the grain filter keeps it whole for a holder and removes it for anyone else) — never a bare amount.
 */
export function markedValue(field: Pick<FieldRow, 'audience' | 'grain'>, value: StoredValue | null): unknown {
  if (value === null || field.audience !== 'MONEY' || !field.grain) return value
  const grain = field.grain
  return markMoney(grain, isMoneyValue(value) ? { amount: markMoney(grain, value.amount), currency: value.currency } : value)
}

// ---- writing --------------------------------------------------------------------------------------------------------

/** One value to set (a value) or clear (null), at the version read (null: the record had no value of it). */
export interface ValueEntry {
  readonly code: string
  readonly value: unknown
  readonly version: number | null
}

/** The database's own refusal (…_config_templates_w2b_guards: check_violation 'fields: …') in its words, or null. */
export function databaseFieldsRefusal(error: unknown): DomainError | null {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode !== '23514' || typeof cause.originalMessage !== 'string' || !cause.originalMessage.startsWith('fields: ')) return null
  const words = cause.originalMessage.slice('fields: '.length)
  return new DomainError('conflict', words.charAt(0).toUpperCase() + words.slice(1), [{ path: 'refusal/FIELDS', message: words }])
}

/** A command's work with the database's refusals of these tables said in words (409), never a 500. */
export async function saidInWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw databaseFieldsRefusal(error) ?? error
  }
}

/** Why a reference value cannot be kept (a person who is not an office person, a record of another company …), or null. */
async function referenceProblem(client: Client, field: FieldRow, value: string, record: RecordFacts, model: string): Promise<string | null> {
  if (field.type === 'PERSON') {
    const user = await client.user.findUnique({ where: { id: value }, select: { audience: true } })
    return user?.audience === 'OFFICE' ? null : 'Pick a person of the office.'
  }
  if (field.type === 'FILE') {
    const file = await client.storedFile.findUnique({ where: { id: value }, select: { recordType: true, recordId: true, status: true } })
    return file && file.recordType === model && file.recordId === record.id && file.status === 'AVAILABLE' ? null : 'Pick a file of this record that has finished uploading.'
  }
  if (field.type === 'LINK') {
    if (!field.linkTo || !isCustomModel(field.linkTo)) return 'This link field links to a kind of record that cannot be picked here.'
    const target = (await recordFactsOf(client, field.linkTo, [value])).get(value)
    if (!target) return 'The linked record was not found.'
    if (target.companyId !== null && record.companyId !== null && target.companyId !== record.companyId) return 'The linked record belongs to another company.'
  }
  return null
}

/**
 * Sets or clears custom values of ONE record inside the caller's command (the record's own command, or the values route):
 * each field active, of the record's company and seen by the person (else refused as unknown: never told it exists), at
 * the version read; each value checked for its type (a deactivated list value only where the record has it), its
 * references checked; an unchanged value writes nothing. One audit row per value (money marked with its grain) and one
 * custom_value.changed event. Answers the codes set and cleared.
 */
export async function writeValuesInCommand(tools: CommandTools, record: CustomRecord, facts: RecordFacts, entries: readonly ValueEntry[], actor: Actor, actorId: string): Promise<{ readonly set: string[]; readonly cleared: string[] }> {
  const model = record.model
  const fields = new Map(fieldsSeen(actor, await fieldsOfModel(tools.tx, model), facts.companyId).map((field) => [field.code, field]))
  const current = (await valuesOfRecords(tools.tx, model, [facts.id])).get(facts.id) ?? new Map<string, ValueRow>()
  const issues: Issue[] = []
  const planned: { readonly field: FieldRow; readonly before: ValueRow | null; readonly value: StoredValue | null }[] = []
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const at = `body/values/${index}`
    const field = fields.get(entry.code)
    if (!field) {
      issues.push({ path: `${at}/code`, message: `No custom field ${entry.code} on this ${record.labelEn.toLowerCase()}.` })
      continue
    }
    if (seen.has(field.code)) {
      issues.push({ path: `${at}/code`, message: 'Each field once.' })
      continue
    }
    seen.add(field.code)
    const before = current.get(field.id) ?? null
    if ((before?.version ?? null) !== entry.version) {
      throw new DomainError('conflict', `The value of ${field.labelEn} changed since it was read: reload it and try again.`, [{ path: `${at}/version`, message: before ? `The current version is ${before.version}.` : 'It has no value now.' }])
    }
    if (entry.value === null) {
      if (field.required) issues.push({ path: `${at}/value`, message: `${field.labelEn} is required.` })
      else if (before) planned.push({ field, before, value: null })
      continue
    }
    const checked = checkValue(field, entry.value, before?.value ?? null)
    if ('problem' in checked) {
      issues.push({ path: `${at}/value`, message: checked.problem })
      continue
    }
    if (typeof checked.value === 'string' && (field.type === 'PERSON' || field.type === 'LINK' || field.type === 'FILE') && checked.value !== before?.value) {
      const problem = await referenceProblem(tools.tx, field, checked.value, facts, model)
      if (problem) {
        issues.push({ path: `${at}/value`, message: problem })
        continue
      }
    }
    if (!sameStored(before?.value ?? null, checked.value)) planned.push({ field, before, value: checked.value })
  }
  if (issues.length > 0) throw new ValidationError('Some custom values are not valid.', issues)
  const set: string[] = []
  const cleared: string[] = []
  for (const { field, before, value } of planned) {
    const audit = { recordType: model, recordId: facts.id, companyId: facts.companyId }
    if (value === null) {
      await tools.tx.customFieldValue.delete({ where: { id: before!.id } })
      tools.audit({ ...audit, action: 'fields.clearValue', before: { field: field.code, value: markedValue(field, before!.value) }, after: { field: field.code, value: null } })
      cleared.push(field.code)
      continue
    }
    // The database wants each change later than the last: two changes in one millisecond step one past the other.
    const changedAt = before && before.changedAt.getTime() >= tools.now.getTime() ? new Date(before.changedAt.getTime() + 1) : tools.now
    const json = value as Prisma.InputJsonValue
    if (before) {
      const { count } = await tools.tx.customFieldValue.updateMany({ where: { id: before.id, version: before.version }, data: { value: json, changedAt, changedById: actorId, version: { increment: 1 } } })
      if (count !== 1) throw new DomainError('conflict', `The value of ${field.labelEn} changed since it was read: reload it and try again.`, [{ path: 'body/values', message: 'changed meanwhile' }])
    } else {
      await tools.tx.customFieldValue.create({ data: { id: newId(), fieldId: field.id, recordType: model, recordId: facts.id, key: `value:${field.id}:${facts.id}`, value: json, changedAt, changedById: actorId, createdById: actorId } })
    }
    tools.audit({ ...audit, action: 'fields.setValue', before: { field: field.code, value: markedValue(field, before?.value ?? null) }, after: { field: field.code, value: markedValue(field, value) } })
    set.push(field.code)
  }
  if (set.length > 0 || cleared.length > 0) tools.emit({ type: 'custom_value.changed', subject: facts.id, companyId: facts.companyId, siteId: facts.siteId ?? null, payload: { recordType: model, recordId: facts.id, set, cleared } })
  return { set, cleared }
}
