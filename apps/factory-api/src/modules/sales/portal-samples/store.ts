import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { PORTAL_SAMPLES_LIMITS, WAITING_KINDS, WAITING_RECORD_TYPES } from '@nexus/factory-domain/sales/portal-samples/rules'

/**
 * The reads of the brand's samples page (B-W2b-262). Two kinds, never mixed in one query:
 *
 *   the partner's own (the session's party scope: factory_partner_runtime, row-level security by party): its sample rounds,
 *   their shipments, its swatches and its OPEN approval requests. Every select names its columns and never one the
 *   partner role cannot read or the brand must not see (no instructions, no charge, no decider, no creator, no note).
 *
 *   the tenant's (the office scope, read as the person, only for what the partner read found or for the party's own
 *   private-label styles): the styles' codes, names, seasons and lifecycle, their revisions, and their tech pack versions
 *   (GeneratedDocument TECH_PACK of the StyleRevision; which of them the brand may open is factory-domain's
 *   `brandTechPacks`).
 *
 * Every reader runs one query at a time (one connection runs one query at a time).
 */

export type Reader = FactoryClient

// ---- the partner's reads ------------------------------------------------------------------------------------------

export const ROUND_SELECT = {
  id: true,
  number: true,
  styleId: true,
  kind: true,
  roundNo: true,
  stage: true,
  cells: true,
  dueDate: true,
  decision: true,
  decidedAt: true,
  approvalRequestId: true,
  createdAt: true,
} as const satisfies Prisma.SampleRoundSelect
export type RoundRow = Prisma.SampleRoundGetPayload<{ select: typeof ROUND_SELECT }>

/** The party's rounds of the portal's company (row-level security: the party's own), newest first. */
export const readRounds = (db: Reader, companyId: string): Promise<RoundRow[]> =>
  db.sampleRound.findMany({ where: { companyId }, select: ROUND_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: PORTAL_SAMPLES_LIMITS.rounds })

export const SHIPMENT_SELECT = { id: true, roundId: true, direction: true, carrierName: true, trackingNumber: true, trackingUrl: true, sentAt: true, receivedAt: true, createdAt: true } as const satisfies Prisma.SampleShipmentSelect
export type ShipmentRow = Prisma.SampleShipmentGetPayload<{ select: typeof SHIPMENT_SELECT }>

export const readShipments = (db: Reader, roundIds: readonly string[]): Promise<ShipmentRow[]> =>
  roundIds.length === 0 ? Promise.resolve([]) : db.sampleShipment.findMany({ where: { roundId: { in: [...roundIds] } }, select: SHIPMENT_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

export const REQUEST_SELECT = { id: true, kind: true, recordType: true, recordId: true, question: true, dueAt: true, createdAt: true, version: true } as const satisfies Prisma.ApprovalRequestSelect
export type RequestRow = Prisma.ApprovalRequestGetPayload<{ select: typeof REQUEST_SELECT }>

/** The party's OPEN requests of a product kind on a round, a swatch or a style, in the portal's company. */
export const readWaitingRequests = (db: Reader, companyId: string): Promise<RequestRow[]> =>
  db.approvalRequest.findMany({
    where: { companyId, status: 'OPEN', kind: { in: [...WAITING_KINDS] }, recordType: { in: [...WAITING_RECORD_TYPES] } },
    select: REQUEST_SELECT,
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: PORTAL_SAMPLES_LIMITS.waiting,
  })

export const SWATCH_SELECT = { id: true, styleId: true, roundId: true, kind: true } as const satisfies Prisma.SampleSwatchSelect
export type SwatchRow = Prisma.SampleSwatchGetPayload<{ select: typeof SWATCH_SELECT }>

export const readSwatches = (db: Reader, ids: readonly string[]): Promise<SwatchRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.sampleSwatch.findMany({ where: { id: { in: [...ids] } }, select: SWATCH_SELECT, orderBy: { id: 'asc' } })

// ---- the tenant's reads -------------------------------------------------------------------------------------------

export const STYLE_SELECT = { id: true, code: true, name: true, nameI18n: true, season: true, brandPartyId: true, lifecycle: true, status: true, companyId: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

/** The styles the partner read names (its rounds', swatches', requests'), by id. */
export const readStyles = (db: Reader, ids: readonly string[]): Promise<StyleRow[]> =>
  ids.length === 0 ? Promise.resolve([]) : db.style.findMany({ where: { id: { in: [...ids] } }, select: STYLE_SELECT, orderBy: { id: 'asc' } })

/** The party's own private-label styles of the portal's company or of every company. */
export const readBrandStyles = (db: Reader, partyId: string, companyId: string): Promise<StyleRow[]> =>
  db.style.findMany({ where: { brandPartyId: partyId, OR: [{ companyId }, { companyId: null }] }, select: STYLE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: PORTAL_SAMPLES_LIMITS.styles })

export const REVISION_SELECT = { id: true, styleId: true, revision: true, status: true } as const satisfies Prisma.StyleRevisionSelect
export type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_SELECT }>

export const readRevisions = (db: Reader, styleIds: readonly string[]): Promise<RevisionRow[]> =>
  styleIds.length === 0 ? Promise.resolve([]) : db.styleRevision.findMany({ where: { styleId: { in: [...styleIds] } }, select: REVISION_SELECT, orderBy: [{ styleId: 'asc' }, { revision: 'asc' }] })

export const VERSION_SELECT = { id: true, recordId: true, version: true, layout: true, language: true, fingerprint: true, createdAt: true, companyId: true, fileId: true } as const satisfies Prisma.GeneratedDocumentSelect
export type VersionRow = Prisma.GeneratedDocumentGetPayload<{ select: typeof VERSION_SELECT }>

/** Every tech pack version of these revisions (all audiences: factory-domain keeps the BRAND ones of the brand's styles). */
export const readTechPackVersions = (db: Reader, revisionIds: readonly string[]): Promise<VersionRow[]> =>
  revisionIds.length === 0
    ? Promise.resolve([])
    : db.generatedDocument.findMany({
        where: { recordType: 'StyleRevision', recordId: { in: [...revisionIds] }, kind: 'TECH_PACK' },
        select: VERSION_SELECT,
        orderBy: [{ recordId: 'asc' }, { version: 'desc' }],
        take: PORTAL_SAMPLES_LIMITS.techPacks,
      })

/** One tech pack version, as the open reads it. */
export const readTechPackVersion = (db: Reader, documentId: string) =>
  db.generatedDocument.findUnique({ where: { id: documentId }, select: { ...VERSION_SELECT, kind: true, recordType: true } })

/** A style's name in the reader's language, else as typed. */
export function nameIn(style: Pick<StyleRow, 'name' | 'nameI18n'>, locale: 'it' | 'en'): string {
  const names = style.nameI18n as Record<string, unknown> | null
  const local = names && typeof names[locale] === 'string' ? (names[locale] as string).trim() : ''
  return local || style.name
}
