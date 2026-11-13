import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CreateTemplateBody, FromQuoteBody, ReplaceLinesBody, TemplateLineBody, UpdateTemplateBody } from '@nexus/factory-domain/sales/quote-templates/contracts'
import { QUOTES_TEMPLATES_MANAGE } from '@nexus/factory-domain/sales/quote-templates/permissions'
import { templateHeaderProblems, templateLineProblems, type TemplateChange, type TemplateHeader, type TemplateLineInput } from '@nexus/factory-domain/sales/quote-templates/rules'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText, type SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { StoredAcceptanceMode } from '@nexus/factory-domain/sales/quote-terms/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf, officeQuote, readCurrentVersion, readQuote, type Reader } from '../quotes/store'
import { assertMayManage, databaseRefusal, invalid, officeTemplate, readTemplate, sizesOf, TEMPLATE_COLUMNS, TEMPLATE_LINE_COLUMNS, templateView, type TemplateRow } from './store'

/**
 * Quote templates (B-W2b-294; SAL-144 "Templates speed daily quoting", SAL-252 "Company-scoped templates"; design sales.settings
 * ssettings.templates: Template · Company · Used, "New template (opens a quote in template mode)"):
 *
 *   GET  /sales/quote-templates                      quotes.view: the templates the caller reaches (a company's and every
 *                                                    company's; ?companyId: those a quote of that company may start from)
 *   GET  /sales/quote-templates/:templateId          quotes.view: the template with its lines
 *   POST /sales/quote-templates                      quotes.templates.manage over its company (every company: a grant over
 *                                                    every company): its terms and lines
 *   PATCH /sales/quote-templates/:templateId         its name and terms ({version})
 *   PUT  /sales/quote-templates/:templateId/lines    its whole list of lines ({version, lines})
 *   POST /sales/quote-templates/:templateId/archive | restore   never deleted (quotes name it)
 *   POST /sales/quote-templates/from-quote           a quote's current version saved as a template (its lines, sections,
 *                                                    notes and terms; quotes.view on the quote)
 *
 * Every write is ONE command on the template (its version is the edit-conflict guard), its audit row and
 * quote_template.changed. Every rule of the database's QuoteTemplate_guard / QuoteTemplateLine_guard is said in words first
 * (400); a refusal that still comes is a 409 in its words.
 */

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** GET /sales/quote-templates */
export async function listTemplates(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status: 'ACTIVE' | 'ARCHIVED' | 'ALL'; readonly q?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const reach = scopeWhere(actor, QUOTES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.QuoteTemplateWhereInput
  const where: Prisma.QuoteTemplateWhereInput = {
    AND: [
      reach,
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
      query.status === 'ALL' ? {} : { status: query.status },
      query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {},
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.quoteTemplate.findMany({ where, select: TEMPLATE_COLUMNS, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 200 })
    const ids = rows.map((row) => row.id)
    const lines = ids.length === 0 ? [] : await db.quoteTemplateLine.findMany({ where: { templateId: { in: ids } }, select: { templateId: true, section: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    const used = ids.length === 0 ? [] : await db.quote.groupBy({ by: ['templateId'], where: { templateId: { in: ids } }, _count: { _all: true } })
    const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.companyId ? [row.companyId] : [])))] } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.legalName }]))
    const templates = rows.map((row) => {
      const own = lines.filter((line) => line.templateId === row.id)
      return {
        id: row.id,
        companyId: row.companyId,
        company: row.companyId ? (companies.get(row.companyId) ?? null) : null,
        name: row.name,
        description: row.description,
        language: row.language,
        currency: row.currency,
        validityDays: row.validityDays,
        acceptanceMode: row.acceptanceMode as StoredAcceptanceMode,
        incoterm: row.incoterm,
        incotermPlace: row.incotermPlace,
        shipComplete: row.shipComplete,
        status: row.status as 'ACTIVE' | 'ARCHIVED',
        lineCount: own.length,
        sections: [...new Set(own.flatMap((line) => (line.section ? [line.section] : [])))],
        used: used.find((entry) => entry.templateId === row.id)?._count._all ?? 0,
        version: row.version,
        updatedAt: toUtcIso(row.updatedAt),
      }
    })
    const mayCreate = grantsFor(actor, QUOTES_TEMPLATES_MANAGE).length > 0
    return { templates, mayCreate }
  })
}

/** GET /sales/quote-templates/:templateId */
export async function getTemplate(caller: CommandCaller, templateId: string) {
  const { context, template } = await officeTemplate(caller, templateId)
  return caller.withClient(async (db) => ({ template: await templateView(db, context, template) }))
}

// ---- checks against the database's rows ----------------------------------------------------------------------------------

/** Payment terms of the library the template may name: ACTIVE, of its company or tenant-wide (every company: tenant-wide). */
async function termsProblems(db: Reader, paymentTermsId: string | null, companyId: string | null): Promise<Issue[]> {
  if (paymentTermsId === null) return []
  const row = await db.paymentTerms.findUnique({ where: { id: paymentTermsId }, select: { code: true, companyId: true, status: true } })
  if (!row) return [{ path: 'body/paymentTermsId', message: 'Not payment terms of the library.' }]
  if (row.status !== 'ACTIVE') return [{ path: 'body/paymentTermsId', message: `${row.code} is archived: choose active terms.` }]
  if (row.companyId !== null && row.companyId !== companyId) return [{ path: 'body/paymentTermsId', message: companyId === null ? `${row.code} belongs to one company: a template of every company names terms of every company.` : `${row.code} belongs to another company.` }]
  return []
}

/** Each line's style is the template's company's or tenant-wide (every company: tenant-wide), active, its colourway the style's. */
async function lineStyleProblems(db: Reader, lines: readonly TemplateLineInput[], companyId: string | null): Promise<Issue[]> {
  const issues: Issue[] = []
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, companyId: true, status: true, sizes: true } })).map((row) => [row.id, row]))
  const colourwayIds = [...new Set(lines.flatMap((line) => (line.colourwayId ? [line.colourwayId] : [])))]
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, styleId: true, status: true, code: true } })).map((row) => [row.id, row]))
  lines.forEach((line, index) => {
    const path = `body/lines/${index}`
    const style = styles.get(line.styleId)
    if (!style || (style.companyId !== null && style.companyId !== companyId)) {
      issues.push({ path: `${path}/styleId`, message: style && companyId === null ? `${style.code} belongs to one company: a template of every company names styles of every company.` : 'Not a style this company sells.' })
      return
    }
    if (style.status === 'ARCHIVED') issues.push({ path: `${path}/styleId`, message: `${style.code} is archived: it is not quoted.` })
    if (line.colourwayId) {
      const colourway = colourways.get(line.colourwayId)
      if (!colourway || colourway.styleId !== style.id) issues.push({ path: `${path}/colourwayId`, message: `Not a colourway of ${style.code}.` })
      else if (colourway.status !== 'ACTIVE') issues.push({ path: `${path}/colourwayId`, message: `${style.code} ${colourway.code} is archived: it is not quoted.` })
    }
    for (const size of Object.keys(line.sizes ?? {})) if (!style.sizes.includes(size)) issues.push({ path: `${path}/sizes/${size}`, message: `${style.code} has no size ${size}.` })
  })
  return issues
}

const lineInputOf = (line: TemplateLineBody): TemplateLineInput => ({
  seq: line.seq,
  section: blank(line.section),
  kind: line.kind,
  feeKind: (line.feeKind ?? null) as SalesFeeKind | null,
  styleId: line.styleId,
  colourwayId: line.colourwayId ?? null,
  sizes: line.sizes && Object.keys(line.sizes).length > 0 ? line.sizes : null,
  unitPrice: line.unitPrice === undefined || line.unitPrice === null ? null : priceText(String(line.unitPrice)),
  description: blank(line.description),
  note: blank(line.note),
})

async function checkLines(db: Reader, lines: readonly TemplateLineInput[], companyId: string | null): Promise<void> {
  const issues = [...templateLineProblems(lines), ...(await lineStyleProblems(db, lines, companyId))]
  if (issues.length > 0) throw invalid(issues, 'The template\'s lines cannot be saved.')
}

async function writeLines(tools: CommandTools, templateId: string, lines: readonly TemplateLineInput[]): Promise<void> {
  if (lines.length === 0) return
  await tools.tx.quoteTemplateLine.createMany({
    data: lines.map((line) => ({
      id: newId(),
      templateId,
      seq: line.seq,
      section: line.section,
      kind: line.kind,
      feeKind: line.feeKind,
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      ...(line.sizes === null ? {} : { sizeQuantities: line.sizes as Prisma.InputJsonValue }),
      unitPrice: line.unitPrice,
      description: line.description,
      note: line.note,
      createdById: actorIdOf(tools),
    })),
  })
}

const auditLines = (lines: readonly TemplateLineInput[]) => lines.map((line) => ({ ...line, unitPrice: markMoney('price', line.unitPrice) }))

function emitChanged(tools: CommandTools, template: { readonly id: string; readonly companyId: string | null }, change: TemplateChange, fields: readonly string[]): void {
  tools.emit({ type: 'quote_template.changed', subject: template.id, companyId: template.companyId, payload: { templateId: template.id, companyId: template.companyId, change, fields: [...fields] } })
}

const headerOf = (template: TemplateRow): TemplateHeader => ({
  name: template.name,
  description: template.description,
  language: template.language,
  currency: template.currency,
  validityDays: template.validityDays,
  firmOffer: template.firmOffer,
  acceptanceMode: template.acceptanceMode as StoredAcceptanceMode,
  depositPct: template.depositPct === null ? null : template.depositPct.toString(),
  depositKind: template.depositKind,
  termsText: template.termsText,
  termsVersion: template.termsVersion,
  incoterm: template.incoterm,
  incotermPlace: template.incotermPlace,
  shipComplete: template.shipComplete,
})

// ---- create ----------------------------------------------------------------------------------------------------------------

/** The template a caller may make for this company (null: every company), or why not. */
function assertMayCreate(context: OfficeContext, companyId: string | null): void {
  assertMayManage(context, { companyId })
}

async function insertTemplate(tools: CommandTools, context: OfficeContext, companyId: string | null, header: TemplateHeader & { readonly paymentTermsId: string | null }, lines: readonly TemplateLineInput[], action: string, from: Record<string, unknown> | null) {
  const { tx } = tools
  if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  const issues = [...templateHeaderProblems(header), ...(await termsProblems(tx, header.paymentTermsId, companyId))]
  if (issues.length > 0) throw invalid(issues)
  await checkLines(tx, lines, companyId)
  const id = newId()
  await tx.quoteTemplate
    .create({
      data: {
        id,
        companyId,
        name: header.name.trim(),
        description: header.description,
        language: header.language,
        currency: header.currency,
        validityDays: header.validityDays,
        firmOffer: header.firmOffer,
        acceptanceMode: header.acceptanceMode,
        depositPct: header.depositPct,
        depositKind: header.depositKind as Prisma.QuoteTemplateCreateInput['depositKind'],
        paymentTermsId: header.paymentTermsId,
        termsText: header.termsText,
        termsVersion: header.termsVersion,
        incoterm: header.incoterm,
        incotermPlace: header.incotermPlace,
        shipComplete: header.shipComplete,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    .catch(databaseRefusal)
  await writeLines(tools, id, lines).catch(databaseRefusal)
  tools.audit({ action, recordType: 'QuoteTemplate', recordId: id, companyId, after: { ...header, paymentTermsId: header.paymentTermsId, companyId, lines: auditLines(lines), ...(from ? { from } : {}) } })
  emitChanged(tools, { id, companyId }, 'MADE', ['name', 'lines'])
  const template = (await readTemplate(tx, id))!
  return { template: await templateView(tx, context, template) }
}

/** POST /sales/quote-templates */
export async function createTemplate(caller: CommandCaller, body: CreateTemplateBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertMayCreate(context, body.companyId)
  const company = body.companyId ? await caller.withClient((db) => db.company.findUnique({ where: { id: body.companyId! }, select: { currency: true } })) : null
  const header = {
    name: body.name,
    description: blank(body.description),
    language: body.language ?? 'it',
    currency: body.currency ?? company?.currency ?? 'EUR',
    validityDays: body.validityDays ?? null,
    firmOffer: body.firmOffer ?? false,
    acceptanceMode: body.acceptanceMode ?? 'SIGN',
    depositPct: blank(body.depositPct),
    depositKind: blank(body.depositPct) === null ? null : (body.depositKind ?? 'ACCONTO'),
    paymentTermsId: body.paymentTermsId ?? null,
    termsText: blank(body.termsText),
    termsVersion: blank(body.termsVersion),
    incoterm: blank(body.incoterm),
    incotermPlace: blank(body.incotermPlace),
    shipComplete: body.shipComplete ?? false,
  }
  const { result } = await command(caller, { name: 'quotes.templates.create', idempotencyKey, input: body }, (tools) => insertTemplate(tools, context, body.companyId, header, body.lines.map(lineInputOf), 'quotes.templates.create', null))
  return result
}

// ---- change ----------------------------------------------------------------------------------------------------------------

const HEADER_FIELDS = ['name', 'description', 'language', 'currency', 'validityDays', 'firmOffer', 'acceptanceMode', 'depositPct', 'depositKind', 'paymentTermsId', 'termsText', 'termsVersion', 'incoterm', 'incotermPlace', 'shipComplete'] as const

/** PATCH /sales/quote-templates/:templateId */
export async function updateTemplate(caller: CommandCaller, templateId: string, body: UpdateTemplateBody, idempotencyKey?: string) {
  const { context, template } = await officeTemplate(caller, templateId)
  assertMayManage(context, template)
  const fields = HEADER_FIELDS.filter((field) => body[field] !== undefined)
  if (fields.length === 0) throw invalid([{ path: 'body', message: 'Send at least one field to change.' }], 'Nothing to change.')
  const { result } = await command(caller, { name: 'quotes.templates.update', idempotencyKey, input: { templateId, ...body }, record: { type: 'QuoteTemplate', id: template.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await readTemplate(tx, template.id))!
    if (current.status === 'ARCHIVED') throw new InvalidStateError('The template is archived: restore it before changing it.')
    const before = { ...headerOf(current), paymentTermsId: current.paymentTermsId }
    const depositPct = body.depositPct === undefined ? before.depositPct : blank(body.depositPct)
    const next = {
      name: body.name ?? before.name,
      description: body.description === undefined ? before.description : blank(body.description),
      language: body.language ?? before.language,
      currency: body.currency ?? before.currency,
      validityDays: body.validityDays === undefined ? before.validityDays : body.validityDays,
      firmOffer: body.firmOffer ?? before.firmOffer,
      acceptanceMode: body.acceptanceMode ?? before.acceptanceMode,
      depositPct,
      depositKind: depositPct === null ? null : (body.depositKind ?? before.depositKind ?? 'ACCONTO'),
      paymentTermsId: body.paymentTermsId === undefined ? before.paymentTermsId : body.paymentTermsId,
      termsText: body.termsText === undefined ? before.termsText : blank(body.termsText),
      termsVersion: body.termsVersion === undefined ? before.termsVersion : blank(body.termsVersion),
      incoterm: body.incoterm === undefined ? before.incoterm : blank(body.incoterm),
      incotermPlace: body.incotermPlace === undefined ? before.incotermPlace : blank(body.incotermPlace),
      shipComplete: body.shipComplete ?? before.shipComplete,
    }
    // Clearing an Incoterm clears its place with it (both or neither).
    const cleared = body.incoterm === null && body.incotermPlace === undefined ? { ...next, incotermPlace: null } : next
    const issues = [...templateHeaderProblems(cleared), ...(await termsProblems(tx, cleared.paymentTermsId, current.companyId))]
    if (issues.length > 0) throw invalid(issues)
    await tx.quoteTemplate
      .update({
        where: { id: current.id },
        data: { ...cleared, name: cleared.name.trim(), depositKind: cleared.depositKind as Prisma.QuoteTemplateUpdateInput['depositKind'] },
        select: { id: true },
      })
      .catch(databaseRefusal)
    tools.audit({ action: 'quotes.templates.update', recordType: 'QuoteTemplate', recordId: current.id, companyId: current.companyId, before, after: cleared })
    emitChanged(tools, current, 'CHANGED', fields)
    return { template: await templateView(tx, context, (await readTemplate(tx, current.id))!) }
  })
  return result
}

/** PUT /sales/quote-templates/:templateId/lines: the whole list (a line left out is removed). */
export async function replaceLines(caller: CommandCaller, templateId: string, body: ReplaceLinesBody, idempotencyKey?: string) {
  const { context, template } = await officeTemplate(caller, templateId)
  assertMayManage(context, template)
  const lines = body.lines.map(lineInputOf)
  const { result } = await command(caller, { name: 'quotes.templates.lines', idempotencyKey, input: { templateId, ...body }, record: { type: 'QuoteTemplate', id: template.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await readTemplate(tx, template.id))!
    if (current.status === 'ARCHIVED') throw new InvalidStateError('The template is archived: restore it before changing it.')
    await checkLines(tx, lines, current.companyId)
    const before = await tx.quoteTemplateLine.findMany({ where: { templateId: current.id }, select: TEMPLATE_LINE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    await tx.quoteTemplateLine.deleteMany({ where: { templateId: current.id } })
    await writeLines(tools, current.id, lines).catch(databaseRefusal)
    tools.audit({
      action: 'quotes.templates.lines',
      recordType: 'QuoteTemplate',
      recordId: current.id,
      companyId: current.companyId,
      before: { lines: before.map((line) => ({ seq: line.seq, section: line.section, kind: line.kind, feeKind: line.feeKind, styleId: line.styleId, colourwayId: line.colourwayId, sizes: sizesOf(line.sizeQuantities), unitPrice: markMoney('price', line.unitPrice === null ? null : priceText(line.unitPrice.toString())), description: line.description, note: line.note })) },
      after: { lines: auditLines(lines) },
    })
    emitChanged(tools, current, 'LINES', ['lines'])
    return { template: await templateView(tx, context, (await readTemplate(tx, current.id))!) }
  })
  return result
}

/** POST …/archive and …/restore: a template is never deleted (the quotes started from it name it). */
export async function setTemplateStatus(caller: CommandCaller, templateId: string, to: 'ARCHIVED' | 'ACTIVE', body: { readonly version: number }, idempotencyKey?: string) {
  const { context, template } = await officeTemplate(caller, templateId)
  assertMayManage(context, template)
  const { result } = await command(caller, { name: to === 'ARCHIVED' ? 'quotes.templates.archive' : 'quotes.templates.restore', idempotencyKey, input: { templateId, ...body }, record: { type: 'QuoteTemplate', id: template.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await readTemplate(tx, template.id))!
    if (current.status === to) throw new InvalidStateError(to === 'ARCHIVED' ? 'The template is archived already.' : 'The template is in use already.')
    await tx.quoteTemplate.update({ where: { id: current.id }, data: { status: to }, select: { id: true } })
    tools.audit({ action: to === 'ARCHIVED' ? 'quotes.templates.archive' : 'quotes.templates.restore', recordType: 'QuoteTemplate', recordId: current.id, companyId: current.companyId, before: { status: current.status }, after: { status: to } })
    emitChanged(tools, current, to === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', ['status'])
    return { template: await templateView(tx, context, (await readTemplate(tx, current.id))!) }
  })
  return result
}

// ---- a quote saved as a template ---------------------------------------------------------------------------------------------

/**
 * POST /sales/quote-templates/from-quote: the quote's current version as a new template: its terms (language, firm offer,
 * acceptance mode, deposit, payment terms, T&C, Incoterm and place, ship complete), its size grid lines (style, colourway,
 * pieces per size, section, text, note; a unit price only where the line was priced by hand, else the list prices it at use)
 * and its fee lines. A made-to-measure unit is not kept (its rider is the customer's).
 */
export async function templateFromQuote(caller: CommandCaller, body: FromQuoteBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const quote = await officeQuote(caller, body.quoteId)
  const companyId = body.companyId === undefined ? quote.companyId : body.companyId
  if (companyId !== null && companyId !== quote.companyId && !can(actorOf(context), QUOTES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  assertMayCreate(context, companyId)
  const { result } = await command(caller, { name: 'quotes.templates.fromQuote', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const current = (await readQuote(tx, quote.id))!
    const version = await readCurrentVersion(tx, current)
    const extra = await tx.quoteVersion.findUniqueOrThrow({ where: { id: version.id }, select: { incoterm: true, incotermPlace: true, shipComplete: true, acceptanceMode: true } })
    const lines = await tx.quoteLine.findMany({ where: { versionId: version.id }, select: { id: true, seq: true, section: true, kind: true, feeKind: true, styleId: true, colourwayId: true, unitPrice: true, listUnitPrice: true, description: true, note: true }, orderBy: { seq: 'asc' } })
    const sizes = lines.length === 0 ? [] : await tx.quoteLineSize.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true } })
    const kept = lines.filter((line) => line.kind !== 'MADE_TO_MEASURE')
    const inputs: TemplateLineInput[] = kept.map((line) => {
      const grid = Object.fromEntries(sizes.filter((row) => row.lineId === line.id && row.quantity > 0).map((row) => [row.size, row.quantity]))
      const byHand = line.kind === 'FEE' || line.listUnitPrice === null || priceText(line.listUnitPrice.toString()) !== priceText(line.unitPrice.toString())
      return {
        seq: line.seq,
        section: line.section,
        kind: line.kind === 'FEE' ? 'FEE' : 'SIZE_GRID',
        feeKind: (line.feeKind ?? null) as SalesFeeKind | null,
        styleId: line.styleId,
        colourwayId: line.colourwayId,
        sizes: line.kind === 'FEE' || Object.keys(grid).length === 0 ? null : grid,
        unitPrice: byHand && line.unitPrice.gt(0) ? priceText(line.unitPrice.toString()) : null,
        description: line.description,
        note: line.note,
      }
    })
    const header = {
      name: body.name,
      description: blank(body.description),
      language: version.language,
      currency: version.currency,
      validityDays: null,
      firmOffer: version.firmOffer,
      acceptanceMode: extra.acceptanceMode as StoredAcceptanceMode,
      depositPct: version.depositPct === null ? null : version.depositPct.toString(),
      depositKind: version.depositPct === null ? null : (version.depositKind ?? 'ACCONTO'),
      paymentTermsId: version.paymentTermsId,
      termsText: version.termsText,
      termsVersion: version.termsVersion,
      incoterm: extra.incoterm,
      incotermPlace: extra.incotermPlace,
      shipComplete: extra.shipComplete,
    }
    return insertTemplate(tools, context, companyId, header, inputs, 'quotes.templates.fromQuote', { quoteId: current.id, number: current.number, versionId: version.id, revision: version.revision, leftOut: lines.length - kept.length })
  })
  return result
}

