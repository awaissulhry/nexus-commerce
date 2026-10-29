import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { GateCover } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { daysToExpiry } from '@nexus/factory-domain/compliance/certificates/rules'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { StyleComplianceView } from '@nexus/factory-domain/product/compliance/contracts'
import { STYLE_COMPLIANCE_VIEW } from '@nexus/factory-domain/product/compliance/permissions'
import {
  blockersOf,
  classificationOf,
  complianceChecks,
  coverageCell,
  coverageCounts,
  currentDocument,
  DOCUMENT_CONTENT_TYPE,
  documentLanguages,
  documentStatus,
  makerOf,
  type ComplianceCheck,
  type CoverageCell,
  type DocumentFacts,
  type DocumentKind,
  type DocumentStatus,
  type Maker,
  type PostalAddress,
} from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory, ProductType } from '@nexus/factory-domain/product/styles/rules'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { officeOf } from '../../compliance/certificates/certificates'
import { gateRequestFor } from '../../compliance/certificates/gate'

/**
 * The style compliance tab, read side (B-W1-20; A2 SCR-045; PRD-270, QHS-103, LOG-020; Reg. (EU) 2016/425): the
 * style's PPE classification, its certificate coverage per colourway × size on a day (B-W1-12's gate: the style's
 * coverages are read once with `gateRequestFor`, then the domain gate answers each cell, as the work-order release
 * does), its signed DoC and leaflet per language for one style revision, and what blocks production, labels and
 * shipping. The rules are factory-domain's product/compliance; this file reads the facts, one query after another
 * (one connection runs one query at a time; no select with several relations inside a transaction).
 *
 * `currentDocFor(tx, styleId, revisionNo, kind, language)` is the shipping step's question (B-W1-49: the DoC valid on
 * the shipping day is copied onto the shipment, shared with its party): the document issued for exactly that style
 * revision, with its confirmed file, or null.
 */

export type Reader = FactoryClient | CommandTx

let clock: Clock = serverClock
/** Test only: the clock of the tab's commands and of "today" (default the server clock). */
export function useStyleComplianceClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const complianceClock = (): Clock => clock
export const todayOf = (): BusinessDate => businessDate(clock.now())

/** command() on the tab's clock. */
export function complianceCommand<Result, State extends string = string, Facts = undefined>(
  caller: CommandCaller,
  spec: CommandSpec<State, Facts>,
  work: (tools: CommandTools) => Promise<Result>,
) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

// ---- the style ----------------------------------------------------------------------------------------------------------

export const STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  status: true,
  companyId: true,
  productType: true,
  brandPartyId: true,
  mtmAllowed: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  sizes: true,
} as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

/** The style as the caller may see it here (compliance.certificates.view over its company); otherwise not found. */
export async function readVisibleStyle(client: Reader, context: RequestContext, styleId: string): Promise<StyleRow> {
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const style = await client.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
  if (!style || !can(actorOf(context), STYLE_COMPLIANCE_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
  return style
}

export const styleFactsOf = (style: StyleRow) => ({
  id: style.id,
  code: style.code,
  productType: style.productType as ProductType,
  ppeCategory: style.ppeCategory as PpeCategory,
  ppeStandard: style.ppeStandard,
  ppeClass: style.ppeClass,
  brandPartyId: style.brandPartyId,
})

const REVISION_SELECT = { id: true, revision: true, status: true, releasedAt: true, labelTemplateId: true } as const satisfies Prisma.StyleRevisionSelect
type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_SELECT }>

const LABEL_SELECT = { id: true, code: true, revision: true, status: true, languages: true, makerPartyId: true, makerName: true, makerAddress: true } as const satisfies Prisma.LabelTemplateSelect
type LabelRow = Prisma.LabelTemplateGetPayload<{ select: typeof LABEL_SELECT }>

/** The asked revision (of this style), else the released one, else the newest draft, else the newest. */
function chosenRevision(revisions: readonly RevisionRow[], askedId: string | undefined): RevisionRow | null {
  if (askedId !== undefined) {
    const asked = revisions.find((revision) => revision.id === askedId)
    if (!asked) throw new ValidationError('The revision is not valid.', [{ path: 'querystring/revisionId', message: 'Not a revision of the style.' }])
    return asked
  }
  const newest = [...revisions].sort((a, b) => b.revision - a.revision)
  return newest.find((revision) => revision.status === 'RELEASED') ?? newest.find((revision) => revision.status === 'DRAFT') ?? newest[0] ?? null
}

// ---- the documents ------------------------------------------------------------------------------------------------------

export const DOCUMENT_SELECT = {
  id: true,
  styleId: true,
  companyId: true,
  kind: true,
  language: true,
  revision: true,
  number: true,
  status: true,
  makerPartyId: true,
  makerName: true,
  makerAddress: true,
  standards: true,
  issuedAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.ComplianceDocumentSelect
export type DocumentRow = Prisma.ComplianceDocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>

export const FILE_SELECT = {
  id: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  status: true,
  quarantineReason: true,
  availableAt: true,
  retainUntil: true,
  createdAt: true,
} as const satisfies Prisma.StoredFileSelect
export type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_SELECT }>

/** A document's file versions: its DOCUMENT files (the signed PDF and its replacements), newest first. */
export async function readDocumentFiles(client: Reader, documentIds: readonly string[]): Promise<FileRow[]> {
  if (documentIds.length === 0) return []
  return client.storedFile.findMany({
    where: { recordType: 'ComplianceDocument', recordId: { in: [...documentIds] }, kind: 'DOCUMENT', status: { not: 'DELETED' } },
    select: FILE_SELECT,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
}

/** The version in force: the newest confirmed PDF (a file of another type never counts as the signed document). */
export function currentFileOf(files: readonly FileRow[]): FileRow | null {
  const confirmed = files.filter((file) => file.status === 'AVAILABLE' && file.availableAt !== null && file.contentType === DOCUMENT_CONTENT_TYPE)
  return (
    [...confirmed].sort((a, b) => b.availableAt!.getTime() - a.availableAt!.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))[0] ?? null
  )
}

/** Made after the other file (the ids are UUIDv7: time ordered, for files made in the same millisecond). */
const newer = (file: FileRow, than: FileRow): boolean => file.createdAt.getTime() > than.createdAt.getTime() || (file.createdAt.getTime() === than.createdAt.getTime() && file.id > than.id)

export function documentFactsOf(row: DocumentRow, files: readonly FileRow[]): DocumentFacts {
  const own = files.filter((file) => file.recordId === row.id)
  const current = currentFileOf(own)
  return {
    id: row.id,
    kind: row.kind as DocumentKind,
    language: row.language,
    revision: row.revision,
    status: row.status as DocumentStatus,
    number: row.number,
    issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null,
    currentFile: current
      ? { id: current.id, originalName: current.originalName, sizeBytes: current.sizeBytes, sha256: current.sha256, availableAt: toUtcIso(current.availableAt!) }
      : null,
    versions: own.filter((file) => file.status === 'AVAILABLE' && file.contentType === DOCUMENT_CONTENT_TYPE).length,
    pendingUpload: own.some((file) => file.status === 'PENDING_UPLOAD' && (current === null || newer(file, current))),
  }
}

/** The style's compliance documents (optionally one kind and language) with their files. */
export async function readDocuments(client: Reader, styleId: string, filter: { kind?: DocumentKind | undefined; language?: string | undefined } = {}) {
  const rows = await client.complianceDocument.findMany({
    where: { styleId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.language ? { language: filter.language } : {}) },
    select: DOCUMENT_SELECT,
    orderBy: [{ kind: 'asc' }, { language: 'asc' }, { revision: 'desc' }],
  })
  const files = await readDocumentFiles(client, rows.map((row) => row.id))
  return { rows, files, facts: rows.map((row) => documentFactsOf(row, files)) }
}

export interface CurrentDoc {
  readonly document: DocumentFacts & { readonly styleId: string; readonly companyId: string | null; readonly makerName: string; readonly makerAddress: string }
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string; readonly sizeBytes: number; readonly sha256: string; readonly availableAt: string }
}

/**
 * The DoC or leaflet that goes with garments of this style revision (by its number) in this language, with its signed
 * file, or null (B-W1-49 copies that file onto the shipment, shared with the shipment's party: the copy is the evidence
 * of what travelled with the goods). Reads with the caller's client or transaction; checks no permission (the caller's
 * own command did). The rule is factory-domain's `currentDocument`: an older revision's document never counts.
 */
export async function currentDocFor(tx: Reader, styleId: string, revisionNo: number, kind: DocumentKind, language: string): Promise<CurrentDoc | null> {
  const { rows, files, facts } = await readDocuments(tx, styleId, { kind, language })
  const current = currentDocument(facts, revisionNo, kind, language)
  if (!current) return null
  const row = rows.find((entry) => entry.id === current.id)!
  const file = files.find((entry) => entry.id === current.currentFile!.id)!
  return {
    document: { ...current, styleId: row.styleId, companyId: row.companyId, makerName: row.makerName, makerAddress: row.makerAddress },
    file: { id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes, sha256: file.sha256, availableAt: toUtcIso(file.availableAt!) },
  }
}

// ---- the maker a new DoC names --------------------------------------------------------------------------------------------

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)

/** Company.address ({ line1, line2?, postalCode, city, province?, country }) as a postal address, or null. */
function postalAddressOf(value: unknown): PostalAddress | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const line1 = text(entry.line1)
  const postalCode = text(entry.postalCode)
  const city = text(entry.city)
  const country = text(entry.country)
  if (!line1 || !postalCode || !city || !country) return null
  return { line1, line2: text(entry.line2), postalCode, city, province: text(entry.province), country }
}

/** The maker a DoC of this style revision names (factory-domain makerOf): the label's, the brand's or the company's. */
export async function readMaker(client: Reader, style: Pick<StyleRow, 'brandPartyId' | 'companyId'>, label: Pick<LabelRow, 'makerPartyId' | 'makerName' | 'makerAddress'> | null): Promise<Maker | null> {
  if (label) return makerOf({ label: { makerPartyId: label.makerPartyId, makerName: label.makerName, makerAddress: label.makerAddress }, brand: null, company: null })
  if (style.brandPartyId) {
    const party = await client.party.findUnique({ where: { id: style.brandPartyId }, select: { id: true, legalName: true } })
    const address = party
      ? await client.partyAddress.findFirst({
          where: { partyId: party.id, status: 'ACTIVE', kinds: { has: 'REGISTERED' } },
          select: { line1: true, line2: true, postalCode: true, city: true, province: true, country: true },
          orderBy: { createdAt: 'asc' },
        })
      : null
    return makerOf({ label: null, brand: party ? { id: party.id, legalName: party.legalName, address } : null, company: null })
  }
  const company = style.companyId ? await client.company.findUnique({ where: { id: style.companyId }, select: { legalName: true, address: true } }) : null
  return makerOf({ label: null, brand: null, company: company ? { legalName: company.legalName, address: postalAddressOf(company.address) } : null })
}

export async function readLabel(client: Reader, labelTemplateId: string | null): Promise<LabelRow | null> {
  return labelTemplateId ? client.labelTemplate.findUnique({ where: { id: labelTemplateId }, select: LABEL_SELECT }) : null
}

// ---- the tab ---------------------------------------------------------------------------------------------------------------

const checkView = (check: ComplianceCheck) => ({ ...check, blocks: [...check.blocks], problems: [...check.problems] })

export interface ComplianceQuery {
  readonly revisionId?: string | undefined
  readonly date?: BusinessDate | undefined
}

/** GET /product/styles/:styleId/compliance: compliance.certificates.view over the style's company. */
export async function styleCompliance(caller: CommandCaller, styleId: string, query: ComplianceQuery): Promise<StyleComplianceView> {
  const context = officeOf(caller)
  const date = query.date ?? todayOf()
  return caller.withClient(async (client) => {
    const style = await readVisibleStyle(client, context, styleId)
    const classification = classificationOf(styleFactsOf(style))

    const revisions = await client.styleRevision.findMany({ where: { styleId }, select: REVISION_SELECT, orderBy: { revision: 'asc' } })
    const revision = chosenRevision(revisions, query.revisionId)
    const released = revisions.find((entry) => entry.status === 'RELEASED') ?? null
    const label = await readLabel(client, revision?.labelTemplateId ?? null)

    // Coverage: rows = the style's colourways (archived ones too, so a gap on them stays visible), columns = its range.
    const colourways = await client.colourway.findMany({ where: { styleId }, select: { id: true, code: true, name: true, status: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const variants = await client.variant.findMany({ where: { styleId, status: 'ACTIVE' }, select: { colourwayId: true, size: true } })
    const offered = new Set(variants.map((variant) => `${variant.colourwayId}|${variant.size}`))
    let covers: readonly GateCover[] = []
    let cells: CoverageCell[] = []
    if (colourways.length > 0 && style.sizes.length > 0) {
      const { request } = await gateRequestFor(client, { styleId, colourwayId: colourways[0]!.id, size: style.sizes[0]! }, date)
      if (!('size' in request)) throw new Error('unreachable: a size gate request')
      covers = request.covers
      cells = colourways.flatMap((colourway) =>
        style.sizes.map((size) => coverageCell(request, { colourwayId: colourway.id, colourwayCode: colourway.code, size, offered: offered.has(`${colourway.id}|${size}`) })),
      )
    }

    const { facts } = await readDocuments(client, styleId)
    const expectedLanguages = label?.languages ?? []
    const number = revision?.revision ?? null
    const statuses = (kind: DocumentKind) => documentLanguages(kind, facts, expectedLanguages).map((language) => documentStatus(kind, language, number, facts))
    const declarations = statuses('DECLARATION_OF_CONFORMITY')
    const leaflets = statuses('USER_INFORMATION')
    const maker = classification.documentsRequired ? await readMaker(client, style, label) : null

    const checks = complianceChecks({
      styleId,
      classification,
      revision: revision ? { id: revision.id, revision: revision.revision, status: revision.status, styleId } : null,
      released: released ? { id: released.id, revision: released.revision } : null,
      label: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status } : null,
      cells,
      documents: { DECLARATION_OF_CONFORMITY: declarations, USER_INFORMATION: leaflets },
    })

    return {
      style: {
        id: style.id,
        code: style.code,
        name: style.name,
        status: style.status,
        companyId: style.companyId,
        productType: style.productType,
        brandPartyId: style.brandPartyId,
        mtmAllowed: style.mtmAllowed,
      },
      date,
      classification,
      revision: revision
        ? {
            id: revision.id,
            revision: revision.revision,
            status: revision.status,
            releasedAt: revision.releasedAt ? toUtcIso(revision.releasedAt) : null,
            isReleased: revision.status === 'RELEASED',
            labelTemplate: label ? { id: label.id, code: label.code, revision: label.revision, status: label.status, languages: label.languages } : null,
          }
        : null,
      releasedRevision: released ? { id: released.id, revision: released.revision } : null,
      revisions: [...revisions].reverse().map((entry) => ({ id: entry.id, revision: entry.revision, status: entry.status })),
      coverage: {
        required: classification.certificateRequired,
        colourways,
        sizes: style.sizes,
        cells: cells.map((cell) => ({ ...cell, reasons: [...cell.reasons] })),
        counts: coverageCounts(cells),
        certificates: covers.map((cover) => ({
          coverageId: cover.coverageId,
          colourwayIds: [...cover.colourwayIds],
          sizes: [...cover.sizes],
          allowsMadeToMeasure: cover.allowsMadeToMeasure,
          certificate: {
            id: cover.certificate.id,
            number: cover.certificate.number,
            standard: cover.certificate.standard,
            ppeClass: cover.certificate.ppeClass,
            notifiedBodyName: cover.certificate.notifiedBodyName,
            notifiedBodyNumber: cover.certificate.notifiedBodyNumber,
            validFrom: cover.certificate.validFrom,
            validTo: cover.certificate.validTo,
            status: cover.certificate.status,
            daysToExpiry: daysToExpiry(cover.certificate.validTo, date),
          },
        })),
      },
      documents: { required: classification.documentsRequired, expectedLanguages, declarations, leaflets, maker },
      checks: checks.map(checkView),
      blockers: blockersOf(checks).map(checkView),
    }
  })
}

