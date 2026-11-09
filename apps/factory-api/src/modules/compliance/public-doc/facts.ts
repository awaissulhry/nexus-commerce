import type { FactoryClient } from '@nexus/factory-db'
import type { PublicDocKind } from '@nexus/factory-domain/compliance/public-doc/code'
import type { PublicDocPage } from '@nexus/factory-domain/compliance/public-doc/contracts'
import { batchSpans, careLinesOf, namesOf, type DocOnFile, type LabelFacts, type PublicDocFacts, type RevisionFacts } from '@nexus/factory-domain/compliance/public-doc/rules'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { DocumentKind, DocumentStatus } from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory } from '@nexus/factory-domain/product/styles/rules'
import type { CertificateFacts } from '@nexus/factory-domain/sales/portal-documents/conformity'
import { publicBrandingOf } from '../../../platform/branding/branding'
import { currentFileOf, readDocumentFiles } from '../../product/compliance/read'
import { coveringCertificates, readCertificates, type CertificateRow } from '../../sales/portal-documents/store'

/**
 * What the public DoC page of one record needs (B-W2b-166), read with the client of the record's tenant in its SYSTEM
 * scope (row-level security stays forced: the tenant's rows only) after resolve.ts found the code: the batch (a released
 * work order) or the style, the style's revisions with their garment label templates, every compliance document of the
 * style with its newest confirmed PDF, the release days of its batches, the certificates the documents cite and those
 * covering the style, and whose page it is (the company's public branding and conversation address). Nothing here is a
 * price, a cost or a person.
 */

type Reader = FactoryClient

const LABEL_SELECT = { id: true, makerName: true, makerAddress: true, importerName: true, importerAddress: true, languages: true, care: true } as const

const labelFacts = (row: { makerName: string; makerAddress: string; importerName: string | null; importerAddress: string | null; languages: string[]; care: unknown }): LabelFacts => ({
  makerName: row.makerName,
  makerAddress: row.makerAddress,
  importerName: row.importerName,
  importerAddress: row.importerAddress,
  languages: row.languages,
  care: careLinesOf(row.care),
})

const certificateFacts = (row: CertificateRow): CertificateFacts => ({
  id: row.id,
  number: row.number,
  standard: row.standard,
  ppeClass: row.ppeClass,
  notifiedBodyName: row.notifiedBodyName,
  notifiedBodyNumber: row.notifiedBodyNumber,
  validFrom: row.validFrom.toISOString().slice(0, 10),
  validTo: row.validTo.toISOString().slice(0, 10),
  status: row.status,
  statusChangedOn: row.statusChangedAt ? businessDate(row.statusChangedAt) : null,
})

/** One record a code names, as resolve.ts found it. */
export interface CodeMatch {
  readonly tenantId: string
  readonly kind: PublicDocKind
  readonly id: string
}

export interface MatchFacts {
  readonly facts: PublicDocFacts
  /** The company whose page it is (the batch's maker company, else the style's or its declaration's, else the tenant's first). */
  readonly companyId: string | null
}

const STYLE_SELECT = { id: true, code: true, name: true, nameI18n: true, companyId: true, brandPartyId: true, ppeCategory: true, ppeStandard: true, ppeClass: true } as const

/** The facts of one match; null when the record is not (or no longer) one the page shows: a work order without a batch number. */
export async function readMatchFacts(client: Reader, match: CodeMatch, code: string, today: BusinessDate): Promise<MatchFacts | null> {
  const order =
    match.kind === 'BATCH'
      ? await client.workOrder.findUnique({ where: { id: match.id }, select: { id: true, companyId: true, styleId: true, batchNumber: true, releasedAt: true, styleRevisionId: true, labelTemplateId: true } })
      : null
  if (match.kind === 'BATCH' && (!order || order.batchNumber === null || order.releasedAt === null)) return null
  const styleId = order?.styleId ?? match.id
  const style = await client.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
  if (!style) return null

  const revisionRows = await client.styleRevision.findMany({ where: { styleId }, select: { id: true, revision: true, releasedAt: true, labelTemplateId: true }, orderBy: { revision: 'asc' } })
  const labelIds = [...new Set([...revisionRows.map((row) => row.labelTemplateId), order?.labelTemplateId ?? null].filter((value): value is string => value !== null))]
  const labels = labelIds.length > 0 ? await client.labelTemplate.findMany({ where: { id: { in: labelIds } }, select: LABEL_SELECT }) : []
  const labelOf = new Map(labels.map((row) => [row.id, labelFacts(row)]))
  const revisions: RevisionFacts[] = revisionRows.map((row) => ({ revision: row.revision, releasedAt: row.releasedAt, label: row.labelTemplateId ? (labelOf.get(row.labelTemplateId) ?? null) : null }))
  const numberOf = new Map(revisionRows.map((row) => [row.id, row.revision]))

  const documentRows = await client.complianceDocument.findMany({
    where: { styleId },
    select: { id: true, companyId: true, kind: true, language: true, revision: true, status: true, number: true, issuedAt: true, certificateId: true, makerName: true, makerAddress: true },
    orderBy: [{ kind: 'asc' }, { language: 'asc' }, { revision: 'desc' }],
  })
  const files = await readDocumentFiles(client, documentRows.map((row) => row.id))
  const documents: DocOnFile[] = documentRows.map((row) => {
    const current = currentFileOf(files.filter((file) => file.recordId === row.id))
    return {
      id: row.id,
      kind: row.kind as DocumentKind,
      language: row.language,
      revision: row.revision,
      status: row.status as DocumentStatus,
      number: row.number,
      issuedAt: row.issuedAt,
      certificateId: row.certificateId,
      makerName: row.makerName,
      makerAddress: row.makerAddress,
      file: current ? { id: current.id, name: current.originalName, sizeBytes: current.sizeBytes, sha256: current.sha256 } : null,
    }
  })

  const made = await client.workOrder.findMany({ where: { styleId, batchNumber: { not: null }, releasedAt: { not: null } }, select: { styleRevisionId: true, releasedAt: true } })
  const batches = batchSpans(made.map((row) => ({ revision: row.styleRevisionId ? (numberOf.get(row.styleRevisionId) ?? null) : null, releasedAt: row.releasedAt })))

  const citedIds = [...new Set(documentRows.map((row) => row.certificateId).filter((value): value is string => value !== null))]
  const cited = await readCertificates(client, citedIds)
  const covering = (await coveringCertificates(client, [styleId])).get(styleId) ?? []

  const facts: PublicDocFacts = {
    kind: match.kind,
    code,
    style: {
      code: style.code,
      name: style.name,
      names: namesOf(style.nameI18n),
      category: style.ppeCategory as PpeCategory,
      standard: style.ppeStandard,
      ppeClass: style.ppeClass,
      privateLabel: style.brandPartyId !== null,
    },
    batch: order
      ? {
          number: order.batchNumber!,
          revision: order.styleRevisionId ? (numberOf.get(order.styleRevisionId) ?? null) : null,
          releasedAt: order.releasedAt!,
          label: order.labelTemplateId ? (labelOf.get(order.labelTemplateId) ?? null) : null,
        }
      : null,
    revisions,
    documents,
    batches,
    cited: new Map(cited.map((row) => [row.id, certificateFacts(row)])),
    covering: covering.map(certificateFacts),
    today,
  }
  const companyId = order?.companyId ?? style.companyId ?? documentRows.find((row) => row.companyId !== null)?.companyId ?? null
  return { facts, companyId }
}

/**
 * Whose page it is: the company's public branding (an ACTIVE company; else the tenant's first ACTIVE company by code) and
 * its default conversation address (whom to ask). Null when the tenant has no active company.
 */
export async function readSender(client: Reader, companyId: string | null): Promise<{ sender: PublicDocPage['sender']; contact: PublicDocPage['contact'] } | null> {
  let branding = companyId ? await publicBrandingOf(client, companyId) : null
  if (!branding) {
    const first = await client.company.findFirst({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    branding = first ? await publicBrandingOf(client, first.id) : null
  }
  if (!branding) return null
  const identity = await client.emailIdentity.findFirst({
    where: { companyId: branding.companyId, kind: 'CONVERSATION', status: 'ACTIVE', isDefault: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { fromAddress: true },
  })
  return { sender: branding, contact: { email: identity?.fromAddress ?? null } }
}
