import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { stepsOf, type RepairStage } from '@nexus/factory-domain/sales/repairs/rules'
import { answerHeld, customerNext, DEPTH_LIMITS, PHOTO_STAGES, type EstimateStatus } from '@nexus/factory-domain/sales/repairs-depth/rules'
import type { Place } from '../portal-returns/store'
import { customerLines, dayOrNull, isoOrNull, LINE_COLUMNS, totalsOf, type Reader } from './store'

/**
 * The customer's views of their repairs (B-W2b-342; follow-ups RR1:01, RR1:02): the portal's (as the person, in the
 * tenant's office scope) and a claim link's (as the tenant's system), both for the session's company and party only.
 * What the customer reads: the repair's number, kind, where it is (the stepper's steps and the next step as codes: the
 * pages say them in their own words), what they asked, the garment as they named it, their own photos (shared with
 * them), where to send the garment, and the estimate once SENT (its lines and total in the price grain; never our cost,
 * an internal note, who in the office, a draft or a withdrawn revision). A held action is a code.
 */

export const CUSTOMER_REPAIR = {
  id: true,
  number: true,
  kind: true,
  stage: true,
  channel: true,
  companyId: true,
  siteId: true,
  partyId: true,
  serial: true,
  styleId: true,
  colourwayId: true,
  size: true,
  problem: true,
  workWanted: true,
  receivedAt: true,
  repairedAt: true,
  shippedAt: true,
  cancelledAt: true,
  version: true,
  createdAt: true,
} as const

export async function readCustomerRepair(db: Reader, place: Place, repairId: string) {
  return db.repairOrder.findFirst({ where: { id: repairId, companyId: place.companyId, partyId: place.partyId }, select: CUSTOMER_REPAIR })
}

export type CustomerRepairRow = NonNullable<Awaited<ReturnType<typeof readCustomerRepair>>>

/** The estimates a customer may see: sent or answered (never a draft or a withdrawn one), newest first. */
async function customerEstimates(db: Reader, repairIds: readonly string[]) {
  if (repairIds.length === 0) return []
  return db.repairEstimate.findMany({
    where: { repairId: { in: [...repairIds] }, status: { in: ['SENT', 'ACCEPTED', 'DECLINED'] } },
    select: { id: true, repairId: true, revision: true, status: true, currency: true, validUntil: true, customerNote: true, sentAt: true, answeredAt: true, answeredVia: true, declineReason: true, version: true },
    orderBy: [{ revision: 'desc' }],
  })
}

async function garmentWords(db: Reader, rows: readonly Pick<CustomerRepairRow, 'styleId' | 'colourwayId'>[]) {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.styleId ? [row.styleId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.colourwayId ? [row.colourwayId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return (row: Pick<CustomerRepairRow, 'styleId' | 'colourwayId'>) => ({
    style: row.styleId ? (styles.get(row.styleId) ? { code: styles.get(row.styleId)!.code, name: styles.get(row.styleId)!.name } : null) : null,
    colourway: row.colourwayId ? (colourways.get(row.colourwayId) ? { code: colourways.get(row.colourwayId)!.code, name: colourways.get(row.colourwayId)!.name } : null) : null,
  })
}

/** The customer's repairs (the portal's list, or the ones a claim link opened), newest first. */
export async function customerRepairs(db: Reader, place: Place, only?: ReadonlySet<string>) {
  if (only && only.size === 0) return []
  const rows = await db.repairOrder.findMany({
    where: { companyId: place.companyId, partyId: place.partyId, ...(only ? { id: { in: [...only] } } : {}) },
    select: CUSTOMER_REPAIR,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: DEPTH_LIMITS.list,
  })
  const estimates = await customerEstimates(db, rows.map((row) => row.id))
  const words = await garmentWords(db, rows)
  return rows.map((row) => {
    const estimate = estimates.find((entry) => entry.repairId === row.id) ?? null
    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      stage: row.stage,
      channel: row.channel,
      opened: toUtcIso(row.createdAt),
      open: row.stage !== 'SHIPPED' && row.stage !== 'CANCELLED',
      next: customerNext(row.stage as RepairStage, estimate ? { status: estimate.status as EstimateStatus } : null),
      garment: { ...words(row), size: row.size, serial: row.serial },
      estimate: estimate ? { revision: estimate.revision, status: estimate.status } : null,
    }
  })
}

export interface CustomerOptions {
  readonly seesPrices: boolean
  readonly mayRequest: boolean
  readonly mayUpload: boolean
  readonly preview: boolean
  readonly now: Date
}

/** Why the customer may not add photos now (a code), or null. */
export function photosHeldCode(row: Pick<CustomerRepairRow, 'stage'>, theirs: number, options: Pick<CustomerOptions, 'mayRequest' | 'mayUpload' | 'preview'>): string | null {
  if (options.preview) return 'PREVIEW'
  if (!options.mayRequest) return 'NO_REQUEST'
  if (!options.mayUpload) return 'NO_UPLOAD'
  if (!PHOTO_STAGES.includes(row.stage as RepairStage)) return 'STAGE'
  if (theirs >= DEPTH_LIMITS.photos) return 'FULL'
  return null
}

/** Why the customer may not answer the estimate now (a code), or null. */
export function answerHeldCode(row: Pick<CustomerRepairRow, 'stage' | 'number'>, estimate: { readonly revision: number; readonly status: string; readonly validUntil: Date | null } | null, options: CustomerOptions): string | null {
  if (!estimate || estimate.status !== 'SENT') return 'NOT_ASKED'
  if (options.preview) return 'PREVIEW'
  if (!options.mayRequest) return 'NO_REQUEST'
  if (!options.seesPrices) return 'NO_PRICES'
  const held = answerHeld({ repairNumber: row.number, stage: row.stage as RepairStage, revision: estimate.revision, status: 'SENT', lines: 1, validUntil: dayOrNull(estimate.validUntil), today: businessDate(options.now) })
  if (!held) return null
  return estimate.validUntil && dayOrNull(estimate.validUntil)! < businessDate(options.now) ? 'EXPIRED' : 'NOT_ASKED'
}

const asAddress = (value: unknown): { line1: string; line2: string | null; postalCode: string; city: string; province: string | null; country: string } | null => {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  return typeof entry.line1 === 'string' && typeof entry.postalCode === 'string' && typeof entry.city === 'string' && typeof entry.country === 'string'
    ? { line1: entry.line1, line2: typeof entry.line2 === 'string' ? entry.line2 : null, postalCode: entry.postalCode, city: entry.city, province: typeof entry.province === 'string' ? entry.province : null, country: entry.country }
    : null
}

/** One repair as the customer reads it (the portal's record page, a claim link's report). */
export async function customerRepairView(db: Reader, row: CustomerRepairRow, options: CustomerOptions) {
  const events = await db.repairStageEvent.findMany({ where: { repairId: row.id }, select: { stage: true, at: true }, orderBy: [{ repairVersion: 'asc' }, { at: 'asc' }] })
  const estimates = await customerEstimates(db, [row.id])
  const estimate = estimates[0] ?? null
  const lines = estimate ? await db.repairEstimateLine.findMany({ where: { estimateId: estimate.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }) : []
  const photos = await db.storedFile.findMany({
    where: { recordType: 'RepairOrder', recordId: row.id, partyId: row.partyId, category: 'DAMAGE_PHOTO', status: { not: 'DELETED' }, OR: [{ visibility: { has: 'PARTNER' } }, { visibility: { has: 'LINK' } }] },
    select: { id: true, originalName: true, contentType: true, sizeBytes: true, status: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const site = await db.site.findUnique({ where: { id: row.siteId }, select: { name: true, address: true } })
  const words = await garmentWords(db, [row])
  const sums = totalsOf(lines)
  const address = asAddress(site?.address)
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    stage: row.stage,
    channel: row.channel,
    opened: toUtcIso(row.createdAt),
    version: row.version,
    open: row.stage !== 'SHIPPED' && row.stage !== 'CANCELLED',
    problem: row.problem,
    workWanted: row.workWanted,
    garment: { ...words(row), size: row.size, serial: row.serial },
    steps: stepsOf(row.stage as RepairStage, events.map((event) => ({ stage: event.stage as RepairStage, at: event.at }))),
    next: customerNext(row.stage as RepairStage, estimate ? { status: estimate.status as EstimateStatus } : null),
    receivedAt: isoOrNull(row.receivedAt),
    repairedAt: isoOrNull(row.repairedAt),
    shippedAt: isoOrNull(row.shippedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    /** Where the garment goes (while we wait for it): the repairing site. */
    sendTo: row.stage === 'AWAITING_GOODS' && site ? { name: site.name, address: address ? [address.line1, address.line2, `${address.postalCode} ${address.city}${address.province ? ` (${address.province})` : ''}`, address.country].filter(Boolean).join(', ') : null } : null,
    photos: photos.map((photo) => ({ id: photo.id, name: photo.originalName, contentType: photo.contentType, sizeBytes: photo.sizeBytes, status: photo.status, at: toUtcIso(photo.createdAt) })),
    estimate: estimate
      ? {
          id: estimate.id,
          revision: estimate.revision,
          status: estimate.status,
          currency: estimate.currency,
          validUntil: dayOrNull(estimate.validUntil),
          customerNote: estimate.customerNote,
          sentAt: isoOrNull(estimate.sentAt),
          answeredAt: isoOrNull(estimate.answeredAt),
          answeredVia: estimate.answeredVia,
          declineReason: estimate.declineReason,
          version: estimate.version,
          lines: customerLines(lines),
          amount: asMoney('price', sums.amount),
          partsAmount: asMoney('price', sums.parts),
          labourAmount: asMoney('price', sums.labour),
          labourMinutes: sums.labourMinutes,
        }
      : null,
    actions: {
      addPhotos: photosHeldCode(row, photos.length, options),
      answer: answerHeldCode(row, estimate, options),
    },
  }
}
