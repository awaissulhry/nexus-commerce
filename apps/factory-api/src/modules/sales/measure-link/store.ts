import { createHash } from 'node:crypto'
import type { FactoryClient } from '@nexus/factory-db'
import { DEFAULT_PHOTO_RULE, PHOTO_RULES, zoneOf, type MeasurePoint, type PhotoRule, type PhotoView } from '@nexus/factory-domain/sales/measure-link/rules'
import type { CommandTx } from '../../../core/command'
import { noticeInForce, type InForce } from '../../../platform/privacy/read'

/**
 * The reads of measurements by link (B-W2b-171), for the office's scope or the tenant's system (the link session cannot
 * read templates, notices or the audit trail: the link's routes read them as the tenant's system, for the link's party).
 *
 *   revisionIdFor   the id of the revision a MEASUREMENTS link sends: one per link (a MEASUREMENTS link has one use), made
 *                   from the link's id, so the photos uploaded before the send already name the revision they belong to
 *                   (StoredFile recordType MeasurementProfile, recordId = this id) and nothing is stored on the device
 *   latestOf        the latest revision of a rider's garment type (the one a new revision supersedes)
 *   pointsOf        the points of measure of the garment type's template (MeasurementTemplate.code = garmentType)
 *   linkTermsOf     what the office asked when it made the link: photos required or optional, the order it was for
 *   noticeReadOf    when the rider ticked the notice in force on this link (the audit row of measureLink.notice)
 */

export type Reader = FactoryClient | CommandTx

export const PROFILE_RECORD = 'MeasurementProfile'
export const LINK_MADE_ACTION = 'measureLink.make'
export const NOTICE_READ_ACTION = 'measureLink.notice'

/** A UUID (version 8, RFC variant) from the link's id: the revision the link sends, known before it is sent. */
export function revisionIdFor(linkId: string): string {
  const hex = createHash('sha256').update(`measure-link:revision:${linkId}`).digest('hex')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export const PROFILE_COLUMNS = {
  id: true,
  partyId: true,
  contactId: true,
  riderName: true,
  garmentType: true,
  revision: true,
  supersedesId: true,
  measurements: true,
  fitNotes: true,
  takenBy: true,
  privacyNoticeAt: true,
  submittedViaLinkId: true,
  submittedAt: true,
  noticeVersionId: true,
  photoFrontFileId: true,
  photoSideFileId: true,
  photoBackFileId: true,
  photosDeleteAfter: true,
  createdAt: true,
} as const

export async function latestOf(db: Reader, profile: { readonly partyId: string; readonly riderName: string; readonly garmentType: string }) {
  return db.measurementProfile.findFirst({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, orderBy: { revision: 'desc' }, select: PROFILE_COLUMNS })
}

const text = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

export interface TemplateFacts {
  readonly code: string
  readonly name: string
  readonly nameI18n: Record<string, string>
  readonly points: Array<MeasurePoint & { readonly nameI18n: Record<string, string> }>
}

/** The garment type's template and its ACTIVE points in order (none: the type has no template, only the basics are asked). */
export async function pointsOf(db: Reader, garmentType: string): Promise<TemplateFacts> {
  const template = await db.measurementTemplate.findFirst({ where: { code: garmentType }, select: { id: true, code: true, name: true, nameI18n: true } })
  if (!template) return { code: garmentType, name: garmentType, nameI18n: {}, points: [] }
  const rows = await db.measurementPoint.findMany({
    where: { templateId: template.id, status: 'ACTIVE' },
    select: { code: true, name: true, nameI18n: true, seq: true, required: true, minValue: true, maxValue: true, howTo: true, uom: true },
    orderBy: [{ seq: 'asc' }, { code: 'asc' }],
  })
  // Only lengths in centimetres are asked by link (a template's other units are the office's).
  const points = rows
    .filter((row) => row.uom === 'CM')
    .map((row) => ({ code: row.code, name: row.name, nameI18n: text(row.nameI18n), seq: row.seq, required: row.required, minCm: row.minValue?.toFixed(2) ?? null, maxCm: row.maxValue?.toFixed(2) ?? null, howTo: row.howTo }))
  return { code: template.code, name: template.name, nameI18n: text(template.nameI18n), points }
}

export const zoned = <P extends { readonly code: string }>(point: P) => ({ ...point, zone: zoneOf(point.code) })

export interface LinkTerms {
  readonly photos: PhotoRule
  readonly orderNumber: string | null
  readonly salesOrderLineId: string | null
}

/** What the office asked when it made the link (its audit row); a link made otherwise (a seed, another route) asks the default. */
export async function linkTermsOf(db: Reader, linkId: string): Promise<LinkTerms> {
  const row = await db.auditLog.findFirst({ where: { recordType: 'OneOffLink', recordId: linkId, action: LINK_MADE_ACTION }, orderBy: { at: 'asc' }, select: { after: true } })
  const after = (row?.after ?? {}) as Record<string, unknown>
  const photos = (PHOTO_RULES as readonly string[]).includes(String(after.photos)) ? (after.photos as PhotoRule) : DEFAULT_PHOTO_RULE
  return { photos, orderNumber: typeof after.orderNumber === 'string' ? after.orderNumber : null, salesOrderLineId: typeof after.salesOrderLineId === 'string' ? after.salesOrderLineId : null }
}

/** The company's public notice in force (people outside the company: GDPR art. 13). */
export async function measureNotice(db: Reader, companyId: string): Promise<InForce | null> {
  return noticeInForce(db, companyId, 'PRIVACY_PUBLIC')
}

/** When the rider ticked the notice on this link (the first tick of that version), or null. */
export async function noticeReadOf(db: Reader, linkId: string, noticeId: string): Promise<Date | null> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'OneOffLink', recordId: linkId, action: NOTICE_READ_ACTION }, orderBy: { at: 'asc' }, select: { at: true, after: true } })
  const row = rows.find((entry) => ((entry.after ?? {}) as Record<string, unknown>).noticeId === noticeId)
  return row?.at ?? null
}

/** The views of a revision's photos (front, side, back), with their file ids. */
export function photosOf(profile: { readonly photoFrontFileId: string | null; readonly photoSideFileId: string | null; readonly photoBackFileId: string | null }): Array<{ view: PhotoView; fileId: string }> {
  const out: Array<{ view: PhotoView; fileId: string }> = []
  if (profile.photoFrontFileId) out.push({ view: 'FRONT', fileId: profile.photoFrontFileId })
  if (profile.photoSideFileId) out.push({ view: 'SIDE', fileId: profile.photoSideFileId })
  if (profile.photoBackFileId) out.push({ view: 'BACK', fileId: profile.photoBackFileId })
  return out
}

/** A photo's view from the name the link gave it at upload ("measurements-front.jpg"). */
export function viewOfName(name: string): PhotoView | null {
  const match = /^measurements-(front|side|back)\./.exec(name)
  return match ? (match[1]!.toUpperCase() as PhotoView) : null
}
