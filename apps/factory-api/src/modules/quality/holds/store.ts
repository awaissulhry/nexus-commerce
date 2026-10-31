import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import {
  ageDays,
  BLOCKS,
  isOverdue,
  placedByKind,
  subjectNoun,
  type HoldQuarantine,
  type HoldStatus,
  type HoldSubjectType,
  type SubjectFact,
} from '@nexus/factory-domain/quality/holds/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { reasonWords } from '../../../platform/reasons/service'
import { readSiteStock } from '../../inventory/issue/store'

/**
 * The holds module's reads (B-W2a-26): a hold's row, the records it holds (each kind read the same way: its label, its
 * site, the state the guard reads), what they amount to ("412.0000 FT2", "30 garments"), and the views. Every read
 * names its columns; any client (the command's or the caller's).
 */

export type Reader = CommandTx

export const HOLD_COLUMNS = {
  id: true,
  /** B-W2b-17: its number from the company's HOLD series ("HLD-2026-0091"); null for holds placed before. */
  number: true,
  companyId: true,
  siteId: true,
  subjectType: true,
  subjectIds: true,
  reasonCode: true,
  reasonNote: true,
  sourceType: true,
  sourceId: true,
  status: true,
  placedAt: true,
  placedById: true,
  placedByWorkerId: true,
  ownerId: true,
  expectedReleaseOn: true,
  quarantine: true,
  quarantineLocationId: true,
  quarantineMovedAt: true,
  ncrId: true,
  releasedAt: true,
  releasedById: true,
  releasedByWorkerId: true,
  releaseNote: true,
  notMakerStatement: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.QualityHoldSelect
export type HoldRow = Prisma.QualityHoldGetPayload<{ select: typeof HOLD_COLUMNS }>

export async function readHold(db: Reader, holdId: string): Promise<HoldRow | null> {
  return isUuid(holdId) ? db.qualityHold.findUnique({ where: { id: holdId }, select: HOLD_COLUMNS }) : null
}

/** A held record, with what the place dialog and the hold's view show of it. */
export interface Subject extends SubjectFact {
  readonly companyId: string
  /** Its work order (a work order: itself; a bundle, a serial: theirs; a shipment line's: none here). */
  readonly workOrderId: string | null
  /** How much of it (stock: on hand in the item's base unit; garments: pieces). */
  readonly quantity: { readonly amount: Decimal; readonly uom: string } | null
}

const pieces = (amount: number) => ({ amount: new Dec(amount), uom: 'PCS' })

/** The records of one kind by id (those of no site the caller sees are left out). */
export async function readSubjects(db: Reader, type: HoldSubjectType, ids: readonly string[]): Promise<Subject[]> {
  const wanted = [...new Set(ids.filter(isUuid))]
  if (wanted.length === 0) return []
  const companyOf = async (siteIds: readonly string[]) => new Map((await db.site.findMany({ where: { id: { in: [...new Set(siteIds)] } }, select: { id: true, companyId: true } })).map((site) => [site.id, site.companyId]))
  switch (type) {
    case 'Lot': {
      const rows = await db.lot.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, siteId: true, companyId: true, itemId: true, qualityStatus: true } })
      const items = new Map((await db.item.findMany({ where: { id: { in: rows.map((row) => row.itemId) } }, select: { id: true, baseUom: true } })).map((item) => [item.id, item.baseUom]))
      const out: Subject[] = []
      for (const row of rows) {
        const onHand = (await readSiteStock(db, row.siteId, { itemIds: [row.itemId], lotId: row.id })).reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
        out.push({ id: row.id, label: row.code, siteId: row.siteId, companyId: row.companyId, state: row.qualityStatus, workOrderId: null, quantity: { amount: onHand, uom: items.get(row.itemId) ?? '' } })
      }
      return out
    }
    case 'Hide': {
      const rows = await db.hide.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, siteId: true, itemId: true, state: true } })
      const companies = await companyOf(rows.map((row) => row.siteId))
      const items = new Map((await db.item.findMany({ where: { id: { in: rows.map((row) => row.itemId) } }, select: { id: true, baseUom: true } })).map((item) => [item.id, item.baseUom]))
      const out: Subject[] = []
      for (const row of rows) {
        const onHand = (await readSiteStock(db, row.siteId, { itemIds: [row.itemId], hideId: row.id })).reduce((sum, balance) => sum.plus(balance.onHand), ZERO)
        out.push({ id: row.id, label: row.code, siteId: row.siteId, companyId: companies.get(row.siteId) ?? '', state: row.state, workOrderId: null, quantity: { amount: onHand, uom: items.get(row.itemId) ?? '' } })
      }
      return out
    }
    case 'WorkOrder': {
      const rows = await db.workOrder.findMany({ where: { id: { in: wanted } }, select: { id: true, number: true, siteId: true, companyId: true, status: true, sizes: { select: { quantity: true } } } })
      return rows.map((row) => ({ id: row.id, label: row.number, siteId: row.siteId, companyId: row.companyId, state: row.status, workOrderId: row.id, quantity: pieces(row.sizes.reduce((sum, cell) => sum + cell.quantity, 0)) }))
    }
    case 'Bundle': {
      const rows = await db.bundle.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, siteId: true, status: true, quantity: true, workOrderId: true } })
      const companies = await companyOf(rows.map((row) => row.siteId))
      return rows.map((row) => ({ id: row.id, label: row.code, siteId: row.siteId, companyId: companies.get(row.siteId) ?? '', state: row.status, workOrderId: row.workOrderId, quantity: pieces(row.quantity) }))
    }
    case 'GarmentSerial': {
      const rows = await db.garmentSerial.findMany({ where: { id: { in: wanted } }, select: { id: true, serial: true, siteId: true, status: true, workOrderId: true } })
      const companies = await companyOf(rows.map((row) => row.siteId))
      return rows.map((row) => ({ id: row.id, label: row.serial, siteId: row.siteId, companyId: companies.get(row.siteId) ?? '', state: row.status, workOrderId: row.workOrderId, quantity: pieces(1) }))
    }
    case 'Shipment': {
      const rows = await db.shipment.findMany({ where: { id: { in: wanted } }, select: { id: true, number: true, siteId: true, companyId: true, status: true, lines: { select: { quantity: true } } } })
      return rows.map((row) => ({ id: row.id, label: row.number, siteId: row.siteId, companyId: row.companyId, state: row.status, workOrderId: null, quantity: pieces(row.lines.reduce((sum, line) => sum + line.quantity, 0)) }))
    }
    case 'Parcel': {
      const rows = await db.parcel.findMany({ where: { id: { in: wanted } }, select: { id: true, seq: true, siteId: true, shipment: { select: { number: true, status: true, companyId: true } }, lines: { select: { quantity: true } } } })
      return rows.map((row) => ({ id: row.id, label: `${row.shipment.number}/${row.seq}`, siteId: row.siteId, companyId: row.shipment.companyId, state: row.shipment.status, workOrderId: null, quantity: pieces(row.lines.reduce((sum, line) => sum + line.quantity, 0)) }))
    }
  }
}

/** Scanned or typed codes of one kind → their ids (a bundle by its current or a replaced ticket code). Unknown: left out. */
export async function idsOfCodes(db: Reader, type: HoldSubjectType, codes: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(codes.map((code) => code.trim()).filter(Boolean))]
  const upper = wanted.map((code) => code.toUpperCase())
  if (wanted.length === 0) return new Map()
  const pairs = async (rows: readonly { id: string; code: string }[]) => new Map(rows.map((row) => [row.code, row.id]))
  switch (type) {
    case 'Lot':
      return pairs(await db.lot.findMany({ where: { code: { in: wanted } }, select: { id: true, code: true } }))
    case 'Hide':
      return pairs(await db.hide.findMany({ where: { code: { in: [...wanted, ...upper] } }, select: { id: true, code: true } }))
    case 'WorkOrder':
      return pairs((await db.workOrder.findMany({ where: { number: { in: [...wanted, ...upper] } }, select: { id: true, number: true } })).map((row) => ({ id: row.id, code: row.number })))
    case 'Bundle': {
      const rows = await db.bundle.findMany({ where: { OR: [{ code: { in: upper } }, { replacedCodes: { hasSome: upper } }] }, select: { id: true, code: true, replacedCodes: true } })
      return new Map(rows.flatMap((row) => [row.code, ...row.replacedCodes].map((code) => [code, row.id] as const)))
    }
    case 'GarmentSerial':
      return pairs((await db.garmentSerial.findMany({ where: { serial: { in: [...wanted, ...upper] } }, select: { id: true, serial: true } })).map((row) => ({ id: row.id, code: row.serial })))
    case 'Shipment':
      return pairs((await db.shipment.findMany({ where: { number: { in: [...wanted, ...upper] } }, select: { id: true, number: true } })).map((row) => ({ id: row.id, code: row.number })))
    case 'Parcel':
      return new Map()
  }
}

/** What the held records amount to, per unit ("412.0000 FT2", "30 PCS"); null when nothing is counted. */
export function quantityWords(subjects: readonly Subject[]): string | null {
  const byUom = new Map<string, Decimal>()
  for (const subject of subjects) {
    if (!subject.quantity) continue
    byUom.set(subject.quantity.uom, (byUom.get(subject.quantity.uom) ?? ZERO).plus(subject.quantity.amount))
  }
  const parts = [...byUom.entries()].map(([uom, amount]) => (uom === 'PCS' ? `${amount.toFixed(0)} ${amount.eq(1) ? 'garment' : 'garments'}` : `${quantityText(amount)} ${uom}`))
  return parts.length > 0 ? parts.join(' + ') : null
}

// ---- views ----------------------------------------------------------------------------------------------------------

const dateOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const at = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The HOLD reasons' words (code → English words). */
export async function holdReasonWords(db: Reader): Promise<Map<string, string>> {
  return new Map([...(await reasonWords(db, 'HOLD')).entries()].map(([code, fact]) => [code, fact.labelEn]))
}

export interface HoldViewFacts {
  readonly subjects: ReadonlyMap<string, Subject>
  readonly reasons: ReadonlyMap<string, string>
  readonly locations: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string }>
  /** The owners' names (office users; B-W2a-67: the Holds list's Owner column and its picker). */
  readonly owners: ReadonlyMap<string, string>
  /** The holds' sites (B-W2a-67: the list's Site column). */
  readonly sites: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string }>
  readonly now: Date
}

/** A hold as the list and the record show it (no worker's name; office users by id). */
export function holdView(row: HoldRow, facts: HoldViewFacts) {
  const subjects = row.subjectIds.map((id) => facts.subjects.get(id) ?? null)
  const known = subjects.filter((subject): subject is Subject => subject !== null)
  const today = businessDate(facts.now)
  const type = row.subjectType as HoldSubjectType
  return {
    id: row.id,
    /** B-W2b-17: "HLD-2026-0091" (null: a hold placed before holds were numbered). */
    number: row.number,
    companyId: row.companyId,
    siteId: row.siteId,
    /** B-W2a-67: the site in words (the list's Site column). */
    site: facts.sites.get(row.siteId) ?? null,
    status: row.status as HoldStatus,
    subjectType: type,
    subjects: row.subjectIds.map((id, index) => ({ id, label: subjects[index]?.label ?? null, state: subjects[index]?.state ?? null })),
    /** "3 lots", "work order WO-0142". */
    subjectWords: row.subjectIds.length === 1 && subjects[0] ? `${subjectNoun(type, 1)} ${subjects[0].label}` : `${row.subjectIds.length} ${subjectNoun(type, row.subjectIds.length)}`,
    quantity: quantityWords(known),
    blocks: `Blocks ${BLOCKS[type]}.`,
    reasonCode: row.reasonCode,
    reason: facts.reasons.get(row.reasonCode) ?? row.reasonCode,
    reasonNote: row.reasonNote,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    placedAt: toUtcIso(row.placedAt),
    placedBy: { kind: placedByKind(row), userId: row.placedById },
    ownerId: row.ownerId,
    /** The owner as the Holds list names them (an office user by name; never a floor worker). */
    owner: row.ownerId ? { id: row.ownerId, name: facts.owners.get(row.ownerId) ?? '' } : null,
    expectedReleaseOn: dateOf(row.expectedReleaseOn),
    overdue: isOverdue({ status: row.status as HoldStatus, expectedReleaseOn: dateOf(row.expectedReleaseOn) }, today),
    ageDays: ageDays(toUtcIso(row.placedAt), at(row.releasedAt ?? row.closedAt), toUtcIso(facts.now)),
    quarantine: row.quarantine as HoldQuarantine,
    quarantineLocation: row.quarantineLocationId ? (facts.locations.get(row.quarantineLocationId) ?? { id: row.quarantineLocationId, code: '', name: '' }) : null,
    quarantineMovedAt: at(row.quarantineMovedAt),
    ncrId: row.ncrId,
    releasedAt: at(row.releasedAt),
    releasedBy: row.releasedAt ? { kind: row.releasedById ? ('USER' as const) : ('WORKER' as const), userId: row.releasedById } : null,
    releaseNote: row.releaseNote,
    closedAt: at(row.closedAt),
    closedById: row.closedById,
    closeNote: row.closeNote,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type HoldView = ReturnType<typeof holdView>

/** The facts the views of these holds need, read once. */
export async function viewFactsOf(db: Reader, rows: readonly HoldRow[], now: Date): Promise<HoldViewFacts> {
  const subjects = new Map<string, Subject>()
  const byType = new Map<HoldSubjectType, string[]>()
  for (const row of rows) byType.set(row.subjectType as HoldSubjectType, [...(byType.get(row.subjectType as HoldSubjectType) ?? []), ...row.subjectIds])
  for (const [type, ids] of byType) for (const subject of await readSubjects(db, type, ids)) subjects.set(subject.id, subject)
  const locationIds = [...new Set(rows.flatMap((row) => (row.quarantineLocationId ? [row.quarantineLocationId] : [])))]
  const locations = new Map((locationIds.length > 0 ? await db.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
  const ownerIds = [...new Set(rows.flatMap((row) => (row.ownerId ? [row.ownerId] : [])))]
  const owners = new Map((ownerIds.length > 0 ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true } }) : []).map((user) => [user.id, user.displayName]))
  const siteIds = [...new Set(rows.map((row) => row.siteId))]
  const sites = new Map((siteIds.length > 0 ? await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true } }) : []).map((site) => [site.id, site]))
  return { subjects, reasons: await holdReasonWords(db), locations, owners, sites, now }
}
