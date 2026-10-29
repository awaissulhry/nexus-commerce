import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { LABELS_MANAGE, LABELS_VIEW } from '@nexus/factory-domain/compliance/labels/permissions'
import { activationProblems, type LabelTemplateFacts } from '@nexus/factory-domain/compliance/labels/render'
import {
  careOf,
  compositionOf,
  contentProblems,
  labelNextStatuses,
  layoutOf,
  styleProblems,
  styleWarnings,
  type LabelStyle,
  type LabelTemplateStatus,
} from '@nexus/factory-domain/compliance/labels/rules'
import { ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { PpeCategory, ProductType } from '@nexus/factory-domain/product/styles/rules'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { serverClock, type Clock } from '../../../core/time'
import { mayWrite } from '../../product/materials/store'
import type { TemplateDetail, TemplateView } from './contract'

/**
 * The garment label templates' rows (factory-db `LabelTemplate`; B-W1-19): the columns every read names, a row as the
 * domain reads it (`factsOf`), who may see and write it, the style it marks, who uses it, and the views.
 *
 * Scope: a template belongs to its company (null: tenant-wide, every company). Reading needs LABELS_VIEW (the certificate
 * register's view) over it; writing needs LABELS_MANAGE over it, and a tenant-wide one a grant over every company. A
 * template the caller may not view is not found. Office only: the floor reads a template only through the garment-label
 * step (B-W1-44), which renders it with `garmentLabelFor` (preview.ts).
 */

export type Reader = FactoryClient | CommandTx

export const LABEL_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

let clock: Clock = serverClock
/** Test only: the clock of the label commands and of "today" (default the server clock). */
export function useLabelsClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
/** The business date now (Europe/Rome). */
export const todayOf = (): BusinessDate => businessDate(clock.now())

/** command() on the module's clock. */
export function labelCommand<Result, State extends string = string, Facts = undefined>(caller: CommandCaller, spec: CommandSpec<State, Facts>, work: (tools: CommandTools) => Promise<Result>) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** LABELS_MANAGE over the company (a tenant-wide template: a grant over every company). */
export function assertMayManage(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), LABELS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A label for every company is changed only by a role over every company.' : undefined)
  }
}

// ---- the template ----------------------------------------------------------------------------------------------------------

export const TEMPLATE_SELECT = {
  id: true,
  companyId: true,
  code: true,
  revision: true,
  name: true,
  styleId: true,
  status: true,
  languages: true,
  makerPartyId: true,
  makerName: true,
  makerAddress: true,
  importerName: true,
  importerAddress: true,
  composition: true,
  animalOriginPhrase: true,
  care: true,
  layout: true,
  widthMm: true,
  heightMm: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.LabelTemplateSelect
export type TemplateRow = Prisma.LabelTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>

/** The row as the domain reads it; what its JSON columns had wrong is in `storedProblems`. */
export function factsOf(row: TemplateRow): LabelTemplateFacts {
  const layout = layoutOf(row.layout)
  const composition = compositionOf(row.composition)
  const care = careOf(row.care)
  return {
    id: row.id,
    code: row.code,
    revision: row.revision,
    name: row.name,
    status: row.status as LabelTemplateStatus,
    styleId: row.styleId,
    companyId: row.companyId,
    storedProblems: [...layout.problems, ...composition.problems, ...care.problems],
    languages: [...row.languages],
    makerPartyId: row.makerPartyId,
    makerName: row.makerName,
    makerAddress: row.makerAddress,
    importerName: row.importerName,
    importerAddress: row.importerAddress,
    composition: composition.composition,
    animalOriginPhrase: row.animalOriginPhrase,
    care: care.care,
    layout: layout.layout,
    widthMm: row.widthMm.toFixed(2),
    heightMm: row.heightMm.toFixed(2),
  }
}

/** A template the caller may view, or not found. */
export async function readTemplate(caller: CommandCaller, templateId: string): Promise<TemplateRow> {
  const context = officeOf(caller)
  if (!isUuid(templateId)) throw new NotFoundError('Label not found.')
  const row = await caller.withClient((client) => client.labelTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_SELECT }))
  if (!row || !can(actorOf(context), LABELS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Label not found.')
  return row
}

// ---- the style it marks -------------------------------------------------------------------------------------------------

export const STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  companyId: true,
  status: true,
  productType: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  brandPartyId: true,
  sizes: true,
  baseSize: true,
  sizeScaleId: true,
  garmentTracking: true,
} as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

export const labelStyleOf = (row: StyleRow): LabelStyle => ({
  id: row.id,
  code: row.code,
  name: row.name,
  companyId: row.companyId,
  productType: row.productType as ProductType,
  ppeCategory: row.ppeCategory as PpeCategory,
  ppeStandard: row.ppeStandard,
  ppeClass: row.ppeClass,
  brandPartyId: row.brandPartyId,
})

export async function findStyle(client: Reader, styleId: string | null): Promise<StyleRow | null> {
  return styleId === null ? null : client.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
}

/** A style the caller may view here (LABELS_VIEW over its company), or not found. */
export async function readVisibleStyle(client: Reader, context: RequestContext, styleId: string): Promise<StyleRow> {
  const style = isUuid(styleId) ? await findStyle(client, styleId) : null
  if (!style || !can(actorOf(context), LABELS_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
  return style
}

// ---- who uses it --------------------------------------------------------------------------------------------------------

export interface Usage {
  readonly styleRevisions: { readonly id: string; readonly styleId: string; readonly styleCode: string; readonly revision: number; readonly status: string }[]
  readonly workOrders: { readonly count: number; readonly shown: { readonly id: string; readonly number: string; readonly status: string; readonly batchNumber: string | null }[] }
}

/** The style revisions that name the template and the work orders released with it (those the caller may view). */
export async function usageOf(client: Reader, context: RequestContext, templateId: string): Promise<Usage> {
  const revisions = await client.styleRevision.findMany({
    where: { labelTemplateId: templateId },
    select: { id: true, styleId: true, revision: true, status: true },
    orderBy: [{ styleId: 'asc' }, { revision: 'asc' }],
    take: 200,
  })
  const styles = revisions.length === 0 ? [] : await client.style.findMany({ where: { id: { in: [...new Set(revisions.map((entry) => entry.styleId))] } }, select: { id: true, code: true } })
  const codes = new Map(styles.map((style) => [style.id, style.code]))
  const count = await client.workOrder.count({ where: { labelTemplateId: templateId } })
  const orders = await client.workOrder.findMany({
    where: { labelTemplateId: templateId },
    select: { id: true, number: true, status: true, batchNumber: true, companyId: true, siteId: true },
    orderBy: [{ releasedAt: 'desc' }, { id: 'asc' }],
    take: 50,
  })
  const actor = actorOf(context)
  return {
    styleRevisions: revisions.map((entry) => ({ id: entry.id, styleId: entry.styleId, styleCode: codes.get(entry.styleId) ?? '', revision: entry.revision, status: entry.status })),
    workOrders: {
      count,
      shown: orders
        .filter((order) => can(actor, WORKORDERS_VIEW, { companyId: order.companyId, siteId: order.siteId }))
        .map((order) => ({ id: order.id, number: order.number, status: order.status, batchNumber: order.batchNumber })),
    },
  }
}

// ---- views ------------------------------------------------------------------------------------------------------------------

/** The template's problems and warnings, as activation would see them now: its own, and its style's. */
export function checksOf(facts: LabelTemplateFacts, style: LabelStyle | null, today: BusinessDate): { problems: Issue[]; warnings: Issue[] } {
  return { problems: activationProblems(facts, style, today), warnings: style ? styleWarnings(facts, style) : [] }
}

export function templateView(row: TemplateRow, style: StyleRow | null, today: BusinessDate): TemplateView {
  const facts = factsOf(row)
  const checks = checksOf(facts, style ? labelStyleOf(style) : null, today)
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    revision: row.revision,
    name: row.name,
    styleId: row.styleId,
    style: style ? { id: style.id, code: style.code, name: style.name, ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass } : null,
    status: facts.status,
    languages: [...facts.languages],
    makerPartyId: facts.makerPartyId,
    makerName: facts.makerName,
    makerAddress: facts.makerAddress,
    importerName: facts.importerName,
    importerAddress: facts.importerAddress,
    composition: facts.composition.map((part) => ({ part: part.part, fibres: part.fibres.map((fibre) => ({ ...fibre })) })),
    animalOriginPhrase: facts.animalOriginPhrase,
    care: facts.care.map((entry) => ({ symbol: entry.symbol, ...(entry.text ? { text: { ...entry.text } } : {}) })),
    layout: { ...facts.layout, fields: [...facts.layout.fields], texts: { animalOrigin: { ...facts.layout.texts.animalOrigin } } },
    widthMm: facts.widthMm,
    heightMm: facts.heightMm,
    nextStatuses: [...labelNextStatuses(facts.status)],
    problems: checks.problems,
    warnings: checks.warnings,
    activatable: facts.status === 'DRAFT' && checks.problems.length === 0,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The template with its other revisions and who uses it (SCR-053's record). */
export async function templateDetail(client: Reader, context: RequestContext, templateId: string, today: BusinessDate): Promise<TemplateDetail> {
  const row = await client.labelTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_SELECT })
  if (!row) throw new NotFoundError('Label not found.')
  const style = await findStyle(client, row.styleId)
  const revisions = await client.labelTemplate.findMany({ where: { code: row.code }, select: { id: true, revision: true, status: true, version: true, updatedAt: true }, orderBy: { revision: 'asc' } })
  return {
    ...templateView(row, style, today),
    revisions: revisions.map((entry) => ({ id: entry.id, revision: entry.revision, status: entry.status as LabelTemplateStatus, version: entry.version, updatedAt: toUtcIso(entry.updatedAt) })),
    usage: await usageOf(client, context, templateId),
  }
}

/** The content problems only (a draft's save answer lists them; activation adds the style's and the fit). */
export const draftProblems = (row: TemplateRow): Issue[] => {
  const facts = factsOf(row)
  return [...facts.storedProblems, ...contentProblems(facts)]
}

/** The style's own problems with this template (assignment). */
export const markingProblems = (row: TemplateRow, style: StyleRow): Issue[] => styleProblems(factsOf(row), labelStyleOf(style))
