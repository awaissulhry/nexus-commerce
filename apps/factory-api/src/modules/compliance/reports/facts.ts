import type { Prisma } from '@nexus/factory-db'
import type { GateLine } from '@nexus/factory-domain/compliance/gates/gate'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import type { RegisterKind } from '@nexus/factory-domain/compliance/register/rules'
import { coverageCellOf, type CoverageCell, type CrViResult, type MissingLine, type RegisterFact, type ShippedPair } from '@nexus/factory-domain/compliance/reports/rules'
import type { ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import { expiryMonths, windowEnd, type ExpiryItem } from '@nexus/factory-domain/compliance/status/board'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { countryOf, marketOfCountry, readMarkets } from '../gates/facts'
import { noticeReach } from '../recall/notices'
import { recallReach } from '../recall/recalls'
import { requestReach } from '../recall/requests'
import { ENTRY_SCOPE } from '../register/register'
import type { Reader } from '../register-of-rules/common'
import { readMatrix } from '../status/board'
import { companyWhere, partyRef, type Place, type Ref } from './access'

/**
 * The records the compliance reports count (B-W2b-272), read one query after another, each the narrowest select it needs and
 * each within the reader's own view permission (scopeWhere) and the screen's company. The style × market matrix is the status
 * board's own read (B-W2b-254 `readMatrix`: every cell's lines from THE gate's checks): nothing here decides a requirement.
 * Nothing here writes.
 */

type Span = Place['span']
const within = (span: Span) => ({ gte: span.start, lt: span.end })
const dayOf = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
const dayText = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const unique = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]
const AND = (...parts: readonly unknown[]) => ({ AND: parts.filter((part) => part && Object.keys(part as object).length > 0) })

/** The styles of a brand (the brand filter of the style-based figures); null: no brand asked. */
export async function brandStyleIds(db: Reader, place: Pick<Place, 'brand'>): Promise<Set<string> | null> {
  if (!place.brand) return null
  return new Set((await db.style.findMany({ where: { brandPartyId: place.brand.id }, select: { id: true } })).map((row) => row.id))
}

// ---- the style × market matrix (the status board's read) ---------------------------------------------------------------------

export interface Matrix {
  readonly cells: readonly CoverageCell[]
  readonly missing: readonly MissingLine[]
  /** Styles read (after the company and brand filters) and whether the board stopped at its limit. */
  readonly styles: number
  readonly more: boolean
  readonly markets: readonly { readonly code: string; readonly name: string }[]
  /** The brands of the company's styles (before the brand filter). */
  readonly brands: readonly Ref[]
}

const asReportLines = (styleId: string, marketCode: string, lines: readonly GateLine[]): MissingLine[] =>
  lines.map((line) => ({ check: line.check, state: line.state, blocks: line.blocks, requirement: { code: line.requirement.code, kind: line.requirement.kind, blocks: line.requirement.blocks }, styleId, marketCode }))

/**
 * The board's matrix for the screen's company (its styles and the tenant-wide ones) and the brand: every switched-on market,
 * at most 200 styles (the board's limit; `more` says the read stopped there). Null when the reader may not see certificates.
 */
export async function matrixOf(db: Reader, place: Place): Promise<Matrix | null> {
  if (!place.sight.certificates) return null
  const matrix = await readMatrix(db, place.context, { limit: 200 })
  const ofCompany = matrix.rows.filter((row) => !place.company || row.style.companyId === null || row.style.companyId === place.company.id)
  const brands = new Map<string, Ref>()
  for (const row of ofCompany) if (row.style.brand) brands.set(row.style.brand.id, row.style.brand)
  const kept = new Set(ofCompany.filter((row) => !place.brand || row.style.brand?.id === place.brand.id).map((row) => row.style.id))
  const lines = matrix.cellLines.filter((cell) => kept.has(cell.styleId))
  return {
    cells: lines.map((cell) => coverageCellOf(cell.styleId, cell.marketCode, asReportLines(cell.styleId, cell.marketCode, cell.lines))),
    missing: lines.flatMap((cell) => asReportLines(cell.styleId, cell.marketCode, cell.lines).filter((line) => line.state === 'MISSING')),
    styles: kept.size,
    more: matrix.more,
    markets: matrix.markets.map((market) => ({ code: market.code, name: market.name })),
    brands: [...brands.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }
}

// ---- shipments ------------------------------------------------------------------------------------------------------------------

/** The style × market pairs shipped in the period (shipped, delivered or returned since), with the shipments counted. */
export async function shippedPairs(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ pairs: ShippedPair[]; shipments: number }> {
  const shipments = await db.shipment.findMany({
    where: AND(scopeWhere(place.actor, SHIPPING_VIEW, { company: 'companyId', site: 'siteId' }), companyWhere(place), { status: { in: ['SHIPPED', 'DELIVERED', 'RETURNED'] }, shippedAt: within(place.span) }) as Prisma.ShipmentWhereInput,
    select: { id: true, shipTo: true },
  })
  if (shipments.length === 0) return { pairs: [], shipments: 0 }
  const markets = await readMarkets(db)
  const marketOf = new Map(shipments.map((shipment) => [shipment.id, marketOfCountry(countryOf(shipment.shipTo), markets)?.code ?? null]))
  const lines = await db.shipmentLine.findMany({ where: { shipmentId: { in: shipments.map((shipment) => shipment.id) } }, select: { shipmentId: true, workOrderId: true } })
  const workOrders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(lines.map((line) => line.workOrderId)) } }, select: { id: true, styleId: true } })).map((row) => [row.id, row.styleId]))
  const pairs: ShippedPair[] = []
  const shipped = new Set<string>()
  for (const line of lines) {
    const styleId = workOrders.get(line.workOrderId)
    if (!styleId || (brandStyles && !brandStyles.has(styleId))) continue
    shipped.add(line.shipmentId)
    pairs.push({ styleId, marketCode: marketOf.get(line.shipmentId) ?? null })
  }
  return { pairs, shipments: brandStyles ? shipped.size : shipments.length }
}

// ---- gate refusals ----------------------------------------------------------------------------------------------------------------

/** The gate refusals recorded in the period, per gate, and the overrides given in it. */
export async function gateRefusals(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ count: number; overridden: number; byGate: { gate: ComplianceGate; count: number }[] }> {
  const rows = await db.gateEvent.findMany({
    where: AND(scopeWhere(place.actor, CERTIFICATES_VIEW, { company: 'companyId', site: { field: 'siteId', nullable: true } }), companyWhere(place), { createdAt: within(place.span) }, brandStyles ? { styleId: { in: [...brandStyles] } } : {}) as Prisma.GateEventWhereInput,
    select: { gate: true, outcome: true },
  })
  const refused = rows.filter((row) => row.outcome === 'REFUSED')
  const gates: ComplianceGate[] = ['WORK_ORDER_RELEASE', 'LABEL_PRINT', 'FINAL_RELEASE', 'SHIPMENT']
  return { count: refused.length, overridden: rows.filter((row) => row.outcome === 'OVERRIDDEN').length, byGate: gates.map((gate) => ({ gate, count: refused.filter((row) => row.gate === gate).length })) }
}

// ---- the register ---------------------------------------------------------------------------------------------------------------

const entryWhere = (place: Place, brandStyles: ReadonlySet<string> | null): Prisma.PpeRegisterEntryWhereInput =>
  AND(scopeWhere(place.actor, REGISTER_VIEW, ENTRY_SCOPE), companyWhere(place), brandStyles ? { styleId: { in: [...brandStyles] } } : {}) as Prisma.PpeRegisterEntryWhereInput

/** Register entries open at the period's end (reported by then, not closed by then) and those that may present a risk. */
export async function registerOpenAt(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ count: number; risk: number }> {
  const open = { reportedAt: { lt: place.span.end }, OR: [{ closedAt: null }, { closedAt: { gte: place.span.end } }] }
  const count = await db.ppeRegisterEntry.count({ where: AND(entryWhere(place, brandStyles), open) as Prisma.PpeRegisterEntryWhereInput })
  const risk = await db.ppeRegisterEntry.count({ where: AND(entryWhere(place, brandStyles), open, { risk: 'YES' }) as Prisma.PpeRegisterEntryWhereInput })
  return { count, risk }
}

/** The entries that matter to the period: reported before its end and not closed before its start. */
export async function registerFacts(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<RegisterFact[]> {
  const rows = await db.ppeRegisterEntry.findMany({
    where: AND(entryWhere(place, brandStyles), { reportedAt: { lt: place.span.end }, OR: [{ closedAt: null }, { closedAt: { gte: place.span.start } }] }) as Prisma.PpeRegisterEntryWhereInput,
    select: { kind: true, reportedAt: true, closedAt: true },
  })
  return rows.map((row) => ({ kind: row.kind as RegisterKind, reportedAt: row.reportedAt, closedAt: row.closedAt }))
}

/** Authority notices marked sent in the period, and the drafts today (a brand: the notices of its styles' entries). */
export async function noticesOf(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ sent: number; drafts: number }> {
  const base = AND(noticeReach(place.context), companyWhere(place), brandStyles ? { registerEntry: { styleId: { in: [...brandStyles] } } } : {})
  return {
    sent: await db.authorityNotice.count({ where: AND(base, { status: 'SENT', sentAt: within(place.span) }) as Prisma.AuthorityNoticeWhereInput }),
    drafts: await db.authorityNotice.count({ where: AND(base, { status: 'DRAFT' }) as Prisma.AuthorityNoticeWhereInput }),
  }
}

/** Recalls and withdrawals in progress today, closed in the period, and the units still out of those in progress. */
export async function recallsOf(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ active: number; closed: number; unitsStillOut: number }> {
  const base = AND(recallReach(place.context), companyWhere(place), brandStyles ? { styleId: { in: [...brandStyles] } } : {}) as Prisma.RecallActionWhereInput
  const out = await db.recallProgress.aggregate({ where: { recallAction: AND(base, { status: 'ACTIVE' }) as Prisma.RecallActionWhereInput }, _sum: { unitsStillOut: true } })
  return {
    active: await db.recallAction.count({ where: AND(base, { status: 'ACTIVE' }) as Prisma.RecallActionWhereInput }),
    closed: await db.recallAction.count({ where: AND(base, { status: 'CLOSED', closedAt: within(place.span) }) as Prisma.RecallActionWhereInput }),
    unitsStillOut: out._sum.unitsStillOut ?? 0,
  }
}

/** Authority requests: received in the period; answered in it (due day and answer); open and overdue today. */
export async function requestsOf(db: Reader, place: Place, brandStyles: ReadonlySet<string> | null): Promise<{ received: number; answered: { answeredAt: Date | null; dueOn: BusinessDate }[]; open: number; overdue: number }> {
  const base = AND(requestReach(place.context), companyWhere(place), brandStyles ? { styleId: { in: [...brandStyles] } } : {}) as Prisma.AuthorityRequestWhereInput
  const answered = await db.authorityRequest.findMany({ where: AND(base, { status: 'ANSWERED', answeredAt: within(place.span) }) as Prisma.AuthorityRequestWhereInput, select: { answeredAt: true, dueOn: true } })
  return {
    received: await db.authorityRequest.count({ where: AND(base, { receivedAt: within(place.span) }) as Prisma.AuthorityRequestWhereInput }),
    answered: answered.map((row) => ({ answeredAt: row.answeredAt, dueOn: dayText(row.dueOn) })),
    open: await db.authorityRequest.count({ where: AND(base, { status: 'OPEN' }) as Prisma.AuthorityRequestWhereInput }),
    overdue: await db.authorityRequest.count({ where: AND(base, { status: 'OPEN', dueOn: { lt: dayOf(place.today) } }) as Prisma.AuthorityRequestWhereInput }),
  }
}

// ---- lots and chromium VI ---------------------------------------------------------------------------------------------------------

const lotWhere = (place: Place): Prisma.LotWhereInput => AND(scopeWhere(place.actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }), companyWhere(place)) as Prisma.LotWhereInput

/** Lots that need a Cr VI test issued to production in the period (an issue not reversed), and those with a passing result. */
export async function crViLotsUsed(db: Reader, place: Place): Promise<{ lots: number; withEvidence: number }> {
  const moves = await db.stockMove.findMany({ where: { reason: 'ISSUE', lotId: { not: null }, occurredAt: within(place.span), reversalOfId: null, reversals: { none: {} } }, select: { lotId: true } })
  const lotIds = unique(moves.map((move) => move.lotId))
  if (lotIds.length === 0) return { lots: 0, withEvidence: 0 }
  const lots = await db.lot.findMany({ where: AND(lotWhere(place), { id: { in: lotIds }, requiresCrViTest: true }) as Prisma.LotWhereInput, select: { crViStatus: true } })
  return { lots: lots.length, withEvidence: lots.filter((lot) => lot.crViStatus === 'PASS').length }
}

/** Lots that need a Cr VI result and have none that passes, still held (quarantine or blocked): the open Cr VI gaps. */
export async function crViGapLots(db: Reader, place: Place): Promise<number> {
  return db.lot.count({ where: AND(lotWhere(place), { requiresCrViTest: true, crViStatus: { in: ['PENDING', 'FAIL'] }, qualityStatus: { in: ['QUARANTINE', 'BLOCKED'] } }) as Prisma.LotWhereInput })
}

/** The current (not superseded) Cr VI results tested in the period, with their lot's supplier; the suppliers by id. */
export async function crViResults(db: Reader, place: Place): Promise<{ results: CrViResult[]; parties: Map<string, Ref> }> {
  const rows = await db.labResult.findMany({
    where: AND(scopeWhere(place.actor, QUALITY_LOTS_VIEW, { company: 'companyId', site: 'siteId' }), companyWhere(place), { test: 'CR_VI', testedOn: { gte: dayOf(place.period.from), lte: dayOf(place.period.to) }, supersededBy: { none: {} } }) as Prisma.LabResultWhereInput,
    select: { lotId: true, valueMgKg: true, belowDetectionLimit: true, limitMgKg: true, verdict: true, evidence: true, lot: { select: { supplierId: true } } },
  })
  const results: CrViResult[] = rows.map((row) => ({
    lotId: row.lotId,
    supplierId: row.lot.supplierId,
    value: row.valueMgKg === null ? null : Number(row.valueMgKg.toString()),
    belowDetection: row.belowDetectionLimit,
    limit: Number(row.limitMgKg.toString()),
    verdict: row.verdict,
    evidence: row.evidence,
  }))
  const supplierIds = unique(results.map((result) => result.supplierId))
  const parties = new Map((supplierIds.length > 0 ? await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true, tradeName: true } }) : []).map((party) => [party.id, partyRef(party)]))
  return { results, parties }
}

// ---- the expiry calendar ----------------------------------------------------------------------------------------------------------

export interface Expiry extends ExpiryItem {
  readonly recordType: 'Certificate' | 'SupplierDeclarationRequest'
  readonly status: string
  readonly detail: string | null
  readonly party: string | null
  readonly endsWithBase: boolean
}

/**
 * What stops within `months` months from today, per month: certificates in force (VALID or SUSPENDED; a brand's own certificate
 * stops with its base when the base ends first — B-W2b-255) and accepted supplier declarations (B-W2b-256). With a brand, the
 * certificates that cover its styles or that it holds; declarations are per material (no brand).
 */
export async function expiriesOf(db: Reader, place: Place, months: number, brandStyles: ReadonlySet<string> | null) {
  const end = windowEnd(place.today, months)
  const window = { gte: dayOf(place.today), lte: dayOf(end) }
  const items: Expiry[] = []
  if (place.sight.certificates) {
    const brandWhere = place.brand ? { OR: [{ holderPartyId: place.brand.id }, { coverage: { some: { status: 'ACTIVE', styleId: { in: [...(brandStyles ?? [])] } } } }] } : {}
    const certificates = await db.certificate.findMany({
      where: AND(scopeWhere(place.actor, CERTIFICATES_VIEW, { company: { field: 'companyId', nullable: true } }), companyWhere(place, true), brandWhere, { status: { in: ['VALID', 'SUSPENDED'] } }, { OR: [{ validTo: window }, { baseCertificate: { validTo: window } }] }) as Prisma.CertificateWhereInput,
      select: { id: true, number: true, standard: true, status: true, validTo: true, baseCertificate: { select: { validTo: true } } },
      orderBy: [{ validTo: 'asc' }, { number: 'asc' }],
      take: 500,
    })
    for (const row of certificates) {
      const own = dayText(row.validTo)
      const base = row.baseCertificate ? dayText(row.baseCertificate.validTo) : null
      const stops = base && base < own ? base : own
      if (stops < place.today || stops > end) continue
      items.push({ recordType: 'Certificate', recordId: row.id, label: row.number, validTo: stops, status: row.status, detail: row.standard, party: null, endsWithBase: stops !== own })
    }
    const declarations = await db.supplierDeclarationRequest.findMany({
      where: AND(scopeWhere(place.actor, CERTIFICATES_VIEW, { company: 'companyId' }), companyWhere(place), { status: 'ACCEPTED', validTo: window }) as Prisma.SupplierDeclarationRequestWhereInput,
      select: { id: true, number: true, kind: true, status: true, validTo: true, party: { select: { legalName: true, tradeName: true } } },
      orderBy: [{ validTo: 'asc' }, { number: 'asc' }],
      take: 500,
    })
    for (const row of declarations) {
      if (!row.validTo) continue
      items.push({ recordType: 'SupplierDeclarationRequest', recordId: row.id, label: row.number, validTo: dayText(row.validTo), status: row.status, detail: row.kind, party: row.party.tradeName ?? row.party.legalName, endsWithBase: false })
    }
  }
  return { end, months: expiryMonths(items, place.today, months) as { month: string; count: number; items: Expiry[] }[], count: items.length }
}
