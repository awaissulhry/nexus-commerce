import { createHash } from 'node:crypto'
import { ConflictError, DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MakePdfBody, TechPackPdfView } from '@nexus/factory-domain/product/techpack/contracts'
import { techPackPaper } from '@nexus/factory-domain/product/techpack/paper'
import { PRODUCT_TECHPACKS_MAKE } from '@nexus/factory-domain/product/techpack/permissions'
import { audienceOfLayout, copyPartyProblem, layoutOf, orderedSections, sectionProblems, TECH_PACK_SECTIONS, type CopyParty } from '@nexus/factory-domain/product/techpack/rules'
import { formatTechPackCode, techPackAddress, techPackCodeOf } from '@nexus/factory-domain/product/techpack/scan'
import { fingerprintTextOf } from '@nexus/factory-domain/product/techpack/view'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { processEmail } from '../../../platform/email-out/service'
import { putGeneratedFile, recordGeneratedFile, tenantOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { contextOf } from '../bom/store'
import type { Reader } from './facts'
import { renderTechPack } from './pdf'
import { companyOfCopy, composeTechPack, notAllowedFor, readTechPackTarget } from './techpack'

/**
 * The tech pack PDF (B-W2b-230; PRD-131 PDF for subcontractors and brands, PRD-133 per audience, PRD-138 the QR to the current
 * version on every page), a generated document (factory-db GeneratedDocument kind TECH_PACK of the StyleRevision; B-W2b-218
 * added the kind), kept as the other generated documents are (quality/inspection-docs versions.ts):
 *
 *   1. OUTSIDE any transaction: the audience's view (the server leaves out what the audience never gets; a PDF never carries
 *      money), its fingerprint (SHA-256 of what it says and who it is for); the same as the newest version of the SAME
 *      audience and language: nothing is made, that version comes back (made false). Else the version's id is chosen now (its
 *      QR code is printed on every page), the pictures' bytes read (AVAILABLE JPEG and PNG, at most 12, 4 MB each), the PDF
 *      painted and put in the file store (a DOCUMENT of the revision, OFFICE only: a partner gets it through a share or the
 *      portal, never by this file);
 *   2. ONE command: the revision's advisory lock `factory.tech-pack|<tenant>|<revision>`, the versions read again (made
 *      meanwhile with the same contents: that one; another version number than the one printed: 409, make it again), the
 *      StoredFile row, the GeneratedDocument row (layout = the audience's, number = the code printed under the QR), the audit
 *      row on the revision and style.tech_pack_made.
 *
 *   POST /product/styles/:styleId/revisions/:revisionId/tech-pack/pdf        product.techpacks.make over the copy's company
 *   GET  …/tech-pack/versions                                                product.bom.view: every version (no file bytes)
 *   GET  …/tech-pack/versions/:documentId/pdf                                product.bom.view: one version's PDF (inline)
 */

const KIND = 'TECH_PACK' as const
const RECORD = 'StyleRevision'
const MAX_PICTURES = 12
const MAX_PICTURE_BYTES = 4 * 1024 * 1024
const PRINTABLE = new Set(['image/jpeg', 'image/png'])

const fingerprintOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const VERSION_COLUMNS = { id: true, version: true, layout: true, language: true, number: true, fingerprint: true, fileId: true, companyId: true, createdAt: true, createdById: true } as const

export const readVersions = (db: Reader, revisionId: string) =>
  db.generatedDocument.findMany({ where: { recordType: RECORD, recordId: revisionId, kind: KIND }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })

type VersionRow = Awaited<ReturnType<typeof readVersions>>[number]

const versionView = (row: VersionRow, createdBy: string | null) => ({
  id: row.id,
  version: row.version,
  audience: audienceOfLayout(row.layout),
  language: row.language,
  code: techPackCodeOf(row.id),
  createdAt: toUtcIso(row.createdAt),
  createdBy,
})

async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

/** The party a partner copy is for, as the rules read it (of the copy's company or every company), or null. */
async function partyOf(caller: CommandCaller, partyId: string | undefined, companyId: string): Promise<(CopyParty & { readonly name: string }) | null> {
  if (partyId === undefined) return null
  const row = await caller.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, roles: true, status: true, companyId: true, legalName: true, tradeName: true } }))
  if (!row || (row.companyId !== null && row.companyId !== companyId)) return null
  return { id: row.id, code: row.code, roles: [...row.roles], status: row.status, name: row.tradeName ?? row.legalName }
}

/** The pictures a version prints: the view's (sketches and pages), AVAILABLE JPEG or PNG within the limits, their bytes read. */
async function pictureBytes(caller: CommandCaller, fileIds: readonly string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const wanted = [...new Set(fileIds)].filter(isUuid)
  if (wanted.length === 0) return out
  const rows = await caller.withClient((client) =>
    client.storedFile.findMany({ where: { id: { in: wanted } }, select: { id: true, status: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true } }),
  )
  const printable = wanted
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined && row.status === 'AVAILABLE' && PRINTABLE.has(row.contentType) && row.sizeBytes <= MAX_PICTURE_BYTES)
    .slice(0, MAX_PICTURES)
  for (const row of printable) {
    try {
      const body = await processFiles().storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes)
      if (body && createHash('sha256').update(body).digest('hex') === row.sha256) out.set(row.id, body)
    } catch {
      // Left out of the PDF: its caption says what it was.
    }
  }
  return out
}

/** POST …/tech-pack/pdf: a new version of the revision's tech pack for an audience and a language (or the newest again). */
export async function makeTechPackPdf(caller: CommandCaller, styleId: string, revisionId: string, body: MakePdfBody, idempotencyKey?: string): Promise<{ status: 200 | 201; pdf: TechPackPdfView }> {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const target = await readTechPackTarget(caller, styleId, revisionId)
  const { style, revision } = target
  const companyId = companyOfCopy(context, style, body.companyId, 'body')
  if (companyId === null) throw new ValidationError('The company is not valid.', [{ path: 'body/companyId', message: `Style ${style.code} is every company's: say which company keeps the copy.` }])
  if (!can(actor, PRODUCT_TECHPACKS_MAKE, { companyId })) throw new ForbiddenError('Making a tech pack PDF needs product.techpacks.make.')

  // The sections: asked (each once, the caller's to see), else every one the caller may see.
  const notAllowed = notAllowedFor(actor, style.companyId)
  const allowed = new Set(TECH_PACK_SECTIONS.filter((section) => notAllowed[section] === undefined))
  if (body.sections !== undefined) {
    const problems = sectionProblems(body.sections, allowed, notAllowed)
    if (problems.length > 0) throw new ValidationError('The sections are not valid.', problems)
  }
  const sections = body.sections === undefined || body.sections.length === 0 ? orderedSections(undefined).filter((section) => allowed.has(section)) : orderedSections(body.sections)

  const party = await partyOf(caller, body.partyId, companyId)
  const problem = copyPartyProblem(body.audience, { code: style.code, brandPartyId: style.brandPartyId }, party, body.partyId !== undefined)
  if (problem) throw new ValidationError('The copy is not valid.', [problem])
  const partyRef = party ? { code: party.code, name: party.name } : null

  // A PDF never carries money: costs are not even read.
  const { view } = await composeTechPack(caller, target, { audience: body.audience, language: body.language, sections, companyId, costs: false })
  const fingerprint = fingerprintOf(fingerprintTextOf(view, partyRef))
  const layout = layoutOf(body.audience)
  const sameKind = (row: VersionRow) => row.layout === layout && row.language === body.language
  const before = await caller.withClient((client) => readVersions(client, revision.id))
  const newestOfKind = before.find(sameKind)
  const answer = async (row: VersionRow, made: boolean) => {
    const names = await caller.withClient((client) => namesOf(client, [row.createdById]))
    return { version: versionView(row, row.createdById ? (names.get(row.createdById) ?? null) : null), made, fileId: row.fileId, address: techPackAddress(processEmail().webOrigin, techPackCodeOf(row.id)) }
  }
  if (newestOfKind && newestOfKind.fingerprint === fingerprint) return { status: 200, pdf: await answer(newestOfKind, false) }

  const id = newId()
  const code = techPackCodeOf(id)
  const printedCode = formatTechPackCode(code)
  const address = techPackAddress(processEmail().webOrigin, code)
  const version = (before[0]?.version ?? 0) + 1
  const timeZone = (await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { timezone: true } })))?.timezone ?? 'Europe/Rome'
  const printedAt = serverClock.now()
  const paper = techPackPaper(view, { version, printedAt, timeZone, qr: address, code: printedCode, party: partyRef })
  const pictures = await pictureBytes(caller, [...(view.sketches ?? []), ...(view.construction?.pages ?? [])].map((picture) => picture.fileId))
  const file = await putGeneratedFile(processFiles(), caller, {
    companyId,
    recordType: RECORD,
    recordId: revision.id,
    kind: 'DOCUMENT',
    originalName: `${paper.meta.title}.pdf`,
    contentType: 'application/pdf',
    body: await renderTechPack(paper, pictures),
    visibility: ['OFFICE'],
  })

  const { result } = await command(
    caller,
    { name: 'product.techpack.make', idempotencyKey, input: { styleId, revisionId, ...body } },
    async (tools) => {
      const { tx, now } = tools
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.tech-pack', ${tenantOf(context)}::uuid, ${revision.id}::uuid), 0))`
      const versions = await readVersions(tx, revision.id)
      const meanwhile = versions.find(sameKind)
      if (meanwhile && meanwhile.fingerprint === fingerprint) return { id: meanwhile.id, made: false }
      if ((versions[0]?.version ?? 0) + 1 !== version) throw new ConflictError(`Another tech pack version of revision ${revision.revision} was made meanwhile: make the PDF again.`)
      const stored = await recordGeneratedFile(tools, file, { details: { documentType: KIND, number: printedCode, language: body.language, layout } })
      await tx.generatedDocument.create({
        data: { id, companyId, siteId: null, recordType: RECORD, recordId: revision.id, kind: KIND, version, fingerprint, language: body.language, layout, number: printedCode, fileId: stored.id, createdAt: now, createdById: context.audience === 'office' ? context.actorId : null },
        select: { id: true },
      })
      tools.audit({
        action: 'product.techpack.make',
        recordType: RECORD,
        recordId: revision.id,
        companyId,
        after: { generatedDocumentId: id, version, audience: body.audience, language: body.language, layout, sections: [...sections], partyId: party?.id ?? null, fileId: stored.id, fingerprint, code: printedCode },
      })
      tools.emit({
        type: 'style.tech_pack_made',
        subject: style.id,
        companyId,
        payload: { styleId: style.id, code: style.code, revisionId: revision.id, revision: revision.revision, generatedDocumentId: id, version, audience: body.audience, language: body.language },
      })
      return { id, made: true }
    },
  )
  // Plain JSON out of the command; the version as it is stored.
  const kept = (await caller.withClient((client) => readVersions(client, revision.id))).find((row) => row.id === result.id)!
  return { status: result.made ? 201 : 200, pdf: await answer(kept, result.made) }
}

/** GET …/tech-pack/versions */
export async function techPackVersions(caller: CommandCaller, styleId: string, revisionId: string) {
  const { revision } = await readTechPackTarget(caller, styleId, revisionId)
  return caller.withClient(async (client) => {
    const rows = await readVersions(client, revision.id)
    const names = await namesOf(client, rows.map((row) => row.createdById))
    return { versions: rows.map((row) => ({ ...versionView(row, row.createdById ? (names.get(row.createdById) ?? null) : null), fileId: row.fileId })) }
  })
}

/** GET …/tech-pack/versions/:documentId/pdf: the stored PDF of one version (another revision's or kind's is not found). */
export async function techPackVersionPdf(caller: CommandCaller, styleId: string, revisionId: string, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const { revision } = await readTechPackTarget(caller, styleId, revisionId)
  const row = isUuid(documentId)
    ? await caller.withClient((client) => client.generatedDocument.findUnique({ where: { id: documentId }, select: { recordType: true, recordId: true, kind: true, fileId: true } }))
    : null
  if (!row || row.recordType !== RECORD || row.recordId !== revision.id || row.kind !== KIND) throw new NotFoundError('Tech pack version not found.')
  const file = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: row.fileId }, select: { status: true, originalName: true, sizeBytes: true, storeAccountId: true, storageKey: true } }))
  if (!file || file.status !== 'AVAILABLE') throw new NotFoundError('Tech pack version not found.')
  const pdf = await processFiles().storage.read(caller, file.storeAccountId, file.storageKey, file.sizeBytes)
  if (!pdf) throw new DomainError('not_ready', 'The file store did not answer. Try again in a moment.')
  return { pdf, fileName: file.originalName }
}
