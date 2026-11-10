import type { Prisma } from '@nexus/factory-db'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import {
  namesEntry,
  standardLabel,
  TOUCHED_CERTIFICATE_STATUSES,
  transitionState,
  type RegulationKind,
  type RegulationStatus,
  type StandardChangeImpact,
  type StandardChangeKind,
  type StandardChangeStatus,
} from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { ChangeView, EntryView } from './contract'
import { namesFor, type Reader } from './common'

/**
 * The register's and the watch's reads (B-W2b-249): rows, the certificates that cite an entry (W1's typed standard
 * matched to code + edition), the styles those certificates cover, the reviews and the impact task a change names. One
 * query after another; no write.
 */

export const ENTRY_SELECT = {
  id: true,
  code: true,
  edition: true,
  title: true,
  titleI18n: true,
  kind: true,
  status: true,
  ojReference: true,
  ojDate: true,
  supersededById: true,
  link: true,
  note: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.RegulationOrStandardSelect
export type EntryRow = Prisma.RegulationOrStandardGetPayload<{ select: typeof ENTRY_SELECT }>

export const CHANGE_SELECT = {
  id: true,
  standardId: true,
  newStandardId: true,
  kind: true,
  whatChanged: true,
  sourceReference: true,
  noticedAt: true,
  noticedById: true,
  transitionEndsOn: true,
  status: true,
  impact: true,
  assessment: true,
  assessedAt: true,
  assessedById: true,
  closedAt: true,
  closedById: true,
  certificateIds: true,
  typeChangeReviewIds: true,
  taskId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.StandardChangeSelect
export type ChangeRow = Prisma.StandardChangeGetPayload<{ select: typeof CHANGE_SELECT }>

const day = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
const textsOf = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export const CERTIFICATE_REF = { id: true, number: true, standard: true, status: true, validTo: true, companyId: true, holderPartyId: true } as const satisfies Prisma.CertificateSelect
export type CertificateRef = Prisma.CertificateGetPayload<{ select: typeof CERTIFICATE_REF }>

/** The certificates a person may see (their company and holder reach), every status. */
export async function visibleCertificates(db: Reader, actor: Actor): Promise<CertificateRef[]> {
  return db.certificate.findMany({
    where: scopeWhere(actor, CERTIFICATES_VIEW, { company: { field: 'companyId', nullable: true }, party: { field: 'holderPartyId', nullable: true } }) as Prisma.CertificateWhereInput,
    select: CERTIFICATE_REF,
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
  })
}

/** The registered certificates in force of the tenant that cite the entry (what a change names; the command's view). */
export async function touchedCertificates(db: Reader, entry: { readonly code: string; readonly edition: string | null }): Promise<CertificateRef[]> {
  const rows = await db.certificate.findMany({ where: { status: { in: [...TOUCHED_CERTIFICATE_STATUSES] } }, select: CERTIFICATE_REF, orderBy: [{ number: 'asc' }, { id: 'asc' }] })
  return rows.filter((row) => namesEntry(row.standard, entry))
}

export const citing = (certificates: readonly CertificateRef[], entry: { readonly code: string; readonly edition: string | null }): CertificateRef[] =>
  certificates.filter((row) => namesEntry(row.standard, entry))

export async function entryViews(db: Reader, rows: readonly EntryRow[], actor: Actor): Promise<EntryView[]> {
  const certificates = rows.length > 0 ? await visibleCertificates(db, actor) : []
  const ids = rows.map((row) => row.id)
  const open = ids.length > 0 ? await db.standardChange.groupBy({ by: ['standardId'], where: { standardId: { in: ids }, status: { not: 'CLOSED' } }, _count: { _all: true } }) : []
  const openOf = new Map(open.map((row) => [row.standardId, row._count._all]))
  const successorIds = [...new Set(rows.map((row) => row.supersededById).filter((value): value is string => value !== null))]
  const successors = successorIds.length > 0 ? await db.regulationOrStandard.findMany({ where: { id: { in: successorIds } }, select: { id: true, code: true, edition: true } }) : []
  const successorOf = new Map(successors.map((row) => [row.id, { id: row.id, label: standardLabel(row.code, row.edition) }]))
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    edition: row.edition,
    label: standardLabel(row.code, row.edition),
    title: row.title,
    titleI18n: textsOf(row.titleI18n),
    kind: row.kind as RegulationKind,
    status: row.status as RegulationStatus,
    ojReference: row.ojReference,
    ojDate: day(row.ojDate),
    supersededBy: row.supersededById ? (successorOf.get(row.supersededById) ?? null) : null,
    link: row.link,
    note: row.note,
    usedBy: citing(certificates, row).filter((certificate) => certificate.status !== 'DRAFT').length,
    openChanges: openOf.get(row.id) ?? 0,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }))
}

/** The styles each certificate covers (ACTIVE coverage of a style), by certificate. */
export async function stylesCovered(db: Reader, certificateIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }[]>> {
  if (certificateIds.length === 0) return new Map()
  const rows = await db.certificateCoverage.findMany({
    where: { certificateId: { in: [...certificateIds] }, styleId: { not: null }, status: 'ACTIVE' },
    select: { certificateId: true, style: { select: { id: true, code: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const out = new Map<string, { id: string; code: string; name: string }[]>()
  for (const row of rows) {
    if (!row.style) continue
    const list = out.get(row.certificateId) ?? []
    if (!list.some((style) => style.id === row.style!.id)) list.push(row.style)
    out.set(row.certificateId, list)
  }
  return out
}

export async function changeViews(db: Reader, rows: readonly ChangeRow[], today: BusinessDate): Promise<ChangeView[]> {
  if (rows.length === 0) return []
  const entryIds = [...new Set(rows.flatMap((row) => [row.standardId, row.newStandardId]).filter((value): value is string => value !== null))]
  const entries = await db.regulationOrStandard.findMany({ where: { id: { in: entryIds } }, select: { id: true, code: true, edition: true, status: true } })
  const entryOf = new Map(entries.map((row) => [row.id, row]))
  const certificateIds = [...new Set(rows.flatMap((row) => row.certificateIds))]
  const certificates = certificateIds.length > 0 ? await db.certificate.findMany({ where: { id: { in: certificateIds } }, select: CERTIFICATE_REF }) : []
  const certificateOf = new Map(certificates.map((row) => [row.id, row]))
  const styles = await stylesCovered(db, certificateIds)
  const reviewIds = [...new Set(rows.flatMap((row) => row.typeChangeReviewIds))]
  const reviews =
    reviewIds.length > 0
      ? await db.typeChangeReview.findMany({ where: { id: { in: reviewIds } }, select: { id: true, status: true, certificateId: true, styleId: true, style: { select: { code: true } }, revision: { select: { revision: true } } } })
      : []
  const reviewOf = new Map(reviews.map((row) => [row.id, row]))
  const taskIds = [...new Set(rows.map((row) => row.taskId).filter((value): value is string => value !== null))]
  const tasks = taskIds.length > 0 ? await db.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true, status: true } }) : []
  const taskOf = new Map(tasks.map((row) => [row.id, row]))
  const person = await namesFor(db, rows.flatMap((row) => [row.noticedById, row.assessedById, row.closedById]))

  return rows.map((row) => {
    const standard = entryOf.get(row.standardId)
    const fresh = row.newStandardId ? entryOf.get(row.newStandardId) : undefined
    const affected = new Map<string, { id: string; code: string; name: string; certificateIds: string[] }>()
    for (const certificateId of row.certificateIds) {
      for (const style of styles.get(certificateId) ?? []) {
        const entry = affected.get(style.id) ?? { ...style, certificateIds: [] }
        entry.certificateIds.push(certificateId)
        affected.set(style.id, entry)
      }
    }
    const transitionEndsOn = day(row.transitionEndsOn)
    return {
      id: row.id,
      standard: { id: row.standardId, label: standard ? standardLabel(standard.code, standard.edition) : '?', status: (standard?.status ?? 'IN_FORCE') as RegulationStatus },
      newStandard: fresh ? { id: fresh.id, label: standardLabel(fresh.code, fresh.edition) } : null,
      kind: row.kind as StandardChangeKind,
      whatChanged: row.whatChanged,
      sourceReference: row.sourceReference,
      noticedAt: toUtcIso(row.noticedAt),
      noticedBy: person(row.noticedById),
      transitionEndsOn,
      transition: transitionState(transitionEndsOn, today),
      status: row.status as StandardChangeStatus,
      impact: (row.impact ?? null) as StandardChangeImpact | null,
      assessment: row.assessment,
      assessedAt: row.assessedAt ? toUtcIso(row.assessedAt) : null,
      assessedBy: person(row.assessedById),
      closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
      closedBy: person(row.closedById),
      certificates: row.certificateIds
        .map((id) => certificateOf.get(id))
        .filter((value): value is CertificateRef => value !== undefined)
        .map((certificate) => ({ id: certificate.id, number: certificate.number, status: certificate.status, validTo: day(certificate.validTo)! })),
      styles: [...affected.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      reviews: row.typeChangeReviewIds
        .map((id) => reviewOf.get(id))
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
        .map((review) => ({ id: review.id, status: review.status, certificateId: review.certificateId, styleId: review.styleId, styleCode: review.style.code, revision: review.revision.revision })),
      task: row.taskId ? (taskOf.get(row.taskId) ?? null) : null,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}

export const todayOf = (now: Date): BusinessDate => businessDate(now)
