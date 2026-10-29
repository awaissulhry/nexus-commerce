import type { Prisma } from '@nexus/factory-db'
import { LABELS_VIEW } from '@nexus/factory-domain/compliance/labels/permissions'
import { activationProblems } from '@nexus/factory-domain/compliance/labels/render'
import {
  DEFAULT_LAYOUT,
  defaultLabelCode,
  frozenMessage,
  isLabelEditable,
  LABEL_CODE,
  LABEL_CODE_RULE,
  labelTemplateMachine,
  type CareEntry,
  type CompositionPart,
  type LabelLayout,
  type LabelTemplateStatus,
} from '@nexus/factory-domain/compliance/labels/rules'
import { ConflictError, DomainError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readMaker } from '../../product/compliance/read'
import type { TemplateDetail, TemplateView } from './contract'
import {
  assertMayManage,
  draftProblems,
  factsOf,
  findStyle,
  labelCommand,
  labelStyleOf,
  LABEL_SCOPE,
  officeOf,
  readTemplate,
  readVisibleStyle,
  TEMPLATE_SELECT,
  templateDetail,
  templateView,
  todayOf,
  type StyleRow,
  type TemplateRow,
} from './store'

/**
 * Garment label templates (B-W1-19; PRD-331; A2 SCR-053), office side: list and read them, build one as a DRAFT (from
 * nothing, or from another template's content), edit the draft, activate it when it has no problem left (it is frozen
 * from then on, for every login: the …_product_guards trigger), retire it, and start the next revision of a code from
 * any of its revisions. Every write is one command() with its audit row and its event (compliance/events.ts).
 *
 * Lock order: a template's writes take its row (command()'s record guard); a new revision takes the code's advisory lock
 * first (`factory.label-code`), so two new revisions of one code wait for each other and the second sees the first's
 * draft. A draft style revision names a template in assign.ts (the style first, then the revision).
 */

/** What the audit rows record of a template (its typed content and status). */
const audited = (row: TemplateRow) => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, version: _version, ...rest } = row
  return { ...rest, widthMm: row.widthMm.toFixed(2), heightMm: row.heightMm.toFixed(2) }
}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const invalid = (issues: Issue[]) => new ValidationError('The label is not valid.', issues)

async function lockCode(tx: CommandTx, tenantId: string, code: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.label-code', ${tenantId}::uuid, ${code}::text), 0))`
}

// ---- reads ------------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly status?: LabelTemplateStatus | undefined
  readonly styleId?: string | undefined
  readonly code?: string | undefined
}

/** SCR-053's list: the templates the caller may view, by code and revision. */
export async function listTemplates(caller: CommandCaller, query: ListQuery): Promise<{ templates: TemplateView[]; today: string }> {
  const context = officeOf(caller)
  const today = todayOf()
  const where: Prisma.LabelTemplateWhereInput = {
    AND: [
      scopeWhere(actorOf(context), LABELS_VIEW, LABEL_SCOPE) as Prisma.LabelTemplateWhereInput,
      query.status ? { status: query.status } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.code ? { code: query.code.toUpperCase() } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.labelTemplate.findMany({ where, select: TEMPLATE_SELECT, orderBy: [{ code: 'asc' }, { revision: 'asc' }], take: 500 })
    const styleIds = [...new Set(rows.flatMap((row) => (row.styleId ? [row.styleId] : [])))]
    const styles = new Map<string, StyleRow>()
    for (const styleId of styleIds) {
      const style = await findStyle(client, styleId)
      if (style) styles.set(styleId, style)
    }
    return { templates: rows.map((row) => templateView(row, row.styleId ? (styles.get(row.styleId) ?? null) : null, today)), today }
  })
}

export async function getTemplate(caller: CommandCaller, templateId: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  await readTemplate(caller, templateId)
  return caller.withClient((client) => templateDetail(client, context, templateId, todayOf()))
}

// ---- the content a body sends ------------------------------------------------------------------------------------------------

export interface ContentInput {
  readonly name?: string | undefined
  readonly languages?: readonly string[] | undefined
  readonly makerPartyId?: string | null | undefined
  readonly makerName?: string | undefined
  readonly makerAddress?: string | undefined
  readonly importerName?: string | null | undefined
  readonly importerAddress?: string | null | undefined
  readonly composition?: readonly CompositionPart[] | undefined
  readonly animalOriginPhrase?: boolean | undefined
  readonly care?: readonly CareEntry[] | undefined
  readonly layout?: LabelLayout | undefined
  readonly widthMm?: string | undefined
  readonly heightMm?: string | undefined
}

/** The columns a template's content is stored in. */
interface Content {
  name: string
  languages: string[]
  makerPartyId: string | null
  makerName: string
  makerAddress: string
  importerName: string | null
  importerAddress: string | null
  composition: CompositionPart[]
  animalOriginPhrase: boolean
  care: CareEntry[]
  layout: LabelLayout
  widthMm: string
  heightMm: string
}

const contentOf = (row: TemplateRow): Content => {
  const facts = factsOf(row)
  return {
    name: facts.name,
    languages: [...facts.languages],
    makerPartyId: facts.makerPartyId,
    makerName: facts.makerName,
    makerAddress: facts.makerAddress,
    importerName: facts.importerName,
    importerAddress: facts.importerAddress,
    composition: [...facts.composition],
    animalOriginPhrase: facts.animalOriginPhrase,
    care: [...facts.care],
    layout: facts.layout,
    widthMm: facts.widthMm,
    heightMm: facts.heightMm,
  }
}

/** A field left out keeps its value; null clears an optional one. Text is trimmed, an empty importer is none. */
function merged(base: Content, input: ContentInput): Content {
  const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value)
  const optional = (value: string | null | undefined, fallback: string | null): string | null => (value === undefined ? fallback : value?.trim() || null)
  return {
    name: pick(input.name, base.name).trim(),
    languages: [...pick(input.languages, base.languages)],
    makerPartyId: input.makerPartyId === undefined ? base.makerPartyId : input.makerPartyId,
    makerName: pick(input.makerName, base.makerName).trim(),
    makerAddress: pick(input.makerAddress, base.makerAddress).trim(),
    importerName: optional(input.importerName, base.importerName),
    importerAddress: optional(input.importerAddress, base.importerAddress),
    composition: [...pick(input.composition, base.composition)],
    animalOriginPhrase: pick(input.animalOriginPhrase, base.animalOriginPhrase),
    care: [...pick(input.care, base.care)],
    layout: pick(input.layout, base.layout),
    widthMm: pick(input.widthMm, base.widthMm),
    heightMm: pick(input.heightMm, base.heightMm),
  }
}

const columns = (content: Content) => ({
  name: content.name,
  languages: content.languages,
  makerPartyId: content.makerPartyId,
  makerName: content.makerName,
  makerAddress: content.makerAddress,
  importerName: content.importerName,
  importerAddress: content.importerAddress,
  composition: content.composition as unknown as Prisma.InputJsonValue,
  animalOriginPhrase: content.animalOriginPhrase,
  care: content.care as unknown as Prisma.InputJsonValue,
  layout: content.layout as unknown as Prisma.InputJsonValue,
  widthMm: content.widthMm,
  heightMm: content.heightMm,
})

/** The references a body names: the maker party, the company, the style (each of the tenant and visible). */
async function checkReferences(caller: CommandCaller, refs: { makerPartyId: string | null; companyId: string | null; style: StyleRow | null }): Promise<void> {
  const problems: Issue[] = []
  await caller.withClient(async (client) => {
    if (refs.makerPartyId && !(await client.party.findUnique({ where: { id: refs.makerPartyId }, select: { id: true } }))) {
      problems.push({ path: 'body/makerPartyId', message: 'Not a party of the tenant.' })
    }
    if (refs.companyId && !(await client.company.findUnique({ where: { id: refs.companyId }, select: { id: true } }))) {
      problems.push({ path: 'body/companyId', message: 'Not a company of the tenant.' })
    }
  })
  if (refs.style && refs.companyId !== refs.style.companyId) {
    problems.push({ path: 'body/companyId', message: `Style ${refs.style.code} belongs to ${refs.style.companyId === null ? 'every company' : 'one company'}: its own label belongs to the same.` })
  }
  if (problems.length > 0) throw invalid(problems)
}

const NEW_DEFAULTS: Omit<Content, 'name' | 'makerPartyId' | 'makerName' | 'makerAddress'> = {
  languages: ['it', 'en'],
  importerName: null,
  importerAddress: null,
  composition: [],
  animalOriginPhrase: false,
  care: [],
  layout: DEFAULT_LAYOUT,
  widthMm: '50.00',
  heightMm: '80.00',
}

// ---- create, edit -------------------------------------------------------------------------------------------------------------

export interface CreateInput extends ContentInput {
  readonly code?: string | undefined
  readonly styleId?: string | null | undefined
  readonly companyId?: string | null | undefined
  readonly fromTemplateId?: string | undefined
}

/**
 * compliance.labels.create: revision 1 of a new code, DRAFT. The content comes from the body, over the template it starts
 * from (any revision the caller may view) or over the defaults (languages it, en; 50 × 80 mm; the standard layout; the
 * legal maker of the style: its brand's registered office, else its company's address).
 */
export async function createTemplate(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const style = input.styleId ? await caller.withClient((client) => readVisibleStyle(client, context, input.styleId!)) : null
  const companyId = input.companyId === undefined ? (style?.companyId ?? null) : input.companyId
  assertMayManage(context, companyId)
  const code = (input.code?.trim().toUpperCase() || (style ? defaultLabelCode(style.code) : '')).trim()
  if (code === '') throw invalid([{ path: 'body/code', message: 'Give a shared label a code (a style label is named after its style).' }])
  if (!LABEL_CODE.test(code)) throw invalid([{ path: 'body/code', message: `Expected ${LABEL_CODE_RULE}.` }])

  const source = input.fromTemplateId ? await readTemplate(caller, input.fromTemplateId) : null
  let base: Content
  if (source) base = contentOf(source)
  else {
    const maker = await caller.withClient((client) => readMaker(client, { brandPartyId: style?.brandPartyId ?? null, companyId }, null))
    base = {
      ...NEW_DEFAULTS,
      name: style ? `${style.name} garment label` : '',
      makerPartyId: maker?.makerPartyId ?? null,
      makerName: maker?.makerName ?? '',
      makerAddress: maker?.makerAddress ?? '',
    }
  }
  const content = merged(base, input)
  if (content.name === '') throw invalid([{ path: 'body/name', message: 'Give the label a name.' }])
  await checkReferences(caller, { makerPartyId: content.makerPartyId, companyId, style })

  try {
    const { result } = await labelCommand(caller, { name: 'compliance.labels.create', idempotencyKey, input }, async ({ tx, audit, emit, now }) => {
      await lockCode(tx, context.tenantId, code)
      const taken = await tx.labelTemplate.findFirst({ where: { code }, select: { revision: true }, orderBy: { revision: 'desc' } })
      if (taken) throw new ConflictError(`Label ${code} exists already (revision ${taken.revision}): open it, or start a new revision of it.`)
      const id = newId()
      const row = await tx.labelTemplate.create({
        data: { id, code, revision: 1, companyId, styleId: style?.id ?? null, status: 'DRAFT', ...columns(content), createdAt: now, updatedAt: now, createdById: context.actorId },
        select: TEMPLATE_SELECT,
      })
      audit({ recordType: 'LabelTemplate', recordId: id, companyId, after: { ...audited(row), ...(source ? { from: { id: source.id, code: source.code, revision: source.revision } } : {}) } })
      emit({ type: 'compliance.label_template_saved', subject: id, companyId, payload: { templateId: id, code, revision: 1, styleId: row.styleId, change: 'CREATED', problems: draftProblems(row).length } })
      return templateDetail(tx, context, id, businessDate(now))
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Label ${code} exists already: open it, or start a new revision of it.`)
    throw error
  }
}

export interface UpdateInput extends ContentInput {
  readonly version: number
  readonly styleId?: string | null | undefined
}

/** compliance.labels.update: edits a DRAFT (version-guarded). An active or retired template is frozen: 409. */
export async function updateTemplate(caller: CommandCaller, templateId: string, input: UpdateInput, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const before = await readTemplate(caller, templateId)
  assertMayManage(context, before.companyId)
  if (!isLabelEditable(before.status as LabelTemplateStatus)) throw new InvalidStateError(frozenMessage(before.code, before.revision, before.status as LabelTemplateStatus))
  const styleId = input.styleId === undefined ? before.styleId : input.styleId
  const style = styleId ? await caller.withClient((client) => readVisibleStyle(client, context, styleId)) : null
  const content = merged(contentOf(before), input)
  if (content.name === '') throw invalid([{ path: 'body/name', message: 'Give the label a name.' }])
  await checkReferences(caller, { makerPartyId: content.makerPartyId, companyId: before.companyId, style })

  const { result } = await labelCommand(
    caller,
    { name: 'compliance.labels.update', idempotencyKey, input: { templateId, ...input }, record: { type: 'LabelTemplate', id: templateId, expectedVersion: input.version } },
    async ({ tx, audit, emit, now }) => {
      // The row is locked now: a move that committed meanwhile is seen here (and the trigger would refuse it anyway).
      const locked = await tx.labelTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { status: true, code: true, revision: true } })
      if (!isLabelEditable(locked.status as LabelTemplateStatus)) throw new InvalidStateError(frozenMessage(locked.code, locked.revision, locked.status as LabelTemplateStatus))
      const row = await tx.labelTemplate.update({ where: { id: templateId }, data: { ...columns(content), styleId: style?.id ?? null, updatedAt: now }, select: TEMPLATE_SELECT })
      audit({ recordType: 'LabelTemplate', recordId: templateId, companyId: row.companyId, before: audited(before), after: audited(row) })
      emit({ type: 'compliance.label_template_saved', subject: templateId, companyId: row.companyId, payload: { templateId, code: row.code, revision: row.revision, styleId: row.styleId, change: 'UPDATED', problems: draftProblems(row).length } })
      return templateDetail(tx, context, templateId, businessDate(now))
    },
  )
  return result
}

// ---- activate, retire, revise ---------------------------------------------------------------------------------------------------

/**
 * compliance.labels.activate: DRAFT → ACTIVE, only with no problem left (the content, the style's marking needs, the fit),
 * checked in the command after the row's lock; refused with every problem and its path (409). Frozen from then on.
 */
export async function activateTemplate(caller: CommandCaller, templateId: string, input: { version: number }, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const before = await readTemplate(caller, templateId)
  assertMayManage(context, before.companyId)
  if (before.status !== 'DRAFT') throw new InvalidStateError(`Label ${before.code} r${before.revision} is ${before.status}: only a draft is activated.`)
  const { result } = await labelCommand(
    caller,
    {
      name: 'compliance.labels.activate',
      idempotencyKey,
      input: { templateId, ...input },
      record: { type: 'LabelTemplate', id: templateId, expectedVersion: input.version, transition: { machine: labelTemplateMachine, to: 'ACTIVE' } },
    },
    async ({ tx, audit, emit, now }) => {
      const row = await tx.labelTemplate.findUniqueOrThrow({ where: { id: templateId }, select: TEMPLATE_SELECT })
      // The style FOR SHARE: its classification cannot change under the check.
      if (row.styleId) await tx.$queryRaw`SELECT "id" FROM "Style" WHERE "id" = ${row.styleId}::uuid FOR SHARE`
      const style = await findStyle(tx, row.styleId)
      const problems = activationProblems(factsOf(row), style ? labelStyleOf(style) : null, businessDate(now))
      if (problems.length > 0) {
        throw new DomainError('invalid_state', `Label ${row.code} r${row.revision} cannot be activated yet: ${problems.length} problem(s) to fix first.`, problems)
      }
      audit({ recordType: 'LabelTemplate', recordId: templateId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: row.status } })
      emit({ type: 'compliance.label_template_activated', subject: templateId, companyId: row.companyId, payload: { templateId, code: row.code, revision: row.revision, styleId: row.styleId } })
      return templateDetail(tx, context, templateId, businessDate(now))
    },
  )
  return result
}

/**
 * compliance.labels.retire: DRAFT | ACTIVE → RETIRED. A style revision that names it can no longer release a work order
 * (B-W1-38 labelCheck); released work orders keep it. The answer's usage says which revisions name it.
 */
export async function retireTemplate(caller: CommandCaller, templateId: string, input: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const before = await readTemplate(caller, templateId)
  assertMayManage(context, before.companyId)
  if (before.status === 'RETIRED') throw new InvalidStateError(`Label ${before.code} r${before.revision} is retired already.`)
  const reason = input.reason?.trim() || undefined
  const { result } = await labelCommand(
    caller,
    {
      name: 'compliance.labels.retire',
      idempotencyKey,
      input: { templateId, ...input },
      record: { type: 'LabelTemplate', id: templateId, expectedVersion: input.version, transition: { machine: labelTemplateMachine, to: 'RETIRED' } },
    },
    async ({ tx, audit, emit, now, record }) => {
      const row = await tx.labelTemplate.findUniqueOrThrow({ where: { id: templateId }, select: TEMPLATE_SELECT })
      const releasedRevisions = await tx.styleRevision.count({ where: { labelTemplateId: templateId, status: 'RELEASED' } })
      const previousStatus = record!.from as 'DRAFT' | 'ACTIVE'
      audit({ recordType: 'LabelTemplate', recordId: templateId, companyId: row.companyId, before: { status: previousStatus }, after: { status: row.status, releasedRevisions }, ...(reason ? { reason } : {}) })
      emit({ type: 'compliance.label_template_retired', subject: templateId, companyId: row.companyId, payload: { templateId, code: row.code, revision: row.revision, styleId: row.styleId, previousStatus, releasedRevisions } })
      return templateDetail(tx, context, templateId, businessDate(now))
    },
  )
  return result
}

/**
 * compliance.labels.revise: the next revision of the code, DRAFT, with the content of this one (any status): how an
 * active label is changed. One draft per code at a time: 409 naming it.
 */
export async function reviseTemplate(caller: CommandCaller, templateId: string, idempotencyKey?: string): Promise<TemplateDetail> {
  const context = officeOf(caller)
  const source = await readTemplate(caller, templateId)
  assertMayManage(context, source.companyId)
  const content = contentOf(source)
  try {
    const { result } = await labelCommand(caller, { name: 'compliance.labels.revise', idempotencyKey, input: { templateId } }, async ({ tx, audit, emit, now }) => {
      await lockCode(tx, context.tenantId, source.code)
      const revisions = await tx.labelTemplate.findMany({ where: { code: source.code }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
      const draft = revisions.find((entry) => entry.status === 'DRAFT')
      if (draft) throw new ConflictError(`Label ${source.code} has a draft already: revision ${draft.revision}. Edit it, or retire it first.`)
      const revision = (revisions[0]?.revision ?? 0) + 1
      const id = newId()
      const row = await tx.labelTemplate.create({
        data: { id, code: source.code, revision, companyId: source.companyId, styleId: source.styleId, status: 'DRAFT', ...columns(content), createdAt: now, updatedAt: now, createdById: context.actorId },
        select: TEMPLATE_SELECT,
      })
      audit({ recordType: 'LabelTemplate', recordId: id, companyId: row.companyId, after: { ...audited(row), from: { id: source.id, revision: source.revision } } })
      emit({ type: 'compliance.label_template_saved', subject: id, companyId: row.companyId, payload: { templateId: id, code: row.code, revision, styleId: row.styleId, change: 'NEW_REVISION', problems: draftProblems(row).length } })
      return templateDetail(tx, context, id, businessDate(now))
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`Label ${source.code} got a new revision meanwhile: open its newest revision.`)
    throw error
  }
}
