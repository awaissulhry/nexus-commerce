import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { approvedBaseOf, kindsOf, typeChanges, type TypeChange, type TypeSnapshot } from '@nexus/factory-domain/compliance/type-changes/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * Finding changes to an approved type (B-W2a-66; PRD-285; Reg. (EU) 2016/425 Annex V 7.2): the BOM of a revision read as
 * factory-domain compliance/type-changes compares it (each line's material: kind, PPE component, thickness), the
 * certificates that cover a style (VALID or SUSPENDED, an ACTIVE coverage of the style), and THE hook the BOM's release
 * calls inside its own command (modules/product/bom/revisions.ts releaseRevision, one line):
 *
 *   openTypeChangeReviewsInCommand(tools, { styleId, revisionId, revision, previousRevisionId, companyId })
 *
 * For each covering certificate without a review of this revision yet: the approved type (the revision released before,
 * or what its still-open review was compared with) against the new one; any change opens ONE review (OPEN) with what
 * changed, its audit row and `compliance.type_change_found`. A style's first release compares with nothing.
 */

type Reader = FactoryClient | CommandTx

/** A revision's BOM as the comparison reads it. */
export async function snapshotOf(db: Reader, revisionId: string): Promise<TypeSnapshot> {
  const lines = await db.bomLine.findMany({ where: { revisionId }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: { id: true, itemId: true, placement: true } })
  const ids = [...new Set(lines.map((line) => line.itemId))]
  const items = ids.length
    ? await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, kind: true, isPpeComponent: true, thicknessMinMm: true, thicknessMaxMm: true } })
    : []
  return {
    lines,
    materials: Object.fromEntries(
      items.map((item) => [item.id, { id: item.id, code: item.code, name: item.name, kind: item.kind, isPpeComponent: item.isPpeComponent, thicknessMinMm: item.thicknessMinMm?.toString() ?? null, thicknessMaxMm: item.thicknessMaxMm?.toString() ?? null }]),
    ),
  }
}

export const CERTIFICATE_REF = { id: true, number: true, standard: true, status: true, notifiedBodyName: true, notifiedBodyNumber: true, companyId: true, holderPartyId: true } as const satisfies Prisma.CertificateSelect
export type CertificateRefRow = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_REF }>

/** The certificates whose type examination covers the style now: registered and counting, with an ACTIVE coverage of it. */
export async function coveringCertificates(db: Reader, styleId: string): Promise<CertificateRefRow[]> {
  const coverage = await db.certificateCoverage.findMany({
    where: { styleId, status: 'ACTIVE', certificate: { status: { in: ['VALID', 'SUSPENDED'] } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { certificate: { select: CERTIFICATE_REF } },
  })
  const unique = new Map<string, CertificateRefRow>()
  for (const entry of coverage) unique.set(entry.certificate.id, entry.certificate)
  return [...unique.values()]
}

/** The approved type of `certificateId` a revision released after `previousRevisionId` is compared with (null: none). */
export async function approvedBaseFor(db: Reader, previousRevisionId: string | null, certificateId: string): Promise<string | null> {
  if (previousRevisionId === null) return null
  const reviews = await db.typeChangeReview.findMany({ where: { revisionId: previousRevisionId, certificateId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { status: true, comparedRevisionId: true } })
  return approvedBaseOf(previousRevisionId, reviews)
}

/** What changed from a base revision to another (empty: nothing the approved type depends on). */
export async function changesBetween(db: Reader, baseRevisionId: string, revisionId: string): Promise<TypeChange[]> {
  return typeChanges(await snapshotOf(db, baseRevisionId), await snapshotOf(db, revisionId))
}

export interface ReleasedRevision {
  readonly styleId: string
  readonly revisionId: string
  readonly revision: number
  /** The revision that was RELEASED before (made OBSOLETE by this release); null: the style's first release. */
  readonly previousRevisionId: string | null
  readonly companyId: string | null
}

/** THE hook of a revision's release (inside the BOM's release command): the reviews it opens; their ids. */
export async function openTypeChangeReviewsInCommand(tools: CommandTools, released: ReleasedRevision): Promise<string[]> {
  const { tx, now } = tools
  if (released.previousRevisionId === null) return []
  const opened: string[] = []
  for (const certificate of await coveringCertificates(tx, released.styleId)) {
    const existing = await tx.typeChangeReview.findFirst({ where: { revisionId: released.revisionId, certificateId: certificate.id }, select: { id: true } })
    if (existing) continue
    const base = await approvedBaseFor(tx, released.previousRevisionId, certificate.id)
    if (base === null) continue
    const changes = await changesBetween(tx, base, released.revisionId)
    if (changes.length === 0) continue
    const id = newId()
    await tx.typeChangeReview.create({
      data: {
        id,
        styleId: released.styleId,
        revisionId: released.revisionId,
        certificateId: certificate.id,
        comparedRevisionId: base,
        changes: changes as unknown as Prisma.InputJsonValue,
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
    const kinds = kindsOf(changes)
    tools.audit({ action: 'compliance.typeChanges.found', recordType: 'TypeChangeReview', recordId: id, companyId: released.companyId, after: { styleId: released.styleId, revisionId: released.revisionId, certificateId: certificate.id, comparedRevisionId: base, kinds } })
    tools.emit({
      type: 'compliance.type_change_found',
      subject: id,
      companyId: released.companyId,
      payload: { reviewId: id, styleId: released.styleId, revisionId: released.revisionId, revision: released.revision, certificateId: certificate.id, comparedRevisionId: base, kinds },
    })
    opened.push(id)
  }
  return opened
}
