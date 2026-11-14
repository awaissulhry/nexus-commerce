import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { columnIdOf } from '@nexus/factory-domain/fields/access'
import { FIELDS_MANAGE, FIELDS_PERSONAL_VIEW, FIELDS_VIEW } from '@nexus/factory-domain/fields/permissions'
import { FIELD_LIMITS, factsAfter, fieldProblems, nextPlace, optionProblems, orderProblems, picklistProblems, placesOf, type FieldDraft, type FieldFacts } from '@nexus/factory-domain/fields/rules'
import type { StoredValue } from '@nexus/factory-domain/fields/values'
import type { PICKLIST_CHANGES, FIELD_CHANGES } from '@nexus/factory-domain/fields/events'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { systemCallerOf } from '../files/files'
import type { CreateFieldBody, EditFieldBody, FieldView, PicklistView, WriteValuesBody } from './contract'
import { CUSTOM_RECORDS, customRecordOf, recordFactsOf, recordsOfModel, type CustomRecord, type CustomRecordKey, type RecordFacts } from './records'
import { fieldById, fieldsOfModel, fieldsSeen, markedValue, picklistsOf, referenceWords, saidInWords, valueCounts, valuesOfRecords, writeValuesInCommand, type FieldRow, type PicklistRow, type ValueRow } from './registry'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115): the editor's read and commands (Admin › Fields & lists, the
 * screens of B-W2b-431), and a record's custom values (its form, a grid page, the portal). Each write is ONE command():
 * its audit rows and one event. A field is never deleted (archived, its values kept) and a list value never (deactivated:
 * records keep it). A field or list of every company is kept with fields.manage over every company; a company's own with
 * it over that company. Values are read and written with the RECORD's own permissions (platform/fields/records.ts).
 */

type Client = Prisma.TransactionClient

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller): Actor => actorOf(contextOf(caller))
const actorIdOf = (context: RequestContext): string => ('actorId' in context ? context.actorId : newId())
const createdBy = (context: RequestContext): string | null => (context.audience === 'office' ? context.actorId : null)
const tenantOf = (tools: CommandTools): string => (tools.context as { readonly tenantId: string }).tenantId
const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** "an order", "a style": the record type in a sentence. */
const aRecord = (record: CustomRecord): string => `${/^[aeiou]/i.test(record.labelEn) ? 'an' : 'a'} ${record.labelEn.toLowerCase()}`

function recordOf(key: string): CustomRecord {
  const record = customRecordOf(key)
  if (!record) throw new NotFoundError('No such record type.')
  return record
}

// ---- who keeps what ---------------------------------------------------------------------------------------------------

/** Keeps a field or list of a company (null: every company — then fields.manage over every company). */
function mayKeep(who: Actor, companyId: string | null): boolean {
  return companyId === null ? grantsFor(who, FIELDS_MANAGE).some((grant) => grant.companies === 'all') : can(who, FIELDS_MANAGE, { companyId })
}

function keepOrRefuse(who: Actor, companyId: string | null): void {
  if (!mayKeep(who, companyId)) throw new ForbiddenError(companyId === null ? "A field or list of every company is the whole group's: keeping it needs fields.manage over every company." : 'Keeping the fields and lists of this company needs fields.manage over it.')
}

/** Changing who sees a money or personal field needs what it protects: its grain, or the personal right. */
function visibilityRefusal(who: Actor, before: FieldFacts | null, after: FieldFacts): string | null {
  const grains = heldGrains(who)
  for (const facts of before ? [before, after] : [after]) {
    if (facts.audience === 'MONEY' && facts.grain && !grains.has(facts.grain)) return `Who sees a ${facts.grain} field is changed only by someone with the ${facts.grain} grain.`
    if (facts.audience === 'PERSONAL' && !holds(who, FIELDS_PERSONAL_VIEW)) return 'Who sees a personal field is changed only by someone who may read personal data (fields.personal.view).'
  }
  return null
}

// ---- views ------------------------------------------------------------------------------------------------------------

const optionViewOf = (option: PicklistRow['options'][number]) => ({ id: option.id, code: option.code, labelIt: option.labelIt, labelEn: option.labelEn, colour: option.colour, icon: option.icon, sortOrder: option.sortOrder, description: option.description, active: option.active, version: option.version })

export function fieldViewOf(field: FieldRow): FieldView {
  const link = field.linkTo ? (recordsOfModel(field.linkTo)[0] ?? null) : null
  return {
    id: field.id,
    companyId: field.companyId,
    code: field.code,
    columnId: columnIdOf(field),
    type: field.type,
    labelIt: field.labelIt,
    labelEn: field.labelEn,
    section: field.section,
    sortOrder: field.sortOrder,
    required: field.required,
    unit: field.unit,
    audience: field.audience,
    grain: field.grain,
    shownInPortal: field.shownInPortal,
    status: field.status,
    version: field.version,
    picklist: field.picklist ? { id: field.picklist.id, code: field.picklist.code, labelIt: field.picklist.labelIt, labelEn: field.picklist.labelEn, values: field.picklist.options.map(optionViewOf) } : null,
    linkTo: field.linkTo,
    linkRecordType: link?.key ?? null,
  }
}

async function picklistViewOf(client: Client, list: PicklistRow): Promise<PicklistView> {
  const fieldCount = await client.customField.count({ where: { picklistId: list.id, status: 'ACTIVE' } })
  return { id: list.id, companyId: list.companyId, code: list.code, labelIt: list.labelIt, labelEn: list.labelEn, status: list.status, version: list.version, values: list.options.map(optionViewOf), fieldCount }
}

async function picklistView(client: Client, picklistId: string): Promise<PicklistView> {
  const list = (await picklistsOf(client, { id: picklistId }))[0]
  if (!list) throw new NotFoundError('The list was not found.')
  return picklistViewOf(client, list)
}

/** The words of a value in each language: a select's labels, a reference's words (both languages alike). */
function wordsOf(field: FieldRow, value: StoredValue, references: ReadonlyMap<string, string>): { wordsIt: string | null; wordsEn: string | null } {
  const label = (code: string, language: 'it' | 'en') => {
    const option = field.options.find((entry) => entry.code === code)
    return option ? (language === 'it' ? option.labelIt : option.labelEn) : code
  }
  if (field.type === 'SELECT' && typeof value === 'string') return { wordsIt: label(value, 'it'), wordsEn: label(value, 'en') }
  if (field.type === 'MULTI_SELECT' && Array.isArray(value)) return { wordsIt: (value as string[]).map((code) => label(code, 'it')).join(', '), wordsEn: (value as string[]).map((code) => label(code, 'en')).join(', ') }
  if ((field.type === 'PERSON' || field.type === 'LINK' || field.type === 'FILE') && typeof value === 'string') {
    const words = references.get(value) ?? null
    return { wordsIt: words, wordsEn: words }
  }
  return { wordsIt: null, wordsEn: null }
}

function valueViewsOf(fields: readonly FieldRow[], values: ReadonlyMap<string, ValueRow>, references: ReadonlyMap<string, string>) {
  return fields.flatMap((field) => {
    const row = values.get(field.id)
    if (!row) return []
    return [{ code: field.code, value: markedValue(field, row.value), ...wordsOf(field, row.value, references), version: row.version, changedAt: row.changedAt.toISOString(), changedById: row.changedById }]
  })
}

// ---- the editor -------------------------------------------------------------------------------------------------------

/** GET /fields/editor?recordType=ORDER (fields.view): the record types, the chosen one's fields with their counts, every list. */
export async function editor(caller: CommandCaller, query: { recordType?: CustomRecordKey | undefined }) {
  const who = actor(caller)
  const record = recordOf(query.recordType ?? CUSTOM_RECORDS[0]!.key)
  const reaches = (companyId: string | null) => companyId === null || can(who, FIELDS_VIEW, { companyId })
  return caller.withClient(async (client) => {
    const counts = await client.customField.groupBy({ by: ['recordType'], where: { status: 'ACTIVE' }, _count: { _all: true } })
    const fields = (await fieldsOfModel(client, record.model, { archived: true })).filter((field) => reaches(field.companyId))
    const used = await valueCounts(client, fields.map((field) => field.id))
    const lists = (await picklistsOf(client)).filter((list) => reaches(list.companyId))
    const picklists: PicklistView[] = []
    for (const list of lists) picklists.push(await picklistViewOf(client, list))
    return {
      records: CUSTOM_RECORDS.map((entry) => ({
        key: entry.key,
        model: entry.model,
        labelIt: entry.labelIt,
        labelEn: entry.labelEn,
        fieldCount: counts.find((count) => count.recordType === entry.model)?._count._all ?? 0,
        sharedWith: recordsOfModel(entry.model).filter((other) => other.key !== entry.key).map((other) => other.key),
        listKey: entry.listKey,
        importer: entry.importer,
      })),
      recordType: record.key,
      fields: fields.map((field) => ({ ...fieldViewOf(field), valueCount: used.get(field.id) ?? 0, createdAt: field.createdAt.toISOString(), updatedAt: field.updatedAt.toISOString() })),
      picklists,
      canManage: grantsFor(who, FIELDS_MANAGE).length > 0,
    }
  })
}

function emitField(tools: CommandTools, model: string, change: (typeof FIELD_CHANGES)[number], fields: readonly Pick<FieldRow, 'id' | 'code' | 'type' | 'companyId'>[]): void {
  tools.emit({ type: 'custom_field.changed', subject: model, companyId: fields.length === 1 ? fields[0]!.companyId : null, siteId: null, payload: { recordType: model, change, fieldIds: fields.map((field) => field.id), codes: fields.map((field) => field.code), type: fields.length === 1 ? fields[0]!.type : null } })
}

function emitList(tools: CommandTools, list: Pick<PicklistRow, 'id' | 'code' | 'companyId'>, change: (typeof PICKLIST_CHANGES)[number], values: readonly string[]): void {
  tools.emit({ type: 'picklist.changed', subject: list.id, companyId: list.companyId, siteId: null, payload: { picklistId: list.id, code: list.code, change, values: [...values] } })
}

const auditedField = (field: Pick<FieldRow, 'code' | 'type' | 'labelIt' | 'labelEn' | 'section' | 'sortOrder' | 'required' | 'unit' | 'audience' | 'grain' | 'shownInPortal' | 'status'>) => ({
  code: field.code,
  type: field.type,
  labelIt: field.labelIt,
  labelEn: field.labelEn,
  section: field.section,
  sortOrder: field.sortOrder,
  required: field.required,
  unit: field.unit,
  audience: field.audience,
  grain: field.grain,
  shownInPortal: field.shownInPortal,
  status: field.status,
})

/** The list a select field picks from: active, of the field's company or every company's (a field of every company: every company's). */
async function listProblem(client: Client, picklistId: string, companyId: string | null): Promise<string | null> {
  const list = await client.picklist.findUnique({ where: { id: picklistId }, select: { companyId: true, status: true } })
  if (!list) return 'The list was not found.'
  if (list.status !== 'ACTIVE') return 'The list is archived: restore it first.'
  if (list.companyId !== null && list.companyId !== companyId) return companyId === null ? "A field of every company picks from a list of every company." : 'The list belongs to another company.'
  return null
}

/** fields.createField: a field added to a record type (POST /fields). */
export async function createField(caller: CommandCaller, body: CreateFieldBody, idempotencyKey?: string): Promise<FieldView> {
  const who = actor(caller)
  const record = recordOf(body.recordType)
  const companyId = body.companyId ?? null
  keepOrRefuse(who, companyId)
  const linkTo = body.linkTo ? recordOf(body.linkTo).model : null
  const draft: FieldDraft = { ...body, unit: body.unit ?? null, grain: body.grain ?? null, picklistId: body.picklistId ?? null, linkTo }
  const problems = fieldProblems(draft)
  if (problems.length > 0) throw new ValidationError('The field is not valid.', prefixed(problems))
  const audience = body.audience ?? (body.type === 'MONEY' ? 'MONEY' : 'INTERNAL')
  const facts: FieldFacts = { code: body.code, type: body.type, audience, grain: body.grain ?? null, shownInPortal: body.shownInPortal ?? false }
  const refusal = visibilityRefusal(who, null, facts)
  if (refusal) throw new ForbiddenError(refusal)
  const taken = () => new DomainError('conflict', `The ${record.labelEn.toLowerCase()} already has a field ${body.code} (archived fields keep their code: restore it instead).`, [{ path: 'body/code', message: 'taken' }])
  try {
    const { result } = await command(caller, { name: 'fields.createField', idempotencyKey, input: body }, async (tools) =>
      saidInWords(async () => {
        if (await tools.tx.customField.findFirst({ where: { recordType: record.model, code: body.code }, select: { id: true } })) throw taken()
        if (body.picklistId) {
          const problem = await listProblem(tools.tx, body.picklistId, companyId)
          if (problem) throw new DomainError('conflict', problem, [{ path: 'body/picklistId', message: problem }])
        }
        const active = await tools.tx.customField.findMany({ where: { recordType: record.model, status: 'ACTIVE' }, select: { section: true, sortOrder: true } })
        if (active.length >= FIELD_LIMITS.perRecordType) throw new DomainError('conflict', `A record type keeps at most ${FIELD_LIMITS.perRecordType} active fields: archive one first.`, [{ path: 'body/recordType', message: 'full' }])
        const section = body.section ?? 'custom'
        const row = await tools.tx.customField.create({
          data: {
            id: newId(),
            companyId,
            recordType: record.model,
            code: body.code,
            key: `field:${record.model}:${body.code}`,
            type: body.type,
            labelIt: body.labelIt.trim(),
            labelEn: body.labelEn.trim(),
            section,
            sortOrder: body.sortOrder ?? nextPlace(active.filter((field) => field.section === section).map((field) => field.sortOrder)),
            required: body.required ?? false,
            unit: body.unit?.trim() ?? null,
            audience,
            grain: body.grain ?? null,
            shownInPortal: body.shownInPortal ?? false,
            picklistId: body.picklistId ?? null,
            linkTo,
            createdById: createdBy(tools.context),
          },
        })
        const field = (await fieldById(tools.tx, row.id))!
        tools.audit({ recordType: 'CustomField', recordId: row.id, companyId, after: { recordType: record.model, ...auditedField(field), picklistId: field.picklistId, linkTo } })
        emitField(tools, record.model, 'CREATED', [field])
        return fieldViewOf(field)
      }),
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw taken()
    throw error
  }
}

/** fields.editField | archiveField | restoreField: one field's labels, place, rules, who sees it, or its state (PATCH /fields/:id). */
export async function editField(caller: CommandCaller, fieldId: string, body: EditFieldBody, idempotencyKey?: string): Promise<FieldView> {
  const who = actor(caller)
  const found = await caller.withClient((client) => fieldById(client, fieldId))
  if (!found) throw new NotFoundError('The field was not found.')
  keepOrRefuse(who, found.companyId)
  const { version, status, ...change } = body
  const problems = fieldProblems(change, found)
  if (problems.length > 0) throw new ValidationError('The field is not valid.', prefixed(problems))
  if (change.audience !== undefined || change.grain !== undefined || change.shownInPortal !== undefined) {
    const refusal = visibilityRefusal(who, found, factsAfter(found, change))
    if (refusal) throw new ForbiddenError(refusal)
  }
  const name = status === 'ARCHIVED' && found.status === 'ACTIVE' ? 'fields.archiveField' : status === 'ACTIVE' && found.status === 'ARCHIVED' ? 'fields.restoreField' : 'fields.editField'
  const { result } = await command(caller, { name, idempotencyKey, input: { fieldId, ...body }, record: { type: 'CustomField', id: fieldId, expectedVersion: version } }, async (tools) =>
    saidInWords(async () => {
      const before = (await fieldById(tools.tx, fieldId))!
      if (status === 'ACTIVE' && before.status === 'ARCHIVED') {
        if (before.picklistId) {
          const problem = await listProblem(tools.tx, before.picklistId, before.companyId)
          if (problem) throw new DomainError('conflict', problem, [{ path: 'body/status', message: problem }])
        }
        if ((await tools.tx.customField.count({ where: { recordType: before.recordType, status: 'ACTIVE' } })) >= FIELD_LIMITS.perRecordType) {
          throw new DomainError('conflict', `A record type keeps at most ${FIELD_LIMITS.perRecordType} active fields: archive one first.`, [{ path: 'body/status', message: 'full' }])
        }
      }
      const audience = change.audience ?? before.audience
      await tools.tx.customField.update({
        where: { id: fieldId },
        data: {
          ...(change.labelIt === undefined ? {} : { labelIt: change.labelIt.trim() }),
          ...(change.labelEn === undefined ? {} : { labelEn: change.labelEn.trim() }),
          ...(change.section === undefined ? {} : { section: change.section }),
          ...(change.sortOrder === undefined ? {} : { sortOrder: change.sortOrder }),
          ...(change.required === undefined ? {} : { required: change.required }),
          ...(change.unit === undefined ? {} : { unit: change.unit === null ? null : change.unit.trim() }),
          ...(change.audience === undefined ? {} : { audience }),
          ...(change.grain === undefined && change.audience === undefined ? {} : { grain: audience === 'MONEY' ? (change.grain === undefined ? before.grain : change.grain) : null }),
          ...(change.shownInPortal === undefined ? {} : { shownInPortal: change.shownInPortal }),
          ...(status === undefined ? {} : { status }),
        },
      })
      const after = (await fieldById(tools.tx, fieldId))!
      tools.audit({ recordType: 'CustomField', recordId: fieldId, companyId: after.companyId, before: auditedField(before), after: auditedField(after) })
      const moved = before.status !== after.status
      emitField(tools, after.recordType, moved ? (after.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED', [after])
      return fieldViewOf(after)
    }),
  )
  return result
}

function staleAt(path: string, what: string): DomainError {
  return new DomainError('conflict', `${what} changed since it was read: reload and try again.`, [{ path, message: 'changed since it was read' }])
}

/** fields.orderFields: the order of the active fields of one section of a record type (POST /fields/order). */
export async function orderFields(caller: CommandCaller, body: { recordType: CustomRecordKey; section: string; fields: readonly { id: string; version: number }[] }, idempotencyKey?: string): Promise<{ fields: FieldView[] }> {
  const who = actor(caller)
  const record = recordOf(body.recordType)
  const { result } = await command(caller, { name: 'fields.orderFields', idempotencyKey, input: body }, async (tools) =>
    saidInWords(async () => {
      const group = (await fieldsOfModel(tools.tx, record.model)).filter((field) => field.section === body.section)
      for (const field of group) keepOrRefuse(who, field.companyId)
      const problems = orderProblems(group.map((field) => field.id), body.fields.map((entry) => entry.id))
      if (problems.length > 0) throw new ValidationError('The order does not name every field of the section once.', problems.map((problem) => ({ path: `body/fields${problem.path.replace(/^ids/, '')}`, message: problem.message })))
      const places = placesOf(body.fields.map((entry) => entry.id))
      const byId = new Map(group.map((field) => [field.id, field]))
      const moved: FieldRow[] = []
      for (const [index, sent] of body.fields.entries()) {
        const field = byId.get(sent.id)!
        if (field.version !== sent.version) throw staleAt(`body/fields/${index}/version`, `The field ${field.code}`)
        const sortOrder = places.get(sent.id)!
        if (field.sortOrder === sortOrder) continue
        const { count } = await tools.tx.customField.updateMany({ where: { id: field.id, version: field.version }, data: { sortOrder, version: { increment: 1 } } })
        if (count !== 1) throw staleAt(`body/fields/${index}/version`, `The field ${field.code}`)
        tools.audit({ recordType: 'CustomField', recordId: field.id, companyId: field.companyId, before: { sortOrder: field.sortOrder }, after: { sortOrder, code: field.code } })
        moved.push(field)
      }
      if (moved.length > 0) emitField(tools, record.model, 'REORDERED', group)
      else tools.audit({ recordType: 'Tenant', recordId: tenantOf(tools), companyId: null, after: { recordType: record.model, section: body.section, reordered: 0 } })
      return { fields: (await fieldsOfModel(tools.tx, record.model)).filter((field) => field.section === body.section).map(fieldViewOf) }
    }),
  )
  return result
}

// ---- picklists ----------------------------------------------------------------------------------------------------------

/** fields.createPicklist (POST /fields/picklists). */
export async function createPicklist(caller: CommandCaller, body: { companyId?: string | null | undefined; code: string; labelIt: string; labelEn: string }, idempotencyKey?: string): Promise<PicklistView> {
  const who = actor(caller)
  const companyId = body.companyId ?? null
  keepOrRefuse(who, companyId)
  const problems = picklistProblems(body, true)
  if (problems.length > 0) throw new ValidationError('The list is not valid.', prefixed(problems))
  const taken = () => new DomainError('conflict', `There is already a list ${body.code}.`, [{ path: 'body/code', message: 'taken' }])
  try {
    const { result } = await command(caller, { name: 'fields.createPicklist', idempotencyKey, input: body }, async (tools) =>
      saidInWords(async () => {
        if (await tools.tx.picklist.findFirst({ where: { code: body.code }, select: { id: true } })) throw taken()
        const row = await tools.tx.picklist.create({ data: { id: newId(), companyId, code: body.code, key: `picklist:${body.code}`, labelIt: body.labelIt.trim(), labelEn: body.labelEn.trim(), createdById: createdBy(tools.context) } })
        tools.audit({ recordType: 'Picklist', recordId: row.id, companyId, after: { code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, status: row.status } })
        emitList(tools, row, 'CREATED', [])
        return picklistView(tools.tx, row.id)
      }),
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw taken()
    throw error
  }
}

async function listOrRefuse(caller: CommandCaller, picklistId: string): Promise<PicklistRow> {
  const list = (await caller.withClient((client) => picklistsOf(client, { id: picklistId })))[0]
  if (!list) throw new NotFoundError('The list was not found.')
  keepOrRefuse(actor(caller), list.companyId)
  return list
}

/** fields.editPicklist | archivePicklist | restorePicklist (PATCH /fields/picklists/:id). */
export async function editPicklist(caller: CommandCaller, picklistId: string, body: { version: number; labelIt?: string | undefined; labelEn?: string | undefined; status?: 'ACTIVE' | 'ARCHIVED' | undefined }, idempotencyKey?: string): Promise<PicklistView> {
  const found = await listOrRefuse(caller, picklistId)
  const problems = picklistProblems(body, false)
  if (problems.length > 0) throw new ValidationError('The list is not valid.', prefixed(problems))
  const archiving = body.status === 'ARCHIVED' && found.status === 'ACTIVE'
  const restoring = body.status === 'ACTIVE' && found.status === 'ARCHIVED'
  const { result } = await command(caller, { name: archiving ? 'fields.archivePicklist' : restoring ? 'fields.restorePicklist' : 'fields.editPicklist', idempotencyKey, input: { picklistId, ...body }, record: { type: 'Picklist', id: picklistId, expectedVersion: body.version } }, async (tools) =>
    saidInWords(async () => {
      if (archiving) {
        const using = await tools.tx.customField.findMany({ where: { picklistId, status: 'ACTIVE' }, select: { code: true, recordType: true } })
        if (using.length > 0) throw new DomainError('conflict', `Fields still pick from this list (${using.map((field) => field.code).join(', ')}): archive them first.`, [{ path: 'body/status', message: 'in use' }])
      }
      const row = await tools.tx.picklist.update({ where: { id: picklistId }, data: { ...(body.labelIt === undefined ? {} : { labelIt: body.labelIt.trim() }), ...(body.labelEn === undefined ? {} : { labelEn: body.labelEn.trim() }), ...(body.status === undefined ? {} : { status: body.status }) } })
      tools.audit({ recordType: 'Picklist', recordId: picklistId, companyId: row.companyId, before: { labelIt: found.labelIt, labelEn: found.labelEn, status: found.status }, after: { labelIt: row.labelIt, labelEn: row.labelEn, status: row.status } })
      emitList(tools, row, archiving ? 'ARCHIVED' : restoring ? 'RESTORED' : 'EDITED', [])
      return picklistView(tools.tx, picklistId)
    }),
  )
  return result
}

/** fields.addPicklistValue: a value at the end of an active list (POST /fields/picklists/:id/values). */
export async function addOption(caller: CommandCaller, picklistId: string, body: { code: string; labelIt: string; labelEn: string; colour?: string | null | undefined; icon?: string | null | undefined; description?: string | null | undefined }, idempotencyKey?: string): Promise<PicklistView> {
  const list = await listOrRefuse(caller, picklistId)
  const problems = optionProblems(body, true)
  if (problems.length > 0) throw new ValidationError('The value is not valid.', prefixed(problems))
  const taken = (active: boolean) => new DomainError('conflict', active ? `The list already has the value ${body.code}.` : `The list already has the value ${body.code}, deactivated: activate it again instead.`, [{ path: 'body/code', message: active ? 'taken' : 'taken, inactive' }])
  try {
    const { result } = await command(caller, { name: 'fields.addPicklistValue', idempotencyKey, input: { picklistId, ...body } }, async (tools) =>
      saidInWords(async () => {
        const current = (await picklistsOf(tools.tx, { id: picklistId }))[0]!
        if (current.status !== 'ACTIVE') throw new DomainError('conflict', 'The list is archived: restore it before adding values.', [{ path: 'refusal/ARCHIVED', message: 'archived' }])
        const same = current.options.find((option) => option.code === body.code)
        if (same) throw taken(same.active)
        if (current.options.length >= FIELD_LIMITS.perList) throw new DomainError('conflict', `A list keeps at most ${FIELD_LIMITS.perList} values.`, [{ path: 'body/code', message: 'full' }])
        const row = await tools.tx.picklistValue.create({
          data: { id: newId(), picklistId, code: body.code, key: `option:${picklistId}:${body.code}`, labelIt: body.labelIt.trim(), labelEn: body.labelEn.trim(), colour: body.colour ? body.colour.toLowerCase() : null, icon: body.icon ?? null, description: body.description?.trim() || null, sortOrder: nextPlace(current.options.map((option) => option.sortOrder)), createdById: createdBy(tools.context) },
        })
        tools.audit({ recordType: 'PicklistValue', recordId: row.id, companyId: list.companyId, after: { list: list.code, code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, colour: row.colour, icon: row.icon, description: row.description, sortOrder: row.sortOrder, active: row.active } })
        emitList(tools, list, 'VALUES_ADDED', [row.code])
        return picklistView(tools.tx, picklistId)
      }),
    )
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw taken(true)
    throw error
  }
}

/** fields.editPicklistValue | deactivate | activate: one value's cells at the version read (PATCH …/values/:valueId). */
export async function editOption(caller: CommandCaller, picklistId: string, valueId: string, body: { version: number; labelIt?: string | undefined; labelEn?: string | undefined; colour?: string | null | undefined; icon?: string | null | undefined; description?: string | null | undefined; active?: boolean | undefined }, idempotencyKey?: string): Promise<PicklistView> {
  const list = await listOrRefuse(caller, picklistId)
  const before = list.options.find((option) => option.id === valueId)
  if (!before) throw new NotFoundError('The value was not found in this list.')
  const { version, active, ...cells } = body
  const problems = optionProblems(cells, false)
  if (problems.length > 0) throw new ValidationError('The value is not valid.', prefixed(problems))
  const onlyActive = Object.values(cells).every((value) => value === undefined)
  const name = active === false && before.active ? 'fields.deactivatePicklistValue' : active === true && !before.active ? 'fields.activatePicklistValue' : 'fields.editPicklistValue'
  const { result } = await command(caller, { name, idempotencyKey, input: { picklistId, valueId, ...body }, record: { type: 'PicklistValue', id: valueId, expectedVersion: version } }, async (tools) =>
    saidInWords(async () => {
      const row = await tools.tx.picklistValue.update({
        where: { id: valueId },
        data: {
          ...(cells.labelIt === undefined ? {} : { labelIt: cells.labelIt.trim() }),
          ...(cells.labelEn === undefined ? {} : { labelEn: cells.labelEn.trim() }),
          ...(cells.colour === undefined ? {} : { colour: cells.colour === null ? null : cells.colour.toLowerCase() }),
          ...(cells.icon === undefined ? {} : { icon: cells.icon }),
          ...(cells.description === undefined ? {} : { description: cells.description?.trim() || null }),
          ...(active === undefined ? {} : { active }),
        },
      })
      const audited = (value: { labelIt: string; labelEn: string; colour: string | null; icon: string | null; description: string | null; active: boolean }) => ({ labelIt: value.labelIt, labelEn: value.labelEn, colour: value.colour, icon: value.icon, description: value.description, active: value.active })
      tools.audit({ recordType: 'PicklistValue', recordId: valueId, companyId: list.companyId, before: { list: list.code, code: before.code, ...audited(before) }, after: { list: list.code, code: row.code, ...audited(row) } })
      const moved = active !== undefined && active !== before.active
      emitList(tools, list, moved && onlyActive ? (active ? 'VALUES_ACTIVATED' : 'VALUES_DEACTIVATED') : 'VALUES_EDITED', [row.code])
      return picklistView(tools.tx, picklistId)
    }),
  )
  return result
}

/** fields.orderPicklistValues: the list's order, every value named once at the version read (POST …/order). */
export async function orderOptions(caller: CommandCaller, picklistId: string, body: { values: readonly { id: string; version: number }[] }, idempotencyKey?: string): Promise<PicklistView> {
  const list = await listOrRefuse(caller, picklistId)
  const { result } = await command(caller, { name: 'fields.orderPicklistValues', idempotencyKey, input: { picklistId, ...body } }, async (tools) =>
    saidInWords(async () => {
      const current = (await picklistsOf(tools.tx, { id: picklistId }))[0]!
      const problems = orderProblems(current.options.map((option) => option.id), body.values.map((entry) => entry.id))
      if (problems.length > 0) throw new ValidationError('The order does not name every value of the list once.', problems.map((problem) => ({ path: `body/values${problem.path.replace(/^ids/, '')}`, message: problem.message })))
      const places = placesOf(body.values.map((entry) => entry.id))
      const byId = new Map(current.options.map((option) => [option.id, option]))
      let moved = 0
      for (const [index, sent] of body.values.entries()) {
        const option = byId.get(sent.id)!
        if (option.version !== sent.version) throw staleAt(`body/values/${index}/version`, `The value ${option.code}`)
        const sortOrder = places.get(sent.id)!
        if (option.sortOrder === sortOrder) continue
        const { count } = await tools.tx.picklistValue.updateMany({ where: { id: option.id, version: option.version }, data: { sortOrder, version: { increment: 1 } } })
        if (count !== 1) throw staleAt(`body/values/${index}/version`, `The value ${option.code}`)
        tools.audit({ recordType: 'PicklistValue', recordId: option.id, companyId: list.companyId, before: { sortOrder: option.sortOrder }, after: { sortOrder, code: option.code, list: list.code } })
        moved++
      }
      if (moved > 0) emitList(tools, list, 'VALUES_REORDERED', body.values.map((entry) => byId.get(entry.id)!.code))
      else tools.audit({ recordType: 'Tenant', recordId: tenantOf(tools), companyId: null, after: { list: list.code, reordered: 0 } })
      return picklistView(tools.tx, picklistId)
    }),
  )
  return result
}

// ---- a record's values --------------------------------------------------------------------------------------------------

/** GET /fields?recordType=ORDER[&companyId=]: the active fields this person sees on a record type (its view permission). */
export async function fieldsFor(caller: CommandCaller, query: { recordType: CustomRecordKey; companyId?: string | undefined }) {
  const who = actor(caller)
  const record = recordOf(query.recordType)
  if (!holds(who, record.view)) throw new ForbiddenError(`Reading the custom fields of ${aRecord(record)} needs ${record.view}.`)
  return caller.withClient(async (client) => ({ recordType: record.key, fields: fieldsSeen(who, await fieldsOfModel(client, record.model), query.companyId).map(fieldViewOf) }))
}

/** The record (404 when it is not one the person may see) and the person's rights on it. */
async function recordFor(client: Client, who: Actor, record: CustomRecord, recordId: string): Promise<RecordFacts> {
  if (!holds(who, record.view)) throw new ForbiddenError(`Reading the custom fields of ${aRecord(record)} needs ${record.view}.`)
  const facts = (await recordFactsOf(client, record.model, [recordId])).get(recordId)
  if (!facts || !can(who, record.view, facts)) throw new NotFoundError(`${record.labelEn} not found.`)
  return facts
}

async function recordAnswer(client: Client, who: Actor, record: CustomRecord, facts: RecordFacts) {
  const fields = fieldsSeen(who, await fieldsOfModel(client, record.model), facts.companyId)
  const values = (await valuesOfRecords(client, record.model, [facts.id], fields.map((field) => field.id))).get(facts.id) ?? new Map<string, ValueRow>()
  const references = await referenceWords(client, who, fields, values.values())
  return { recordType: record.key, recordId: facts.id, fields: fields.map(fieldViewOf), values: valueViewsOf(fields, values, references), canEdit: can(who, record.edit, facts) }
}

/** GET /fields/values/:recordType/:recordId: the record's custom-fields section (the record's view permission). */
export async function recordValues(caller: CommandCaller, recordType: CustomRecordKey, recordId: string) {
  const who = actor(caller)
  const record = recordOf(recordType)
  return caller.withClient(async (client) => recordAnswer(client, who, record, await recordFor(client, who, record, recordId)))
}

/** fields.setValues: set or clear custom values of one record (PUT /fields/values/:recordType/:recordId; the record's edit permission). */
export async function writeValues(caller: CommandCaller, recordType: CustomRecordKey, recordId: string, body: WriteValuesBody, idempotencyKey?: string) {
  const who = actor(caller)
  const record = recordOf(recordType)
  const facts = await caller.withClient((client) => recordFor(client, who, record, recordId))
  if (!can(who, record.edit, facts)) throw new ForbiddenError(`Changing the custom fields of ${aRecord(record)} needs ${record.edit} over it.`)
  const { result } = await command(caller, { name: 'fields.setValues', idempotencyKey, input: { recordType, recordId, values: body.values } }, async (tools) =>
    saidInWords(async () => {
      const written = await writeValuesInCommand(tools, record, facts, body.values.map((entry) => ({ code: entry.code, value: entry.value ?? null, version: entry.version })), who, actorIdOf(tools.context))
      if (written.set.length === 0 && written.cleared.length === 0) tools.audit({ recordType: record.model, recordId, companyId: facts.companyId, after: { values: 0 } })
      return { ...(await recordAnswer(tools.tx, who, record, facts)), ...written }
    }),
  )
  return result
}

/** POST /fields/rows/:recordType {ids}: a grid page's custom values, only rows this person may see. */
export async function rowValues(caller: CommandCaller, recordType: CustomRecordKey, ids: readonly string[]) {
  const who = actor(caller)
  const record = recordOf(recordType)
  if (!holds(who, record.view)) throw new ForbiddenError(`Reading the custom fields of ${aRecord(record)} needs ${record.view}.`)
  return caller.withClient(async (client) => {
    const facts = [...(await recordFactsOf(client, record.model, ids)).values()].filter((row) => can(who, record.view, row))
    const fields = fieldsSeen(who, await fieldsOfModel(client, record.model))
    const values = await valuesOfRecords(client, record.model, facts.map((row) => row.id), fields.map((field) => field.id))
    const references = await referenceWords(client, who, fields, [...values.values()].flatMap((byField) => [...byField.values()]))
    const order = new Map(ids.map((id, index) => [id, index]))
    return {
      recordType: record.key,
      fields: fields.map(fieldViewOf),
      rows: facts
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
        .map((row) => {
          const own = values.get(row.id) ?? new Map<string, ValueRow>()
          const entries = fields.filter((field) => own.has(field.id) && (field.companyId === null || row.companyId === null || field.companyId === row.companyId)).map((field) => [field.code, { value: markedValue(field, own.get(field.id)!.value), ...wordsOf(field, own.get(field.id)!.value, references) }] as const)
          return { id: row.id, values: Object.fromEntries(entries) }
        }),
    }
  })
}

/**
 * GET /fields/portal/:recordType/:recordId (a partner): the fields shown in the portal on the party's OWN record (its
 * order, quote or purchase order, or the party itself), read in the tenant's system scope — the database gives a partner
 * no grant on custom fields — and filtered for the partner (a price only with the price grain).
 */
export async function portalValues(request: FastifyRequest, recordType: CustomRecordKey, recordId: string) {
  const context = contextOf(request)
  if (context.audience !== 'partner') throw new ForbiddenError()
  const record = recordOf(recordType)
  if (!record.portal) throw new NotFoundError(`${record.labelEn} not found.`)
  const who = actorOf(context)
  const system = systemCallerOf(request)(context.tenantId)
  return system.withClient(async (client) => {
    const facts = (await recordFactsOf(client, record.model, [recordId])).get(recordId)
    if (!facts || facts.partyId !== context.partyId) throw new NotFoundError(`${record.labelEn} not found.`)
    const fields = fieldsSeen(who, await fieldsOfModel(client, record.model), facts.companyId)
    const values = (await valuesOfRecords(client, record.model, [facts.id], fields.map((field) => field.id))).get(facts.id) ?? new Map<string, ValueRow>()
    const references = await referenceWords(client, who, fields, values.values())
    return { recordType: record.key, recordId: facts.id, fields: fields.map(fieldViewOf), values: valueViewsOf(fields, values, references) }
  })
}

