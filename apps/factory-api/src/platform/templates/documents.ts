import type { Prisma } from '@nexus/factory-db'
import { DOCUMENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type Clock } from '@nexus/factory-domain/core/time'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { attachLayoutTemplates, DOCUMENT_LAYOUTS, layoutFor, MANDATORY_COLUMNS, optionalColumnsOf, type LayoutTemplate } from '@nexus/factory-domain/documents/layouts'
import { sampleDocument } from '@nexus/factory-domain/documents/sample'
import { eventFor } from '@nexus/factory-domain/events/define'
import {
  cleanDocumentWords,
  DOCUMENT_PLACEHOLDERS,
  DOCUMENT_TEMPLATE_KINDS,
  DOCUMENT_TEMPLATE_LIMITS,
  documentTemplateProblems,
  mandatoryPartsOf,
  type DocumentTemplateKind,
  type DocumentTemplateWords,
} from '@nexus/factory-domain/templates/documents'
import { events as templateEvents, type TemplateChange } from '@nexus/factory-domain/templates/events'
import { isTemplateLanguage, TEMPLATE_LANGUAGES, type TemplateLanguage } from '@nexus/factory-domain/templates/language'
import { DOCUMENT_TEMPLATES_MANAGE } from '@nexus/factory-domain/templates/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { companyLegalOf } from '../documents/documents'
import { renderDocumentPdf } from '../documents/pdf'
import type { DocumentTemplateView } from './contract'
import { iso, lockSeries, namesOf, officeOf, person, refused, refuseProblems, templateRefusal, type Reader } from './store'

/**
 * Document templates (B-W2b-422; PLT-231; design admin.documents "Document templates": document, language, company, version,
 * last changed; the builder page "Template: Quote (Italiano)": sections on the left, the PDF preview on the right with sample
 * data, versions, publish). A company's words for one kind of document in one language, in versions:
 *
 *   GET    /templates/documents?companyId&kind&language&status   the versions and one row per kind and language (documents.view)
 *   GET    /templates/documents/kinds                            per kind: the optional and mandatory columns, the parts always
 *                                                                printed, the placeholders, the limits (documents.view)
 *   GET    /templates/documents/:templateId                      one version (documents.view over its company)
 *   POST   /templates/documents                                  a new DRAFT version, from the one in use (or a version named),
 *                                                                else the code's layout (documents.templates.manage)
 *   PUT    /templates/documents/:templateId                      the draft's words and columns
 *   POST   /templates/documents/:templateId/publish              in ONE command the version in use RETIRED, then this one ACTIVE
 *   POST   /templates/documents/:templateId/retire               the version in use RETIRED: the code's layout prints again
 *   DELETE /templates/documents/:templateId?version              a draft given up (a published version is kept for good)
 *   GET    /templates/documents/:templateId/preview              the PDF: a sample with the company's legal data and these words
 *
 * The layout reads the version in use first (platform/templates/active.ts → documents/layouts.ts layoutFor), else the code's
 * fixed layout. A document already issued keeps its stored PDF: a new version changes the documents printed after it. One
 * draft at a time per company, kind and language; versions are numbered under a lock of their series.
 */

const [documentChanged] = templateEvents

const COLUMNS = {
  id: true,
  companyId: true,
  kind: true,
  language: true,
  revision: true,
  status: true,
  header: true,
  terms: true,
  footer: true,
  fieldsShown: true,
  publishedAt: true,
  publishedById: true,
  retiredAt: true,
  createdAt: true,
  createdById: true,
  updatedAt: true,
  version: true,
} as const satisfies Prisma.DocumentTemplateSelect
type Row = Prisma.DocumentTemplateGetPayload<{ select: typeof COLUMNS }>

const mayRead = (actor: Actor, companyId: string): boolean => can(actor, DOCUMENTS_VIEW, { companyId })
const mayManage = (actor: Actor, companyId: string): boolean => can(actor, DOCUMENT_TEMPLATES_MANAGE, { companyId })

const layoutTemplateOf = (row: Pick<Row, 'kind' | 'language' | 'revision' | 'header' | 'terms' | 'footer' | 'fieldsShown'>): LayoutTemplate => ({
  type: row.kind,
  language: row.language,
  revision: row.revision,
  header: row.header,
  terms: row.terms,
  footer: row.footer,
  fieldsShown: row.fieldsShown,
})

function viewOf(row: Row, names: ReadonlyMap<string, string>): DocumentTemplateView {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    language: row.language,
    revision: row.revision,
    status: row.status,
    header: row.header,
    terms: row.terms,
    footer: row.footer,
    fieldsShown: row.fieldsShown,
    layout: layoutFor(row.kind, layoutTemplateOf(row)).id,
    publishedAt: iso(row.publishedAt),
    publishedBy: person(names, row.publishedById),
    retiredAt: iso(row.retiredAt),
    createdAt: toUtcIso(row.createdAt),
    createdBy: person(names, row.createdById),
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

async function viewsOf(db: Reader, rows: readonly Row[]): Promise<DocumentTemplateView[]> {
  const names = await namesOf(db, rows.flatMap((row) => [row.publishedById, row.createdById]))
  return rows.map((row) => viewOf(row, names))
}

const emitted = (tools: Pick<CommandTools, 'emit'>, row: Pick<Row, 'id' | 'companyId' | 'kind' | 'language' | 'revision'>, change: TemplateChange) =>
  tools.emit(eventFor(documentChanged, { subject: row.id, companyId: row.companyId, payload: { templateId: row.id, companyId: row.companyId, kind: row.kind, language: row.language, revision: row.revision, change } }))

/** A version the person may read (documents.view over its company), else 404. */
async function readable(caller: CommandCaller, templateId: string): Promise<Row> {
  const actor = actorOf(officeOf(caller))
  const row = isUuid(templateId) ? await caller.withClient((db) => db.documentTemplate.findUnique({ where: { id: templateId }, select: COLUMNS })) : null
  if (!row || !mayRead(actor, row.companyId)) throw new NotFoundError('Document template not found.')
  return row
}

/** A version the person may change (documents.templates.manage over its company): 404 unseen, 403 seen but not theirs to change. */
async function manageable(caller: CommandCaller, templateId: string): Promise<Row> {
  const row = await readable(caller, templateId)
  if (!mayManage(actorOf(officeOf(caller)), row.companyId)) throw new ForbiddenError()
  return row
}

/** GET /templates/documents */
export async function listDocumentTemplates(caller: CommandCaller, query: { readonly companyId: string; readonly kind?: DocumentTemplateKind | undefined; readonly language?: TemplateLanguage | undefined; readonly status?: Row['status'] | undefined }) {
  const actor = actorOf(officeOf(caller))
  if (!mayRead(actor, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const rows = await db.documentTemplate.findMany({
      where: { companyId: query.companyId, ...(query.kind ? { kind: query.kind } : {}), language: query.language ?? { in: [...TEMPLATE_LANGUAGES] }, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ kind: 'asc' }, { language: 'asc' }, { revision: 'desc' }],
      select: COLUMNS,
      take: 500,
    })
    const every = await db.documentTemplate.findMany({ where: { companyId: query.companyId }, select: { id: true, kind: true, language: true, revision: true, status: true, publishedAt: true, createdAt: true, updatedAt: true } })
    const slots = DOCUMENT_TEMPLATE_KINDS.flatMap((kind) =>
      TEMPLATE_LANGUAGES.map((language) => {
        const versions = every.filter((row) => row.kind === kind && row.language === language)
        const active = versions.find((row) => row.status === 'ACTIVE') ?? null
        const draft = versions.filter((row) => row.status === 'DRAFT').sort((a, b) => b.revision - a.revision)[0] ?? null
        const last = versions.reduce<Date | null>((latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest), null)
        return {
          kind,
          language,
          layout: active ? `${DOCUMENT_LAYOUTS[kind].id}+t${active.revision}` : DOCUMENT_LAYOUTS[kind].id,
          active: active ? { id: active.id, revision: active.revision, at: toUtcIso(active.publishedAt ?? active.createdAt) } : null,
          draft: draft ? { id: draft.id, revision: draft.revision, at: toUtcIso(draft.updatedAt) } : null,
          versions: versions.length,
          lastChangedAt: iso(last),
        }
      }),
    )
    return { templates: await viewsOf(db, rows), slots, mayManage: mayManage(actor, query.companyId) }
  })
}

/** GET /templates/documents/kinds */
export function documentKinds() {
  return {
    kinds: DOCUMENT_TEMPLATE_KINDS.map((kind) => ({
      kind,
      layout: DOCUMENT_LAYOUTS[kind].id,
      optionalColumns: optionalColumnsOf(kind),
      mandatoryColumns: DOCUMENT_LAYOUTS[kind].columns.map((entry) => entry.key).filter((key) => MANDATORY_COLUMNS[kind].includes(key)),
      mandatoryParts: mandatoryPartsOf(kind),
      placeholders: [...DOCUMENT_PLACEHOLDERS[kind]],
      limits: { header: DOCUMENT_TEMPLATE_LIMITS.header, terms: DOCUMENT_TEMPLATE_LIMITS.terms, footer: DOCUMENT_TEMPLATE_LIMITS.footer },
    })),
    languages: [...TEMPLATE_LANGUAGES],
  }
}

/** GET /templates/documents/:templateId */
export async function getDocumentTemplate(caller: CommandCaller, templateId: string) {
  const row = await readable(caller, templateId)
  const [template] = await caller.withClient((db) => viewsOf(db, [row]))
  return { template: template!, mayManage: mayManage(actorOf(officeOf(caller)), row.companyId) }
}

interface WordsBody {
  readonly header?: string | null | undefined
  readonly terms?: string | null | undefined
  readonly footer?: string | null | undefined
  readonly fieldsShown?: readonly string[] | undefined
}

/** The words a body gives over the ones it starts from (absent: kept; null: none). */
const merged = (start: DocumentTemplateWords, body: WordsBody): DocumentTemplateWords => ({
  header: body.header !== undefined ? body.header : start.header,
  terms: body.terms !== undefined ? body.terms : start.terms,
  footer: body.footer !== undefined ? body.footer : start.footer,
  fieldsShown: body.fieldsShown !== undefined ? [...body.fieldsShown] : start.fieldsShown,
})

/** The words checked for the kind and language (the texts trimmed, the fields as sent), then cleaned for storing (400 with every problem). */
function checkedWords(kind: DocumentTemplateKind, language: string, words: DocumentTemplateWords): DocumentTemplateWords {
  const cleaned = cleanDocumentWords(kind, words)
  refuseProblems(documentTemplateProblems(kind, language, { ...cleaned, fieldsShown: words.fieldsShown }), 'The document template cannot be saved like this.')
  return cleaned
}

/** POST /templates/documents */
export async function createDocumentTemplate(
  caller: CommandCaller,
  body: WordsBody & { readonly companyId: string; readonly kind: DocumentTemplateKind; readonly language: TemplateLanguage; readonly from?: string | undefined },
  idempotencyKey?: string,
) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayRead(actor, body.companyId)) throw new NotFoundError('Company not found.')
  if (!mayManage(actor, body.companyId)) throw new ForbiddenError()
  const series = { companyId: body.companyId, kind: body.kind, language: body.language }
  const start = await caller.withClient(async (db) => {
    if (!(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const source = body.from
      ? await db.documentTemplate.findFirst({ where: { id: body.from, ...series }, select: COLUMNS })
      : await db.documentTemplate.findFirst({ where: { ...series, status: 'ACTIVE' }, select: COLUMNS })
    if (body.from && !source) refuseProblems([{ path: 'body/from', message: 'Start from a version of the same company, document and language.' }], '')
    // A version's columns that its layout no longer has are not carried over; the code's layout shows every optional column.
    const optional: readonly string[] = optionalColumnsOf(body.kind)
    return source
      ? { id: source.id, words: { header: source.header, terms: source.terms, footer: source.footer, fieldsShown: source.fieldsShown.filter((key) => optional.includes(key)) } }
      : { id: null, words: { header: null, terms: null, footer: null, fieldsShown: [...optional] } }
  })
  const words = checkedWords(body.kind, body.language, merged(start.words, body))
  const { result } = await command(caller, { name: 'templates.createDocument', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, `doc|${body.companyId}|${body.kind}|${body.language}`)
    const draft = await tx.documentTemplate.findFirst({ where: { ...series, status: 'DRAFT' }, select: { revision: true } })
    if (draft) throw refused('DRAFT_OPEN', `A draft of this template is already open (version ${draft.revision}): change that one, or delete it first.`)
    const last = await tx.documentTemplate.aggregate({ where: series, _max: { revision: true } })
    const revision = (last._max.revision ?? 0) + 1
    const id = newId()
    const row = await tx.documentTemplate.create({
      data: { id, ...series, revision, key: `doc:${body.kind}:${body.companyId}:${body.language}:${revision}`, status: 'DRAFT', ...words, fieldsShown: [...words.fieldsShown], createdAt: now, updatedAt: now, createdById: context.actorId },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'DocumentTemplate', recordId: id, companyId: body.companyId, after: { kind: body.kind, language: body.language, revision, status: 'DRAFT', from: start.id, fieldsShown: row.fieldsShown } })
    emitted(tools, row, 'CREATED')
    const [view] = await viewsOf(tx, [row])
    return { template: view! }
  }).catch(templateRefusal)
  return result
}

/** PUT /templates/documents/:templateId */
export async function updateDocumentTemplate(caller: CommandCaller, templateId: string, body: WordsBody & { readonly version: number }, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  const words = checkedWords(before.kind, before.language, merged({ header: before.header, terms: before.terms, footer: before.footer, fieldsShown: before.fieldsShown }, body))
  const { result } = await command(caller, { name: 'templates.updateDocument', idempotencyKey, input: { templateId, ...body }, record: { type: 'DocumentTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = await tx.documentTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    const changed = (['header', 'terms', 'footer'] as const).filter((key) => current[key] !== words[key])
    if (current.fieldsShown.join('|') !== words.fieldsShown.join('|')) (changed as string[]).push('fieldsShown')
    const row = await tx.documentTemplate.update({ where: { id: templateId }, data: { header: words.header, terms: words.terms, footer: words.footer, fieldsShown: [...words.fieldsShown] }, select: COLUMNS })
    tools.audit({ recordType: 'DocumentTemplate', recordId: templateId, companyId: row.companyId, after: { changed, fieldsShown: row.fieldsShown } })
    emitted(tools, row, 'EDITED')
    const [view] = await viewsOf(tx, [row])
    return { template: view! }
  }).catch(templateRefusal)
  return result
}

/** POST /templates/documents/:templateId/publish */
export async function publishDocumentTemplate(caller: CommandCaller, templateId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  // Its words are checked again: a draft written before a rule (or by another way in) is published only as the rules hold.
  checkedWords(before.kind, before.language, { header: before.header, terms: before.terms, footer: before.footer, fieldsShown: before.fieldsShown })
  const { result } = await command(caller, { name: 'templates.publishDocument', idempotencyKey, input: { templateId, ...body }, record: { type: 'DocumentTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, `doc|${before.companyId}|${before.kind}|${before.language}`)
    const current = await tx.documentTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    const inUse = await tx.documentTemplate.findFirst({ where: { companyId: current.companyId, kind: current.kind, language: current.language, status: 'ACTIVE' }, select: COLUMNS })
    // The version in use is retired first: one in use per company, kind and language (the partial unique checks each statement).
    if (inUse) {
      const retired = await tx.documentTemplate.update({ where: { id: inUse.id }, data: { status: 'RETIRED', retiredAt: now, version: { increment: 1 } }, select: COLUMNS })
      tools.audit({ action: 'templates.retireDocument', recordType: 'DocumentTemplate', recordId: inUse.id, companyId: inUse.companyId, before: { status: 'ACTIVE' }, after: { status: 'RETIRED', replacedBy: templateId } })
      emitted(tools, retired, 'RETIRED')
    }
    const row = await tx.documentTemplate.update({ where: { id: templateId }, data: { status: 'ACTIVE', publishedAt: now, publishedById: context.actorId }, select: COLUMNS })
    tools.audit({ recordType: 'DocumentTemplate', recordId: templateId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'ACTIVE', revision: row.revision, replaces: inUse?.id ?? null } })
    emitted(tools, row, 'PUBLISHED')
    const [view] = await viewsOf(tx, [row])
    return { template: view!, retired: inUse ? { id: inUse.id, revision: inUse.revision } : null }
  }).catch(templateRefusal)
  return result
}

/** POST /templates/documents/:templateId/retire */
export async function retireDocumentTemplate(caller: CommandCaller, templateId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'ACTIVE') throw refused('NOT_IN_USE')
  const { result } = await command(caller, { name: 'templates.retireDocument', idempotencyKey, input: { templateId, ...body }, record: { type: 'DocumentTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.documentTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { status: true } })
    if (current.status !== 'ACTIVE') throw refused('NOT_IN_USE')
    const row = await tx.documentTemplate.update({ where: { id: templateId }, data: { status: 'RETIRED', retiredAt: now }, select: COLUMNS })
    tools.audit({ recordType: 'DocumentTemplate', recordId: templateId, companyId: row.companyId, before: { status: 'ACTIVE' }, after: { status: 'RETIRED' } })
    emitted(tools, row, 'RETIRED')
    const [view] = await viewsOf(tx, [row])
    return { template: view! }
  }).catch(templateRefusal)
  return result
}

/** DELETE /templates/documents/:templateId?version */
export async function deleteDocumentTemplate(caller: CommandCaller, templateId: string, version: number, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  const { result } = await command(caller, { name: 'templates.deleteDocument', idempotencyKey, input: { templateId, version }, record: { type: 'DocumentTemplate', id: templateId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const current = await tx.documentTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    await tx.documentTemplate.delete({ where: { id: templateId } })
    tools.audit({ recordType: 'DocumentTemplate', recordId: templateId, companyId: current.companyId, before: { kind: current.kind, language: current.language, revision: current.revision, status: 'DRAFT' } })
    emitted(tools, current, 'DELETED')
    return { deleted: templateId }
  }).catch(templateRefusal)
  return result
}

/**
 * GET /templates/documents/:templateId/preview: a sample of the kind (made-up party and lines, the "sample" banner, never
 * stored or numbered) on the company's real legal data, printed with this version's words whatever its status.
 */
export async function previewDocumentTemplate(caller: CommandCaller, templateId: string, clock: Clock): Promise<{ pdf: Buffer; fileName: string }> {
  const row = await readable(caller, templateId)
  if (!isTemplateLanguage(row.language)) throw refused('NOT_OFFERED', 'Documents are printed in Italian or English: this version cannot be previewed.')
  const company = attachLayoutTemplates(await companyLegalOf(caller, row.companyId), [layoutTemplateOf(row)])
  const composed = composeDocument(sampleDocument(row.kind, row.language, company, businessDate(clock.now())))
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.title} - ${composed.banner} - v${row.revision}.pdf` }
}
