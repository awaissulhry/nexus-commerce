import { coverageProblems, type CoveredStyle } from '@nexus/factory-domain/compliance/certificates/coverage'
import { acceptsCoverage } from '@nexus/factory-domain/compliance/certificates/rules'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { certificateCommand, certificateDetail, COVERAGE_SELECT, coverageView, mayManage, readCertificate } from './certificates'
import type { CertificateDetail, CoverageView } from './contract'

/**
 * What a certificate covers (QHS-103, PRD-281, PRD-288; Reg. (EU) 2016/425 Annex V 6.2(c)): one style in some of its
 * colourways and sizes (or all), with or without made-to-measure units, or one item (a protector, a material). Added on a
 * draft, valid or suspended certificate; ended by archiving (the gate's history is kept, a coverage is never deleted).
 *
 * One ACTIVE coverage per certificate and style or item: the database cannot hold that rule (a coverage has no natural
 * key), so adding one is a command on the CERTIFICATE (its version moves): two adds that race on one certificate are
 * serialised by its row lock, and the second finds the first and is refused. To change what is covered, archive the
 * coverage and add a new one.
 */

export interface AddCoverageInput {
  /** The certificate's version as read; without it, the stored one. */
  readonly version?: number | undefined
  readonly styleId?: string | undefined
  readonly itemId?: string | undefined
  readonly colourwayIds: readonly string[]
  readonly sizes: readonly string[]
  readonly allowsMadeToMeasure: boolean
  readonly note?: string | null | undefined
}

const atBody = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
const noLongerCovering = (number: string, status: string) =>
  new InvalidStateError(`Certificate ${number} is ${status}: a withdrawn or expired certificate covers nothing more.`)

/** The style or item to cover, in the caller's tenant, and whether its company fits the certificate's. */
async function coveredOf(caller: CommandCaller, certificate: { companyId: string | null }, input: AddCoverageInput) {
  return caller.withClient(async (client) => {
    if (input.styleId) {
      const style = await client.style.findUnique({
        where: { id: input.styleId },
        select: { id: true, code: true, companyId: true, sizes: true, colourways: { select: { id: true } } },
      })
      if (!style) throw new ValidationError('The coverage is not valid.', [{ path: 'body/styleId', message: 'Not a style of the tenant.' }])
      if (certificate.companyId && style.companyId && style.companyId !== certificate.companyId) {
        throw new ValidationError('The coverage is not valid.', [{ path: 'body/styleId', message: "The style belongs to another company than the certificate's holder." }])
      }
      const covered: CoveredStyle = { sizes: style.sizes, colourwayIds: style.colourways.map((colourway) => colourway.id) }
      return { kind: 'style' as const, code: style.code, covered }
    }
    if (input.itemId) {
      const item = await client.item.findUnique({ where: { id: input.itemId }, select: { id: true, code: true, companyId: true } })
      if (!item) throw new ValidationError('The coverage is not valid.', [{ path: 'body/itemId', message: 'Not an item of the tenant.' }])
      if (certificate.companyId && item.companyId && item.companyId !== certificate.companyId) {
        throw new ValidationError('The coverage is not valid.', [{ path: 'body/itemId', message: "The item belongs to another company than the certificate's holder." }])
      }
      return { kind: 'item' as const, code: item.code, covered: null }
    }
    return null
  })
}

/** compliance.certificates.addCoverage: the certificate covers a style (colourways, sizes, made-to-measure) or an item. */
export async function addCoverage(caller: CommandCaller, certificateId: string, input: AddCoverageInput, idempotencyKey?: string): Promise<{ coverage: CoverageView; certificate: CertificateDetail }> {
  const certificate = await readCertificate(caller, certificateId)
  mayManage(caller, certificate)
  if (!acceptsCoverage(certificate.status)) throw noLongerCovering(certificate.number, certificate.status)
  const target = await coveredOf(caller, certificate, input)
  const problems = coverageProblems(input, target?.covered ?? null)
  if (problems.length > 0) throw new ValidationError('The coverage is not valid.', atBody(problems))

  const { result } = await certificateCommand(
    caller,
    { name: 'compliance.certificates.addCoverage', idempotencyKey, input: { certificateId, ...input }, record: { type: 'Certificate', id: certificateId, expectedVersion: input.version } },
    async ({ tx, audit, now, context }) => {
      // The certificate's row is locked: a status move or another add that committed meanwhile is seen here.
      const locked = await tx.certificate.findUniqueOrThrow({ where: { id: certificateId }, select: { status: true, number: true, companyId: true } })
      if (!acceptsCoverage(locked.status)) throw noLongerCovering(locked.number, locked.status)
      const key = input.styleId ? { styleId: input.styleId } : { itemId: input.itemId! }
      const existing = await tx.certificateCoverage.findFirst({ where: { certificateId, status: 'ACTIVE', ...key }, select: { id: true } })
      if (existing) {
        throw new ConflictError(`Certificate ${locked.number} already covers ${target!.kind} ${target!.code}: archive that coverage first to change what it covers.`)
      }
      const id = newId()
      const row = await tx.certificateCoverage.create({
        data: {
          id,
          certificateId,
          ...key,
          colourwayIds: [...input.colourwayIds],
          sizes: [...input.sizes],
          allowsMadeToMeasure: input.allowsMadeToMeasure,
          note: input.note?.trim() || null,
          createdAt: now,
          updatedAt: now,
          createdById: context.audience === 'office' ? context.actorId : null,
        },
        select: COVERAGE_SELECT,
      })
      const after = { ...key, colourwayIds: row.colourwayIds, sizes: row.sizes, allowsMadeToMeasure: row.allowsMadeToMeasure, note: row.note, status: row.status }
      audit({ recordType: 'CertificateCoverage', recordId: id, companyId: locked.companyId, after: { certificateId, ...after } })
      audit({ recordType: 'Certificate', recordId: certificateId, companyId: locked.companyId, after: { coverageAdded: id, ...after } })
      return { coverage: coverageView(row), certificate: await certificateDetail(tx, certificateId, businessDate(now)) }
    },
  )
  return result
}

export interface ArchiveCoverageInput {
  readonly version: number
  readonly reason?: string | null | undefined
}

/** compliance.certificates.archiveCoverage: the certificate covers that style or item no more (kept for the history). */
export async function archiveCoverage(caller: CommandCaller, certificateId: string, coverageId: string, input: ArchiveCoverageInput, idempotencyKey?: string): Promise<{ coverage: CoverageView }> {
  const certificate = await readCertificate(caller, certificateId)
  mayManage(caller, certificate)
  if (!isUuid(coverageId)) throw new NotFoundError('Coverage not found.')
  const coverage = await caller.withClient((client) => client.certificateCoverage.findFirst({ where: { id: coverageId, certificateId }, select: { id: true, status: true } }))
  if (!coverage) throw new NotFoundError('Coverage not found.')
  if (coverage.status !== 'ACTIVE') throw new InvalidStateError('This coverage is archived already.')
  const reason = input.reason?.trim() || null
  const { result } = await certificateCommand(
    caller,
    { name: 'compliance.certificates.archiveCoverage', idempotencyKey, input: { certificateId, coverageId, ...input }, record: { type: 'CertificateCoverage', id: coverageId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const locked = await tx.certificateCoverage.findUniqueOrThrow({ where: { id: coverageId }, select: { status: true } })
      if (locked.status !== 'ACTIVE') throw new InvalidStateError('This coverage is archived already.')
      const row = await tx.certificateCoverage.update({ where: { id: coverageId }, data: { status: 'ARCHIVED' }, select: COVERAGE_SELECT })
      const entry = { before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' }, ...(reason ? { reason } : {}) }
      audit({ recordType: 'CertificateCoverage', recordId: coverageId, companyId: certificate.companyId, ...entry })
      audit({ recordType: 'Certificate', recordId: certificateId, companyId: certificate.companyId, after: { coverageArchived: coverageId }, ...(reason ? { reason } : {}) })
      return { coverage: coverageView(row) }
    },
  )
  return result
}
