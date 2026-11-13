import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import { isOld, type MeasuredPoint, type ReviewStatus } from '@nexus/factory-domain/sales/mtm/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * The made-to-measure office's reads (B-W2b-358): a rider's measurement profile revisions (MeasurementProfile, one chain per
 * customer, rider and garment type: revision 1, 2, …; the newest is the one reviewed and ordered from), the template of its
 * garment type (MeasurementTemplate.code = garmentType), the made-to-measure quote and order lines made to the chain, and the
 * people named. Every read names its columns and reads one query at a time (a transaction client runs one at a time).
 *
 * Who may: the office, over the profile's customer (a profile has no company): sales.measurements.view reads (body data), the
 * writes their own permission on top. A profile the caller may not see is not found.
 */

export type Reader = FactoryClient | CommandTx

export const PROFILE_RECORD = 'MeasurementProfile'

export const PROFILE_SELECT = {
  id: true,
  partyId: true,
  contactId: true,
  riderName: true,
  garmentType: true,
  revision: true,
  supersedesId: true,
  measurements: true,
  baseSize: true,
  fitNotes: true,
  internalNote: true,
  takenAt: true,
  takenBy: true,
  privacyNoticeRef: true,
  privacyNoticeAt: true,
  submittedViaLinkId: true,
  submittedAt: true,
  photoFrontFileId: true,
  photoSideFileId: true,
  photoBackFileId: true,
  measuredByUserId: true,
  measuredPlace: true,
  reviewStatus: true,
  reviewedById: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
} as const satisfies Prisma.MeasurementProfileSelect
export type ProfileRow = Prisma.MeasurementProfileGetPayload<{ select: typeof PROFILE_SELECT }>

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const profileNotFound = (): NotFoundError => new NotFoundError('Measurement profile not found.')

/** The caller reads the profile's customer's measurements (else not found) and holds `permission` over it (else forbidden). */
export function assertMayProfile(context: OfficeContext, partyId: string, permission?: Permission): void {
  const actor = actorOf(context)
  if (!can(actor, SALES_MEASUREMENTS_VIEW, { partyId })) throw profileNotFound()
  if (permission && !can(actor, permission, { partyId })) throw new ForbiddenError()
}

export const mayOnProfile = (context: OfficeContext, permission: Permission, partyId: string, companyId?: string): boolean => can(actorOf(context), permission, companyId ? { partyId, companyId } : { partyId })

/** A profile revision by id (null: none, or not a UUID). */
export async function profileOf(db: Reader, profileId: string): Promise<ProfileRow | null> {
  return isUuid(profileId) ? db.measurementProfile.findUnique({ where: { id: profileId }, select: PROFILE_SELECT }) : null
}

/** The revisions of the profile's rider and garment type, oldest first. */
export async function chainOf(db: Reader, profile: Pick<ProfileRow, 'partyId' | 'riderName' | 'garmentType'>): Promise<ProfileRow[]> {
  return db.measurementProfile.findMany({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, orderBy: [{ revision: 'asc' }, { id: 'asc' }], select: PROFILE_SELECT })
}

/** The newest revision of the rider's garment type. */
export async function latestOf(db: Reader, profile: Pick<ProfileRow, 'partyId' | 'riderName' | 'garmentType'>): Promise<ProfileRow | null> {
  return db.measurementProfile.findFirst({ where: { partyId: profile.partyId, riderName: profile.riderName, garmentType: profile.garmentType }, orderBy: [{ revision: 'desc' }, { id: 'desc' }], select: PROFILE_SELECT })
}

/** The template of a garment type with its points in order (null: the type has no template). */
export async function templateOfGarment(db: Reader, garmentType: string) {
  const template = await db.measurementTemplate.findFirst({ where: { code: garmentType }, select: { id: true, code: true, name: true, nameI18n: true, rulesOn: true, status: true, companyId: true } })
  if (!template) return null
  const points = await db.measurementPoint.findMany({ where: { templateId: template.id }, select: { code: true, name: true, uom: true, required: true, minValue: true, maxValue: true, howTo: true, status: true, seq: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return { ...template, points }
}
export type GarmentTemplate = NonNullable<Awaited<ReturnType<typeof templateOfGarment>>>

const plain = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

/** The template's points as the values are checked against them. */
export const measuredPointsOf = (template: GarmentTemplate): MeasuredPoint[] =>
  template.points.map((point) => ({ code: point.code, name: point.name, uom: point.uom, required: point.required, minValue: plain(point.minValue), maxValue: plain(point.maxValue), status: point.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE' }))

export const pointViewsOf = (template: GarmentTemplate) =>
  template.points.map((point) => ({ code: point.code, name: point.name, uom: point.uom, required: point.required, minValue: plain(point.minValue), maxValue: plain(point.maxValue), howTo: point.howTo, status: point.status }))

/** The stored values ({ code: { value, unit } }), the readable ones. */
export function measurementsOf(value: unknown): Record<string, { value: string; unit: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([code, entry]) => {
      const raw = (entry ?? {}) as { value?: unknown; unit?: unknown }
      return typeof raw.value === 'string' ? [[code, { value: raw.value, unit: typeof raw.unit === 'string' ? raw.unit : '' }]] : []
    }),
  )
}

/** Display names of office users (id → name). */
export async function namesOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

const photoCount = (row: ProfileRow): number => [row.photoFrontFileId, row.photoSideFileId, row.photoBackFileId].filter((id) => id !== null).length

/** A revision as the office reads it (body data: sales.measurements.view). */
export function revisionViewOf(row: ProfileRow, names: ReadonlyMap<string, string>, now: Date) {
  return {
    id: row.id,
    revision: row.revision,
    supersedesId: row.supersedesId,
    measurements: measurementsOf(row.measurements),
    baseSize: row.baseSize,
    fitNotes: row.fitNotes,
    internalNote: row.internalNote,
    takenAt: toUtcIso(row.takenAt),
    takenBy: row.takenBy,
    measuredBy: row.measuredByUserId ? { id: row.measuredByUserId, name: names.get(row.measuredByUserId) ?? '' } : null,
    measuredPlace: row.measuredPlace,
    privacyNoticeRef: row.privacyNoticeRef,
    privacyNoticeAt: toUtcIso(row.privacyNoticeAt),
    byLink: row.submittedViaLinkId !== null,
    submittedAt: row.submittedAt ? toUtcIso(row.submittedAt) : null,
    photos: photoCount(row),
    review: {
      status: row.reviewStatus as ReviewStatus,
      by: row.reviewedById ? { id: row.reviewedById, name: names.get(row.reviewedById) ?? '' } : null,
      at: row.reviewedAt ? toUtcIso(row.reviewedAt) : null,
      note: row.reviewNote,
    },
    old: isOld(businessDate(row.takenAt), businessDate(now)),
    createdAt: toUtcIso(row.createdAt),
  }
}

/** The made-to-measure quote and order lines made to these revisions, newest first. */
export async function unitsOf(db: Reader, profileIds: readonly string[]) {
  if (profileIds.length === 0) return []
  const quoteLines = await db.quoteLine.findMany({
    where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: [...profileIds] } },
    select: { id: true, versionId: true, measurementProfileId: true, styleId: true, colourwayId: true, baseSize: true, createdAt: true },
  })
  const orderLines = await db.salesOrderLine.findMany({
    where: { kind: 'MADE_TO_MEASURE', measurementProfileId: { in: [...profileIds] } },
    select: { id: true, orderId: true, measurementProfileId: true, styleId: true, colourwayId: true, baseSize: true, createdAt: true },
  })
  const versions = quoteLines.length === 0 ? [] : await db.quoteVersion.findMany({ where: { id: { in: [...new Set(quoteLines.map((line) => line.versionId))] } }, select: { id: true, quoteId: true, revision: true, status: true } })
  const quotes = versions.length === 0 ? [] : await db.quote.findMany({ where: { id: { in: [...new Set(versions.map((version) => version.quoteId))] } }, select: { id: true, number: true } })
  const orders = orderLines.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...new Set(orderLines.map((line) => line.orderId))] } }, select: { id: true, number: true, status: true } })
  const styleIds = [...new Set([...quoteLines, ...orderLines].map((line) => line.styleId))]
  const colourwayIds = [...new Set([...quoteLines, ...orderLines].map((line) => line.colourwayId))]
  const styles = new Map((styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const colourways = new Map((colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const profiles = new Map((await db.measurementProfile.findMany({ where: { id: { in: [...profileIds] } }, select: { id: true, revision: true } })).map((row) => [row.id, row.revision]))
  const units = [
    ...quoteLines.flatMap((line) => {
      const version = versions.find((row) => row.id === line.versionId)
      const quote = version ? quotes.find((row) => row.id === version.quoteId) : undefined
      if (!version || !quote) return []
      return [{ kind: 'QUOTE' as const, lineId: line.id, documentId: quote.id, number: version.revision > 1 ? `${quote.number} rev ${version.revision}` : quote.number, status: version.status as string, profileId: line.measurementProfileId!, revision: profiles.get(line.measurementProfileId!) ?? 0, style: { id: line.styleId, code: styles.get(line.styleId) ?? '' }, colourway: { id: line.colourwayId, code: colourways.get(line.colourwayId) ?? '' }, baseSize: line.baseSize, at: toUtcIso(line.createdAt), when: line.createdAt }]
    }),
    ...orderLines.flatMap((line) => {
      const order = orders.find((row) => row.id === line.orderId)
      if (!order) return []
      return [{ kind: 'ORDER' as const, lineId: line.id, documentId: order.id, number: order.number, status: order.status as string, profileId: line.measurementProfileId!, revision: profiles.get(line.measurementProfileId!) ?? 0, style: { id: line.styleId, code: styles.get(line.styleId) ?? '' }, colourway: { id: line.colourwayId, code: colourways.get(line.colourwayId) ?? '' }, baseSize: line.baseSize, at: toUtcIso(line.createdAt), when: line.createdAt }]
    }),
  ]
  return units.sort((a, b) => b.when.getTime() - a.when.getTime() || (a.lineId < b.lineId ? 1 : -1)).map(({ when: _when, ...unit }) => unit)
}

/** Order states in which a made-to-measure unit is still open (made, not shipped in full, not cancelled). */
export const OPEN_ORDER_STATES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

/** The earliest BOOKED fitting of these revisions (B-W2b-360's appointments), or null. */
export async function nextFittingOf(db: Reader, profileIds: readonly string[], now: Date): Promise<Date | null> {
  if (profileIds.length === 0) return null
  const row = await db.appointment.findFirst({ where: { measurementProfileId: { in: [...profileIds] }, kind: 'FITTING', status: 'BOOKED', startsAt: { gte: now } }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], select: { startsAt: true } })
  return row?.startsAt ?? null
}
