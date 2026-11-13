import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { QUOTES_TEMPLATES_MANAGE } from '@nexus/factory-domain/sales/quote-templates/permissions'
import type { TemplateLineKind } from '@nexus/factory-domain/sales/quote-templates/rules'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { priceText, type SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { StoredAcceptanceMode } from '@nexus/factory-domain/sales/quote-terms/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf, type Reader } from '../quotes/store'

/**
 * Quote templates' reads and who may act on one (B-W2b-294; SAL-144, SAL-252; factory-db sales-pricing.prisma QuoteTemplate,
 * QuoteTemplateLine): a template of a company is read with quotes.view over that company and kept with quotes.templates.manage
 * over it; a template of every company (companyId null) is read by anyone who reads quotes and kept only with a grant over
 * every company.
 */

export const TEMPLATE_COLUMNS = {
  id: true,
  companyId: true,
  name: true,
  description: true,
  language: true,
  currency: true,
  validityDays: true,
  firmOffer: true,
  acceptanceMode: true,
  depositPct: true,
  depositKind: true,
  paymentTermsId: true,
  termsText: true,
  termsVersion: true,
  incoterm: true,
  incotermPlace: true,
  shipComplete: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.QuoteTemplateSelect
export type TemplateRow = Prisma.QuoteTemplateGetPayload<{ select: typeof TEMPLATE_COLUMNS }>

export const TEMPLATE_LINE_COLUMNS = {
  id: true,
  templateId: true,
  seq: true,
  section: true,
  kind: true,
  feeKind: true,
  styleId: true,
  colourwayId: true,
  sizeQuantities: true,
  unitPrice: true,
  description: true,
  note: true,
} as const satisfies Prisma.QuoteTemplateLineSelect
export type TemplateLineRow = Prisma.QuoteTemplateLineGetPayload<{ select: typeof TEMPLATE_LINE_COLUMNS }>

/** May read: quotes.view over its company (a template of every company: quotes.view anywhere). */
export const mayRead = (context: OfficeContext, template: Pick<TemplateRow, 'companyId'>): boolean => can(actorOf(context), QUOTES_VIEW, template.companyId ? { companyId: template.companyId } : {})

/** May keep: quotes.templates.manage over its company, or over every company for a template of every company. */
export function mayManage(context: OfficeContext, template: Pick<TemplateRow, 'companyId'>): boolean {
  const actor = actorOf(context)
  if (template.companyId !== null) return can(actor, QUOTES_TEMPLATES_MANAGE, { companyId: template.companyId })
  return grantsFor(actor, QUOTES_TEMPLATES_MANAGE).some((grant) => grant.companies === 'all')
}

export function assertMayManage(context: OfficeContext, template: Pick<TemplateRow, 'companyId'>): void {
  if (mayManage(context, template)) return
  throw new ForbiddenError(template.companyId === null ? 'A template of every company is kept only with quotes.templates.manage over every company.' : 'Keeping this template needs quotes.templates.manage for its company.')
}

export async function readTemplate(db: Reader, templateId: string): Promise<TemplateRow | null> {
  if (!isUuid(templateId)) return null
  return db.quoteTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_COLUMNS })
}

/** The template the office may read (else 404). */
export async function officeTemplate(caller: CommandCaller, templateId: string): Promise<{ context: OfficeContext; template: TemplateRow }> {
  const context = officeContextOf(caller)
  const template = await caller.withClient((client) => readTemplate(client, templateId))
  if (!template || !mayRead(context, template)) throw new NotFoundError('Quote template not found.')
  return { context, template }
}

export const sizesOf = (value: unknown): Record<string, number> | null => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  return entries.length === 0 ? null : Object.fromEntries(entries)
}

const decimalText = (value: Prisma.Decimal | null): string | null => (value === null ? null : priceText(value.toString()))

/** The template as the record reads it: its lines with their styles and colourways, how often it was used. */
export async function templateView(db: Reader, context: OfficeContext, template: TemplateRow) {
  const lines = await db.quoteTemplateLine.findMany({ where: { templateId: template.id }, select: TEMPLATE_LINE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true, name: true, status: true } })).map((row) => [row.id, row]))
  const colourwayIds = [...new Set(lines.flatMap((line) => (line.colourwayId ? [line.colourwayId] : [])))]
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const company = template.companyId ? await db.company.findUnique({ where: { id: template.companyId }, select: { id: true, code: true, legalName: true } }) : null
  const terms = template.paymentTermsId ? await db.paymentTerms.findUnique({ where: { id: template.paymentTermsId }, select: { name: true } }) : null
  const used = await db.quote.count({ where: { templateId: template.id } })
  const sections = [...new Set(lines.flatMap((line) => (line.section ? [line.section] : [])))]
  return {
    id: template.id,
    companyId: template.companyId,
    company: company ? { id: company.id, code: company.code, name: company.legalName } : null,
    name: template.name,
    description: template.description,
    language: template.language,
    currency: template.currency,
    validityDays: template.validityDays,
    acceptanceMode: template.acceptanceMode as StoredAcceptanceMode,
    incoterm: template.incoterm,
    incotermPlace: template.incotermPlace,
    shipComplete: template.shipComplete,
    status: template.status as 'ACTIVE' | 'ARCHIVED',
    lineCount: lines.length,
    sections,
    used,
    version: template.version,
    updatedAt: toUtcIso(template.updatedAt),
    firmOffer: template.firmOffer,
    depositPct: decimalText(template.depositPct),
    depositKind: template.depositKind,
    paymentTermsId: template.paymentTermsId,
    paymentTermsName: terms?.name ?? null,
    termsText: template.termsText,
    termsVersion: template.termsVersion,
    lines: lines.map((line) => {
      const style = styles.get(line.styleId)
      const colourway = line.colourwayId ? colourways.get(line.colourwayId) : undefined
      const sizes = sizesOf(line.sizeQuantities)
      return {
        id: line.id,
        seq: line.seq,
        section: line.section,
        kind: line.kind as TemplateLineKind,
        feeKind: line.feeKind as SalesFeeKind | null,
        styleId: line.styleId,
        style: { code: style?.code ?? '', name: style?.name ?? '', status: style?.status ?? 'ARCHIVED' },
        colourwayId: line.colourwayId,
        colourway: colourway ? { code: colourway.code, name: colourway.name } : null,
        sizes,
        pieces: sizes ? Object.values(sizes).reduce((sum, pieces) => sum + pieces, 0) : 0,
        unitPrice: asMoney('price', decimalText(line.unitPrice)),
        description: line.description,
        note: line.note,
      }
    }),
    mayManage: mayManage(context, template),
    createdById: template.createdById,
    createdAt: toUtcIso(template.createdAt),
  }
}
export type TemplateView = Awaited<ReturnType<typeof templateView>>

export const invalid = (issues: readonly Issue[], fallback = 'The template cannot be saved.'): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : fallback, [...issues])

/** A database refusal (the templates' guards: check_violation in words) as a 409; anything else unchanged. */
export function databaseRefusal(error: unknown): never {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('sales pricing: ')) {
    const words = cause.originalMessage.slice('sales pricing: '.length).replace(/ [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')
    throw new DomainError('conflict', `${words.charAt(0).toUpperCase()}${words.slice(1)}.`, [{ path: 'body', message: words }])
  }
  throw error
}
