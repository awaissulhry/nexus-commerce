import type { Prisma } from '@nexus/factory-db'
import { DOCUMENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as templateEvents, type TemplateChange } from '@nexus/factory-domain/templates/events'
import { isTemplateLanguage, TEMPLATE_LANGUAGES, type TemplateLanguage } from '@nexus/factory-domain/templates/language'
import { companyValues, emailTemplateProblems, fillMail, isMailEvent, MAIL_EVENT_DEFINITIONS, MAIL_EVENTS, type MailEvent, type MailWords } from '@nexus/factory-domain/templates/mail'
import { DOCUMENT_TEMPLATES_MANAGE } from '@nexus/factory-domain/templates/permissions'
import { missingValues } from '@nexus/factory-domain/templates/placeholders'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import type { EmailTemplateView } from './contract'
import { iso, lockSeries, mayOver, namesOf, officeOf, person, refused, refuseProblems, templateRefusal, type Reader } from './store'

/**
 * E-mail templates (B-W2b-422; PLT-232; design admin.documents "E-mail templates": event, language, subject, last changed;
 * edit with placeholders and a preview on a sample record). The words of one mail the code sends, per event and language, a
 * company's own or every company's (companyId null; a company's own wins), in versions:
 *
 *   GET    /templates/mail/events                         the events whose mail takes a template: placeholders, the code's words
 *   GET    /templates/mail?companyId&event&language&status  the company's and every company's versions, and per event and language
 *                                                         what the company's mail is sent with now (documents.view)
 *   GET    /templates/mail/:templateId                    one version
 *   POST   /templates/mail                                a new DRAFT, from the version in use (or one named), else the code's words
 *   PUT    /templates/mail/:templateId                    the draft's subject and body
 *   POST   /templates/mail/:templateId/publish            in ONE command the version in use RETIRED, then this one ACTIVE
 *   POST   /templates/mail/:templateId/retire             the version in use RETIRED (every company's, else the code's words, again)
 *   DELETE /templates/mail/:templateId?version            a draft given up
 *   POST   /templates/mail/:templateId/preview            the subject and body filled with a sample record and the company's names
 *
 * Writing is documents.templates.manage over the company, or over every company for every company's templates. A template
 * changes words only: the code still decides whether a mail goes (a person's send, or a switch that is ON). The mail reads the
 * version in use through platform/templates/active.ts mailWordsOf.
 */

const [, emailChanged] = templateEvents

const COLUMNS = {
  id: true,
  companyId: true,
  event: true,
  language: true,
  revision: true,
  status: true,
  subject: true,
  body: true,
  publishedAt: true,
  publishedById: true,
  retiredAt: true,
  createdAt: true,
  createdById: true,
  updatedAt: true,
  version: true,
} as const satisfies Prisma.EmailTemplateSelect
type Row = Prisma.EmailTemplateGetPayload<{ select: typeof COLUMNS }>

/** Reading: documents.view over the company; every company's: documents.view anywhere. */
const mayRead = (actor: Actor, companyId: string | null): boolean => (companyId === null ? holds(actor, DOCUMENTS_VIEW) : can(actor, DOCUMENTS_VIEW, { companyId }))
const mayManage = (actor: Actor, companyId: string | null): boolean => mayOver(actor, DOCUMENT_TEMPLATES_MANAGE, companyId)

function viewOf(row: Row & { event: MailEvent }, names: ReadonlyMap<string, string>): EmailTemplateView {
  return {
    id: row.id,
    companyId: row.companyId,
    event: row.event,
    language: row.language,
    revision: row.revision,
    status: row.status,
    subject: row.subject,
    body: row.body,
    publishedAt: iso(row.publishedAt),
    publishedBy: person(names, row.publishedById),
    retiredAt: iso(row.retiredAt),
    createdAt: toUtcIso(row.createdAt),
    createdBy: person(names, row.createdById),
    updatedAt: toUtcIso(row.updatedAt),
    version: row.version,
  }
}

const known = (row: Row): row is Row & { event: MailEvent } => isMailEvent(row.event)

async function viewsOf(db: Reader, rows: readonly Row[]): Promise<EmailTemplateView[]> {
  const shown = rows.filter(known)
  const names = await namesOf(db, shown.flatMap((row) => [row.publishedById, row.createdById]))
  return shown.map((row) => viewOf(row, names))
}

async function viewOne(db: Reader, row: Row): Promise<EmailTemplateView> {
  const [view] = await viewsOf(db, [row])
  if (!view) throw refused('NOT_OFFERED')
  return view
}

const emitted = (tools: Pick<CommandTools, 'emit'>, row: Pick<Row, 'id' | 'companyId' | 'event' | 'language' | 'revision'>, change: TemplateChange) =>
  tools.emit(eventFor(emailChanged, { subject: row.id, companyId: row.companyId, payload: { templateId: row.id, companyId: row.companyId, event: row.event as MailEvent, language: row.language, revision: row.revision, change } }))

/** The series of a version: its event, language and company (null: every company's). */
const seriesWhere = (row: { readonly event: string; readonly language: string; readonly companyId: string | null }) => ({ event: row.event, language: row.language, companyId: row.companyId })
const seriesKey = (row: { readonly event: string; readonly language: string; readonly companyId: string | null }) => `mail|${row.event}|${row.companyId ?? 'all'}|${row.language}`

async function readable(caller: CommandCaller, templateId: string): Promise<Row> {
  const actor = actorOf(officeOf(caller))
  const row = isUuid(templateId) ? await caller.withClient((db) => db.emailTemplate.findUnique({ where: { id: templateId }, select: COLUMNS })) : null
  if (!row || !mayRead(actor, row.companyId)) throw new NotFoundError('E-mail template not found.')
  return row
}

async function manageable(caller: CommandCaller, templateId: string): Promise<Row> {
  const row = await readable(caller, templateId)
  if (!mayManage(actorOf(officeOf(caller)), row.companyId)) throw new ForbiddenError()
  if (!known(row)) throw refused('NOT_OFFERED')
  return row
}

/** GET /templates/mail/events */
export function mailEvents() {
  return {
    events: MAIL_EVENTS.map((event) => {
      const definition = MAIL_EVENT_DEFINITIONS[event]
      return { event, recordType: definition.recordType, placeholders: [...definition.placeholders], words: { ...definition.words } }
    }),
    languages: [...TEMPLATE_LANGUAGES],
  }
}

/** GET /templates/mail */
export async function listEmailTemplates(caller: CommandCaller, query: { readonly companyId: string; readonly event?: MailEvent | undefined; readonly language?: TemplateLanguage | undefined; readonly status?: Row['status'] | undefined }) {
  const actor = actorOf(officeOf(caller))
  if (!mayRead(actor, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const scope = { OR: [{ companyId: query.companyId }, { companyId: null }] }
    const rows = await db.emailTemplate.findMany({
      where: { ...scope, event: query.event ?? { in: [...MAIL_EVENTS] }, language: query.language ?? { in: [...TEMPLATE_LANGUAGES] }, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ event: 'asc' }, { language: 'asc' }, { revision: 'desc' }],
      select: COLUMNS,
      take: 500,
    })
    const every = await db.emailTemplate.findMany({ where: { ...scope, event: { in: [...MAIL_EVENTS] } }, select: { id: true, companyId: true, event: true, language: true, revision: true, status: true, publishedAt: true, createdAt: true, updatedAt: true } })
    type Slim = (typeof every)[number]
    const pick = (versions: readonly Slim[]) => {
      const active = versions.find((row) => row.status === 'ACTIVE') ?? null
      const draft = versions.filter((row) => row.status === 'DRAFT').sort((a, b) => b.revision - a.revision)[0] ?? null
      return {
        active: active ? { id: active.id, revision: active.revision, at: toUtcIso(active.publishedAt ?? active.createdAt) } : null,
        draft: draft ? { id: draft.id, revision: draft.revision, at: toUtcIso(draft.updatedAt) } : null,
      }
    }
    const slots = MAIL_EVENTS.flatMap((event) =>
      TEMPLATE_LANGUAGES.map((language) => {
        const versions = every.filter((row) => row.event === event && row.language === language)
        const company = pick(versions.filter((row) => row.companyId === query.companyId))
        const all = pick(versions.filter((row) => row.companyId === null))
        const last = versions.reduce<Date | null>((latest, row) => (latest === null || row.updatedAt > latest ? row.updatedAt : latest), null)
        return { event, language, inUse: company.active ? ('COMPANY' as const) : all.active ? ('ALL' as const) : ('CODE' as const), company, all, lastChangedAt: iso(last) }
      }),
    )
    return { templates: await viewsOf(db, rows), slots, mayManage: { company: mayManage(actor, query.companyId), all: mayManage(actor, null) } }
  })
}

/** GET /templates/mail/:templateId */
export async function getEmailTemplate(caller: CommandCaller, templateId: string) {
  const row = await readable(caller, templateId)
  return { template: await caller.withClient((db) => viewOne(db, row)), mayManage: mayManage(actorOf(officeOf(caller)), row.companyId) }
}

/** The words checked for the event and language (400 with every problem), trimmed for storing. */
function checkedWords(event: string, language: string, words: MailWords): MailWords {
  const cleaned = { subject: words.subject.trim(), body: words.body.replace(/\r\n?/g, '\n').trim() }
  refuseProblems(emailTemplateProblems(event, language, cleaned), 'The e-mail template cannot be saved like this.')
  return cleaned
}

/** POST /templates/mail */
export async function createEmailTemplate(
  caller: CommandCaller,
  body: { readonly companyId: string | null; readonly event: MailEvent; readonly language: TemplateLanguage; readonly from?: string | undefined; readonly subject?: string | undefined; readonly body?: string | undefined },
  idempotencyKey?: string,
) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayRead(actor, body.companyId)) throw new NotFoundError('Company not found.')
  if (!mayManage(actor, body.companyId)) throw new ForbiddenError()
  const series = { event: body.event, language: body.language, companyId: body.companyId }
  const start = await caller.withClient(async (db) => {
    if (body.companyId && !(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const source = body.from ? await db.emailTemplate.findFirst({ where: { id: body.from, ...series }, select: COLUMNS }) : await db.emailTemplate.findFirst({ where: { ...series, status: 'ACTIVE' }, select: COLUMNS })
    if (body.from && !source) refuseProblems([{ path: 'body/from', message: 'Start from a version of the same mail, company and language.' }], '')
    return source ? { id: source.id, words: { subject: source.subject, body: source.body } } : { id: null, words: MAIL_EVENT_DEFINITIONS[body.event].words[body.language] }
  })
  const words = checkedWords(body.event, body.language, { subject: body.subject ?? start.words.subject, body: body.body ?? start.words.body })
  const { result } = await command(caller, { name: 'templates.createMail', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, seriesKey(series))
    const draft = await tx.emailTemplate.findFirst({ where: { ...seriesWhere(series), status: 'DRAFT' }, select: { revision: true } })
    if (draft) throw refused('DRAFT_OPEN', `A draft of this template is already open (version ${draft.revision}): change that one, or delete it first.`)
    const last = await tx.emailTemplate.aggregate({ where: seriesWhere(series), _max: { revision: true } })
    const revision = (last._max.revision ?? 0) + 1
    const id = newId()
    const row = await tx.emailTemplate.create({
      data: { id, ...series, revision, key: `mail:${body.event}:${body.companyId ?? 'all'}:${body.language}:${revision}`, status: 'DRAFT', ...words, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'EmailTemplate', recordId: id, companyId: body.companyId, after: { event: body.event, language: body.language, companyId: body.companyId, revision, status: 'DRAFT', from: start.id } })
    emitted(tools, row, 'CREATED')
    return { template: await viewOne(tx, row) }
  }).catch(templateRefusal)
  return result
}

/** PUT /templates/mail/:templateId */
export async function updateEmailTemplate(caller: CommandCaller, templateId: string, body: { readonly version: number; readonly subject?: string | undefined; readonly body?: string | undefined }, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  const words = checkedWords(before.event, before.language, { subject: body.subject ?? before.subject, body: body.body ?? before.body })
  const { result } = await command(caller, { name: 'templates.updateMail', idempotencyKey, input: { templateId, ...body }, record: { type: 'EmailTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = await tx.emailTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    const changed = (['subject', 'body'] as const).filter((key) => current[key] !== words[key])
    const row = await tx.emailTemplate.update({ where: { id: templateId }, data: words, select: COLUMNS })
    tools.audit({ recordType: 'EmailTemplate', recordId: templateId, companyId: row.companyId, after: { changed } })
    emitted(tools, row, 'EDITED')
    return { template: await viewOne(tx, row) }
  }).catch(templateRefusal)
  return result
}

/** POST /templates/mail/:templateId/publish */
export async function publishEmailTemplate(caller: CommandCaller, templateId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  checkedWords(before.event, before.language, { subject: before.subject, body: before.body })
  const { result } = await command(caller, { name: 'templates.publishMail', idempotencyKey, input: { templateId, ...body }, record: { type: 'EmailTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    await lockSeries(tx, seriesKey(before))
    const current = await tx.emailTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    const inUse = await tx.emailTemplate.findFirst({ where: { ...seriesWhere(current), status: 'ACTIVE' }, select: COLUMNS })
    if (inUse) {
      const retired = await tx.emailTemplate.update({ where: { id: inUse.id }, data: { status: 'RETIRED', retiredAt: now, version: { increment: 1 } }, select: COLUMNS })
      tools.audit({ action: 'templates.retireMail', recordType: 'EmailTemplate', recordId: inUse.id, companyId: inUse.companyId, before: { status: 'ACTIVE' }, after: { status: 'RETIRED', replacedBy: templateId } })
      emitted(tools, retired, 'RETIRED')
    }
    const row = await tx.emailTemplate.update({ where: { id: templateId }, data: { status: 'ACTIVE', publishedAt: now, publishedById: context.actorId }, select: COLUMNS })
    tools.audit({ recordType: 'EmailTemplate', recordId: templateId, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'ACTIVE', revision: row.revision, replaces: inUse?.id ?? null } })
    emitted(tools, row, 'PUBLISHED')
    return { template: await viewOne(tx, row), retired: inUse ? { id: inUse.id, revision: inUse.revision } : null }
  }).catch(templateRefusal)
  return result
}

/** POST /templates/mail/:templateId/retire */
export async function retireEmailTemplate(caller: CommandCaller, templateId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'ACTIVE') throw refused('NOT_IN_USE')
  const { result } = await command(caller, { name: 'templates.retireMail', idempotencyKey, input: { templateId, ...body }, record: { type: 'EmailTemplate', id: templateId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.emailTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { status: true } })
    if (current.status !== 'ACTIVE') throw refused('NOT_IN_USE')
    const row = await tx.emailTemplate.update({ where: { id: templateId }, data: { status: 'RETIRED', retiredAt: now }, select: COLUMNS })
    tools.audit({ recordType: 'EmailTemplate', recordId: templateId, companyId: row.companyId, before: { status: 'ACTIVE' }, after: { status: 'RETIRED' } })
    emitted(tools, row, 'RETIRED')
    return { template: await viewOne(tx, row) }
  }).catch(templateRefusal)
  return result
}

/** DELETE /templates/mail/:templateId?version */
export async function deleteEmailTemplate(caller: CommandCaller, templateId: string, version: number, idempotencyKey?: string) {
  const before = await manageable(caller, templateId)
  if (before.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
  const { result } = await command(caller, { name: 'templates.deleteMail', idempotencyKey, input: { templateId, version }, record: { type: 'EmailTemplate', id: templateId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const current = await tx.emailTemplate.findUniqueOrThrow({ where: { id: templateId }, select: COLUMNS })
    if (current.status !== 'DRAFT') throw refused('NOT_A_DRAFT')
    await tx.emailTemplate.delete({ where: { id: templateId } })
    tools.audit({ recordType: 'EmailTemplate', recordId: templateId, companyId: current.companyId, before: { event: current.event, language: current.language, revision: current.revision, status: 'DRAFT' } })
    emitted(tools, current, 'DELETED')
    return { deleted: templateId }
  }).catch(templateRefusal)
  return result
}

/**
 * POST /templates/mail/:templateId/preview: the version's subject and body filled with the event's made-up sample record and
 * the names of the company (the template's own; for every company's, the one asked, else the first the person sees).
 * Nothing is sent.
 */
export async function previewEmailTemplate(caller: CommandCaller, templateId: string, body: { readonly companyId?: string | undefined }) {
  const actor = actorOf(officeOf(caller))
  const row = await readable(caller, templateId)
  if (!known(row) || !isTemplateLanguage(row.language)) throw refused('NOT_OFFERED')
  const language = row.language
  const event = row.event
  const company = await caller.withClient(async (db) => {
    const asked = row.companyId ?? body.companyId ?? null
    if (asked) {
      if (!mayRead(actor, asked)) throw new NotFoundError('Company not found.')
      return db.company.findUnique({ where: { id: asked }, select: { legalName: true, tradeName: true } })
    }
    const companies = await db.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true, legalName: true, tradeName: true }, orderBy: [{ code: 'asc' }], take: 200 })
    return companies.find((candidate) => mayRead(actor, candidate.id)) ?? null
  })
  if (!company) throw new NotFoundError('Company not found.')
  const values = { ...MAIL_EVENT_DEFINITIONS[event].sample[language], ...companyValues(company) }
  const filled = fillMail({ subject: row.subject, body: row.body }, values)
  return { ...filled, missing: [...new Set([...missingValues(row.subject, values), ...missingValues(row.body, values)])] }
}
