import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_RISK_MANAGE } from '@nexus/factory-domain/safety/risk/permissions'
import type { DvrAuthorKind, DvrSignerRole, DvrSignMethod, DvrVersionStatus } from '@nexus/factory-domain/safety/risk/rules'
import { dvrSeal, sealFingerprintText, type SealInput } from '@nexus/factory-domain/safety/risk/seal'
import { command } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { userNames } from '../../people/employees/employees'
import { renderDiscrepancyReport } from '../../inventory/receipts/report'
import { assertMayAt, assertMayWriteAt, dayOf, dayOrNull, officeOf, refuse } from '../organisation/access'
import { readAssessment, readVersion, RECORD_VERSION, SEAL_KIND, type VersionRow } from './store'

/**
 * The seal of a DVR version (B-W2b-122; QHS-230; design plant.risk "Freeze: PDF + SHA-256 + timestamp → DocumentSeal", new tab
 * "DVR (frozen PDF)"), office only:
 *
 *   GET  /safety/risk/versions/:id/seal?language=   the seal as a PDF made in memory, stored nowhere, with the preview banner
 *                                                   ("awaiting signatures" while the signers are still signing) (safety.view)
 *   POST /safety/risk/versions/:id/seal {language?} keep it (safety.risk.manage): only a SIGNED version; the same contents
 *                                                   give the newest seal back, an earlier one's file is named again, else the
 *                                                   PDF goes to the store first (outside the transaction) and ONE command
 *                                                   writes its file and the GeneratedDocument DVR_FROZEN of the version
 *
 * The version's signing command keeps the Italian seal right after the last signature (./versions.ts). The seal names the
 * consultant's PDF by its SHA-256 and never copies it: the frozen file stays the assessment's. No money.
 */

const MANAGE_WORDS = 'The risk assessments of this site are kept by a role that keeps them (safety.risk.manage).'

/** What the seal prints, read with the caller's client (its letterhead from the Company row, never a request). */
async function sealContents(client: FactoryClient, version: VersionRow, company: CompanyLegal, language: DocumentLanguage): Promise<Omit<SealInput, 'createdAt' | 'sample'>> {
  const assessment = (await readAssessment(client, version.assessmentId))!
  const names = await userNames(client, [version.frozenById, ...version.signatures.map((signature) => signature.signedById)])
  return {
    language,
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    site: { code: assessment.site.code, name: assessment.site.name },
    assessment: { name: assessment.name },
    version: {
      versionNo: version.versionNo,
      label: version.label,
      effectiveOn: dayOf(version.effectiveOn),
      authorKind: version.authorKind as DvrAuthorKind,
      authorName: version.authorName,
      changeSummary: version.changeSummary,
      fileName: version.file.originalName,
      sha256: version.sha256,
      frozenAt: version.frozenAt.toISOString(),
      frozenBy: names.get(version.frozenById) ?? null,
      status: version.status as DvrVersionStatus,
      certainDateOn: dayOrNull(version.certainDateOn),
      signersRequired: version.signersRequired as DvrSignerRole[],
    },
    signatures: version.signatures.map((signature) => ({
      role: signature.role as DvrSignerRole,
      signerName: signature.signerName,
      signedOn: dayOf(signature.signedOn),
      signedAt: signature.signedAt.toISOString(),
      method: signature.method as DvrSignMethod,
      recordedBy: signature.method !== 'FLOOR_PIN' && signature.signedById ? (names.get(signature.signedById) ?? null) : null,
    })),
  }
}

async function readable(request: FastifyRequest, versionId: string): Promise<{ context: OfficeContext; version: VersionRow }> {
  const context = officeOf(request)
  const version = isUuid(versionId) ? await request.withClient((client) => readVersion(client, versionId)) : null
  if (!version) throw new NotFoundError('Version not found.')
  assertMayAt(context, SAFETY_VIEW, version, 'Version')
  return { context, version }
}

/** GET /safety/risk/versions/:versionId/seal: made in memory, stored nowhere, with the preview banner. */
export async function previewSeal(request: FastifyRequest, versionId: string, query: { readonly language?: DocumentLanguage | undefined }) {
  const { version } = await readable(request, versionId)
  const company = await companyLegalOf(request, version.companyId)
  const contents = await request.withClient((client) => sealContents(client, version, company, query.language ?? 'it'))
  const seal = dvrSeal({ ...contents, createdAt: serverClock.now().toISOString(), sample: true })
  return { pdf: await renderDiscrepancyReport(seal), fileName: seal.fileName }
}

/**
 * POST /safety/risk/versions/:versionId/seal, and the signing command's seal right after the last signature (`checked`: the
 * signer's own command checked the version already; keeping the seal of a signed version needs no permission of its own then).
 */
export async function keepSeal(files: FilesRuntime, request: FastifyRequest, versionId: string, options: { readonly language?: DocumentLanguage | undefined; readonly idempotencyKey?: string | undefined; readonly checked?: boolean }) {
  const { context, version } = await readable(request, versionId)
  if (!options.checked) assertMayWriteAt(context, SAFETY_RISK_MANAGE, version, MANAGE_WORDS)
  if (version.status !== 'SIGNED') refuse('NOT_SIGNED', 'The seal is kept once every signer has signed; preview it meanwhile.')
  const language = options.language ?? 'it'
  const company = await companyLegalOf(request, version.companyId)
  const { contents, kept } = await request.withClient(async (client) => ({
    contents: await sealContents(client, version, company, language),
    kept: await client.generatedDocument.findMany({ where: { recordType: RECORD_VERSION, recordId: versionId, kind: SEAL_KIND }, orderBy: { version: 'desc' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true } }),
  }))
  const fingerprint = createHash('sha256').update(sealFingerprintText(contents)).digest('hex')
  const same = (entry: { fingerprint: string; language: string }) => entry.fingerprint === fingerprint && entry.language === language
  const newest = kept[0]
  // The newest shows exactly this already, or an earlier one does (its file is named again); else the PDF goes to the store.
  const earlier = newest && same(newest) ? null : (kept.find(same) ?? null)
  let prepared: PreparedGeneratedFile | null = null
  if (!(newest && same(newest)) && !earlier) {
    const seal = dvrSeal({ ...contents, createdAt: serverClock.now().toISOString(), sample: false })
    prepared = await putGeneratedFile(files, request, {
      companyId: version.companyId,
      recordType: RECORD_VERSION,
      recordId: versionId,
      kind: 'DOCUMENT',
      originalName: seal.fileName,
      contentType: 'application/pdf',
      body: await renderDiscrepancyReport(seal),
      visibility: ['OFFICE'],
    })
  }
  const { result, replayed } = await command(request, { name: 'safety.sealDvr', idempotencyKey: options.idempotencyKey, input: { versionId, language } }, async (tools) => {
    const { tx, now } = tools
    const scope = { companyId: version.companyId, siteId: version.siteId }
    // One seal at a time per version.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.dvr-seal', ${versionId}::text), 0))`
    const last = await tx.generatedDocument.findFirst({ where: { recordType: RECORD_VERSION, recordId: versionId, kind: SEAL_KIND }, orderBy: { version: 'desc' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true, createdAt: true } })
    if (last && same(last)) {
      tools.audit({ action: 'safety.sealDvr', recordType: RECORD_VERSION, recordId: versionId, ...scope, after: { generatedDocumentId: last.id, version: last.version, unchanged: true } })
      return { document: { id: last.id, version: last.version, language: last.language, fileId: last.fileId, createdAt: last.createdAt.toISOString() }, made: false }
    }
    const fileId = prepared ? (await recordGeneratedFile(tools, prepared, { details: { documentType: SEAL_KIND, language } })).id : earlier!.fileId
    const id = newId()
    const next = (last?.version ?? 0) + 1
    await tx.generatedDocument.create({ data: { id, ...scope, recordType: RECORD_VERSION, recordId: versionId, kind: SEAL_KIND, version: next, fingerprint, language, number: null, fileId, createdAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'safety.sealDvr', recordType: RECORD_VERSION, recordId: versionId, ...scope, after: { generatedDocumentId: id, version: next, language, fileId, fingerprint, sha256: version.sha256, reused: prepared === null } })
    tools.emit({ type: 'risk_assessment_version.changed', subject: version.assessmentId, ...scope, payload: { assessmentId: version.assessmentId, versionId, versionNo: version.versionNo, change: 'SEALED', certainDateOn: dayOrNull(version.certainDateOn) } })
    return { document: { id, version: next, language, fileId, createdAt: now.toISOString() }, made: true }
  })
  return { ...result, replayed }
}
