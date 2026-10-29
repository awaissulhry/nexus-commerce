import type { FastifyRequest } from 'fastify'
import { FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { ComplianceDocumentDetail, UploadDocumentBody } from '@nexus/factory-domain/product/compliance/contracts'
import { DECLARATIONS_MANAGE } from '@nexus/factory-domain/product/compliance/permissions'
import {
  classificationOf,
  DOCUMENT_CONTENT_TYPE,
  DOCUMENT_RETENTION_YEARS,
  DOCUMENT_WORDS,
  documentUploadProblems,
  issuePlan,
  type DocumentFacts,
  type DocumentKind,
  type DocumentStatus,
} from '@nexus/factory-domain/product/compliance/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { completeUpload, downloadFile, requestUpload, retainFilesInCommand, systemCallerOf } from '../../../platform/files/files'
import type { FileView } from '../../../platform/files/contract'
import { addYears } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { officeOf } from '../../compliance/certificates/certificates'
import { assertMayWrite, lockStyle } from '../styles/store'
import {
  complianceCommand,
  currentFileOf,
  DOCUMENT_SELECT,
  documentFactsOf,
  FILE_SELECT,
  readDocumentFiles,
  readDocuments,
  readLabel,
  readMaker,
  readVisibleStyle,
  STYLE_SELECT,
  styleFactsOf,
  type DocumentRow,
  type FileRow,
  type Reader,
} from './read'

/**
 * The signed EU Declaration of Conformity and the user information leaflet of a style revision (B-W1-20; LOG-020;
 * Reg. (EU) 2016/425 art. 8(3)(7)(8), art. 15, Annex II 1.4, Annex IX). The DoC GENERATOR is W2b (PRD-292): here the
 * Owner uploads the PDF signed by hand, per style revision and language, through the files platform:
 *
 *   announce   POST …/compliance/documents: the style must be PPE; ONE command finds the ComplianceDocument of that
 *              style, kind, language and style revision NUMBER, or makes it DRAFT (the maker it names: the revision's
 *              garment label's, else the brand's, else the company's; the style's standard); then files.requestUpload
 *              for a DOCUMENT file (application/pdf) on it → the presigned PUT
 *   confirm    POST …/documents/:documentId/files/:fileId/complete: files.completeUpload (the store's HEAD) → AVAILABLE,
 *              then ONE command on the document (its version moves): a DRAFT becomes ISSUED (the older revisions'
 *              issued ones of that kind and language SUPERSEDED; a late upload for an older revision is superseded at
 *              once), an issued one gets a new version (the earlier file is kept); the file is kept ten years
 *              (art. 8(3)); events style.compliance_document_issued | _replaced
 *   read       the documents, one with every file version, a version's 60-second download
 *
 * A file that did not match what was announced is QUARANTINED by the files platform and changes nothing here. Confirming
 * a file again changes nothing either.
 */

const WITHDRAWN = (kind: DocumentKind, language: string, revision: number) =>
  new InvalidStateError(`The ${DOCUMENT_WORDS[kind]} in ${language} for revision ${revision} was withdrawn; a withdrawn document takes no new version.`)

function mayUpload(context: RequestContext, companyId: string | null): void {
  assertMayWrite(context, DECLARATIONS_MANAGE, companyId)
  // The file itself is the files platform's (files.upload); checked first, so no DRAFT is left without its upload.
  if (!can(actorOf(context), FILES_UPLOAD, { companyId })) throw new ForbiddenError()
}

/** The document of this style as the caller may see it (its style's view), or not found. */
async function readVisibleDocument(client: Reader, context: RequestContext, styleId: string, documentId: string): Promise<DocumentRow> {
  await readVisibleStyle(client, context, styleId)
  if (!isUuid(documentId)) throw new NotFoundError('Document not found.')
  const row = await client.complianceDocument.findFirst({ where: { id: documentId, styleId }, select: DOCUMENT_SELECT })
  if (!row) throw new NotFoundError('Document not found.')
  return row
}

function detailOf(row: DocumentRow, files: readonly FileRow[]): ComplianceDocumentDetail {
  const facts = documentFactsOf(row, files)
  const current = row.status === 'ISSUED' || row.status === 'SUPERSEDED' ? currentFileOf(files.filter((file) => file.recordId === row.id)) : null
  return {
    ...facts,
    styleId: row.styleId,
    companyId: row.companyId,
    makerPartyId: row.makerPartyId,
    makerName: row.makerName,
    makerAddress: row.makerAddress,
    standards: row.standards,
    createdAt: toUtcIso(row.createdAt),
    files: files
      .filter((file) => file.recordId === row.id)
      .map((file) => ({
        id: file.id,
        originalName: file.originalName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        status: file.status,
        quarantineReason: file.quarantineReason,
        availableAt: file.availableAt ? toUtcIso(file.availableAt) : null,
        retainUntil: file.retainUntil ? toUtcIso(file.retainUntil) : null,
        createdAt: toUtcIso(file.createdAt),
        current: current !== null && file.id === current.id,
      })),
  }
}

async function detailWith(client: Reader, documentId: string): Promise<ComplianceDocumentDetail> {
  const row = await client.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: DOCUMENT_SELECT })
  return detailOf(row, await readDocumentFiles(client, [row.id]))
}

/** GET …/compliance/documents: the style's documents, every revision (filtered by kind, language, revision). */
export async function listDocuments(
  caller: CommandCaller,
  styleId: string,
  query: { kind?: DocumentKind | undefined; language?: string | undefined; revisionId?: string | undefined },
): Promise<DocumentFacts[]> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    await readVisibleStyle(client, context, styleId)
    let revision: number | undefined
    if (query.revisionId !== undefined) {
      const found = await client.styleRevision.findFirst({ where: { id: query.revisionId, styleId }, select: { revision: true } })
      if (!found) throw new ValidationError('The revision is not valid.', [{ path: 'querystring/revisionId', message: 'Not a revision of the style.' }])
      revision = found.revision
    }
    const { facts } = await readDocuments(client, styleId, { kind: query.kind, language: query.language })
    return revision === undefined ? facts : facts.filter((document) => document.revision === revision)
  })
}

/** GET …/compliance/documents/:documentId: the document with every file version, newest first. */
export async function getDocument(caller: CommandCaller, styleId: string, documentId: string): Promise<ComplianceDocumentDetail> {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await readVisibleDocument(client, context, styleId, documentId)
    return detailOf(row, await readDocumentFiles(client, [row.id]))
  })
}

/** POST …/compliance/documents: the document (made DRAFT when new) and the presigned upload of its signed PDF. */
export async function uploadDocument(caller: CommandCaller, styleId: string, body: UploadDocumentBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = documentUploadProblems(body)
  if (problems.length > 0) throw new ValidationError('The upload is not valid.', problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
  const style = await caller.withClient((client) => readVisibleStyle(client, context, styleId))
  mayUpload(context, style.companyId)
  if (!classificationOf(styleFactsOf(style)).documentsRequired) {
    throw new InvalidStateError(`Style ${style.code} is not PPE: it has no Declaration of Conformity or user information leaflet.`)
  }

  const { result: documentId } = await complianceCommand(
    caller,
    { name: 'product.compliance.prepareDocument', idempotencyKey, input: { styleId, ...body } },
    async ({ tx, audit, context: inside }) => {
      // The style row first: two first uploads of one document take turns (the second finds the first one's row).
      await lockStyle(tx, styleId)
      const current = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_SELECT })
      const revision = await tx.styleRevision.findFirst({ where: { id: body.revisionId, styleId }, select: { id: true, revision: true, labelTemplateId: true } })
      if (!revision) throw new ValidationError('The upload is not valid.', [{ path: 'body/revisionId', message: 'Not a revision of the style.' }])
      const announced = { revisionId: revision.id, originalName: body.originalName, sizeBytes: body.sizeBytes, sha256: body.sha256 }

      const existing = await tx.complianceDocument.findFirst({
        where: { styleId, kind: body.kind, language: body.language, revision: revision.revision },
        select: DOCUMENT_SELECT,
      })
      if (existing) {
        if (existing.status === 'WITHDRAWN') throw WITHDRAWN(body.kind, body.language, revision.revision)
        const number = body.number ?? undefined
        if (number !== undefined && number !== existing.number) {
          if (existing.status !== 'DRAFT') {
            throw new ValidationError('The upload is not valid.', [
              { path: 'body/number', message: `This document is ${existing.status} with number ${existing.number ?? '(none)'}; an issued document's number never changes.` },
            ])
          }
          await tx.complianceDocument.update({ where: { id: existing.id }, data: { number }, select: { id: true } })
        }
        // A new version announced (or the first upload of a draft tried again): the file's own row is the files platform's.
        audit({
          recordType: 'ComplianceDocument',
          recordId: existing.id,
          companyId: existing.companyId,
          before: { number: existing.number },
          after: { number: number ?? existing.number, status: existing.status, upload: announced },
        })
        return existing.id
      }

      const label = await readLabel(tx, revision.labelTemplateId)
      const maker = await readMaker(tx, current, label)
      if (!maker) {
        throw new InvalidStateError(
          `The maker the document names is not known: set a garment label template on revision ${revision.revision}, or give the ${current.brandPartyId ? 'brand' : 'company'} its registered address (Reg. (EU) 2016/425 Annex IX 2).`,
        )
      }
      const id = newId()
      const row = await tx.complianceDocument.create({
        data: {
          id,
          companyId: current.companyId,
          styleId,
          kind: body.kind,
          language: body.language,
          revision: revision.revision,
          number: body.number ?? null,
          status: 'DRAFT',
          makerPartyId: maker.makerPartyId,
          makerName: maker.makerName,
          makerAddress: maker.makerAddress,
          standards: current.ppeStandard ? [current.ppeStandard] : [],
          createdById: inside.audience === 'office' ? inside.actorId : null,
        },
        select: DOCUMENT_SELECT,
      })
      audit({
        recordType: 'ComplianceDocument',
        recordId: id,
        companyId: row.companyId,
        after: {
          styleId,
          kind: row.kind,
          language: row.language,
          revision: row.revision,
          number: row.number,
          status: row.status,
          makerPartyId: row.makerPartyId,
          makerName: row.makerName,
          standards: row.standards,
          upload: announced,
        },
      })
      return id
    },
  )

  const { file, upload } = await requestUpload(
    processFiles(),
    caller,
    {
      companyId: style.companyId,
      recordType: 'ComplianceDocument',
      recordId: documentId,
      kind: 'DOCUMENT',
      originalName: body.originalName,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
    },
    idempotencyKey,
  )
  const document = await caller.withClient(async (client) => {
    const row = await client.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: DOCUMENT_SELECT })
    return documentFactsOf(row, await readDocumentFiles(client, [documentId]))
  })
  return { document, file, upload }
}

/** POST …/documents/:documentId/files/:fileId/complete: the file confirmed, then the document issued or given its new version. */
export async function completeDocumentFile(
  caller: CommandCaller,
  styleId: string,
  documentId: string,
  fileId: string,
  idempotencyKey?: string,
): Promise<{ document: ComplianceDocumentDetail; file: FileView }> {
  const context = officeOf(caller)
  const { row, before } = await caller.withClient(async (client) => {
    const found = await readVisibleDocument(client, context, styleId, documentId)
    const file = isUuid(fileId) ? await client.storedFile.findFirst({ where: { id: fileId, recordType: 'ComplianceDocument', recordId: documentId, kind: 'DOCUMENT' }, select: FILE_SELECT }) : null
    if (!file) throw new NotFoundError('File not found.')
    return { row: found, before: file }
  })
  mayUpload(context, row.companyId)
  if (row.status === 'WITHDRAWN') throw WITHDRAWN(row.kind as DocumentKind, row.language, row.revision)

  const file = await completeUpload(processFiles(), caller, fileId, idempotencyKey)
  const answer = async () => ({ document: await caller.withClient((client) => detailWith(client, documentId)), file })
  if (file.status !== 'AVAILABLE') return answer()
  if (before.status === 'AVAILABLE' && row.status !== 'DRAFT') return answer() // confirmed before: nothing to do again
  if (file.contentType !== DOCUMENT_CONTENT_TYPE) throw new ConflictError('Only a PDF is the signed document.')

  await complianceCommand(
    caller,
    { name: 'product.compliance.confirmDocument', idempotencyKey, input: { styleId, documentId, fileId }, record: { type: 'ComplianceDocument', id: documentId } },
    async (tools) => {
      const { tx, audit, emit, now } = tools
      const document = await tx.complianceDocument.findUniqueOrThrow({ where: { id: documentId }, select: DOCUMENT_SELECT })
      const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true } })
      const kind = document.kind as DocumentKind
      const common = { styleId, code: style.code, documentId, kind, language: document.language, revision: document.revision, fileId }
      const keep = async () =>
        retainFilesInCommand(tools, [fileId], addYears(now, DOCUMENT_RETENTION_YEARS), `Reg. (EU) 2016/425 art. 8(3): the ${DOCUMENT_WORDS[kind]} is kept ten years.`)

      if (document.status === 'WITHDRAWN') throw WITHDRAWN(kind, document.language, document.revision)
      if (document.status !== 'DRAFT') {
        const files = await readDocumentFiles(tx, [documentId])
        const previous = currentFileOf(files.filter((entry) => entry.id !== fileId))
        await keep()
        audit({ action: 'product.compliance.replaceDocument', recordType: 'ComplianceDocument', recordId: documentId, companyId: document.companyId, before: { fileId: previous?.id ?? null }, after: { fileId } })
        emit({ type: 'style.compliance_document_replaced', subject: documentId, companyId: document.companyId, payload: { ...common, previousFileId: previous?.id ?? null } })
        return documentId
      }

      const siblings = await tx.complianceDocument.findMany({ where: { styleId, kind: document.kind, language: document.language }, select: { id: true, kind: true, language: true, revision: true, status: true } })
      const plan = issuePlan(
        siblings.map((entry) => ({ ...entry, kind: entry.kind as DocumentKind, status: entry.status as DocumentStatus })),
        { id: documentId, kind, language: document.language, revision: document.revision },
      )
      await tx.complianceDocument.update({ where: { id: documentId }, data: { status: 'ISSUED', issuedAt: now }, select: { id: true } })
      if (plan.supersededAtOnce) await tx.complianceDocument.update({ where: { id: documentId }, data: { status: 'SUPERSEDED' }, select: { id: true } })
      audit({
        action: 'product.compliance.issueDocument',
        recordType: 'ComplianceDocument',
        recordId: documentId,
        companyId: document.companyId,
        before: { status: 'DRAFT' },
        after: { status: plan.supersededAtOnce ? 'SUPERSEDED' : 'ISSUED', issuedAt: toUtcIso(now), fileId },
      })
      for (const id of plan.supersede) {
        await tx.complianceDocument.update({ where: { id }, data: { status: 'SUPERSEDED', version: { increment: 1 } }, select: { id: true } })
        audit({
          action: 'product.compliance.supersedeDocument',
          recordType: 'ComplianceDocument',
          recordId: id,
          companyId: document.companyId,
          before: { status: 'ISSUED' },
          after: { status: 'SUPERSEDED', by: documentId, revision: document.revision },
        })
      }
      await keep()
      emit({ type: 'style.compliance_document_issued', subject: documentId, companyId: document.companyId, payload: { ...common, supersededDocumentIds: plan.supersede } })
      return documentId
    },
  )
  return answer()
}

/** GET …/documents/:documentId/files/:fileId/download: a 60-second presigned GET (files.read too, the files platform's check). */
export async function downloadDocumentFile(request: FastifyRequest, styleId: string, documentId: string, fileId: string) {
  const context = officeOf(request)
  await request.withClient(async (client) => {
    await readVisibleDocument(client, context, styleId, documentId)
    const file = isUuid(fileId) ? await client.storedFile.findFirst({ where: { id: fileId, recordType: 'ComplianceDocument', recordId: documentId, kind: 'DOCUMENT' }, select: { id: true } }) : null
    if (!file) throw new NotFoundError('File not found.')
  })
  return downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, fileId)
}
