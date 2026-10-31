import { COLLECTED_STATUSES } from '@nexus/factory-domain/shipping/shipments/void'
import { formatNumber } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import type { Backorder, Evidence, EvidenceKind, EvidencePaper, Freight, PackingListVersion, Parcel, Shipment, ShipmentRow, SizeBackorder, Tracking, TravelDocument } from './api'
import { hasLeft, type Phrase, type ShippingAbilities } from './model'

/**
 * Shipments every day (B-W2a-71, the screens of B-W2a-48 and B-W2a-17), pure: the freight charged (a price: drawn only
 * with the price grain, typed by hand or back to the site's rule), voiding every label (the carrier voids parcel by
 * parcel; a parcel it already has keeps its label), the order's lines on this shipment and what stays on backorder,
 * printing many DDTs at once, the packing list's versions, the driver's pack, and the intra-EU transport evidence (art. 41
 * DL 331/1993; art. 45a Reg. (EU) 282/2011: two papers from independent parties, one a transport document). Every
 * refusal is a message key of the `shipments` catalogue; the API's English sentences stay out of the words.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- money (the freight charged: the price grain) ------------------------------------------------------------------------

/** Minor units with the currency in the person's language (`7,00 €`); '—' when there is none. */
export function money(minor: number | null | undefined, currency: string, locale: Locale): string {
  if (minor === null || minor === undefined) return '—'
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/**
 * A typed amount in either language's way ("12,50", "12.50", "€ 0") as minor units, 0 included; `undefined` when it is
 * not an amount (the field says so), `null` when nothing was typed.
 */
export function parseFreight(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/\s/g, '').replace(/^€/, '').replace(/€$/, '')
  if (trimmed === '') return null
  const normalised = /,\d{1,2}$/.test(trimmed) ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed.replace(/,/g, '')
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalised)) return undefined
  return Math.round(Number(normalised) * 100)
}

/** The freight as the screen says it: whether the amount is drawn, typed by hand or by the rule, decided or not yet. */
export interface FreightFacts {
  /** The price grain: the amounts are there. */
  shown: boolean
  /** The charge (minor units), when shown and decided. */
  charge: number | null
  /** What the site's rule gives now (shown only). */
  byRule: number | null
  currency: string
  /** Typed by the office / the rule's / not decided yet (the rule sets it when the goods leave). */
  state: 'byHand' | 'byRule' | 'open'
  /** Why the rule gives what it gives, in this screen's words (`charge.basis.<BASIS>`). */
  basis: Phrase
}

export function freightFacts(freight: Freight, shipment: Pick<Shipment, 'status' | 'parcels'>, can: Pick<ShippingAbilities, 'price'>): FreightFacts {
  const shown = can.price && freight.charge !== undefined
  const charge = shown ? (freight.charge ?? null) : null
  const decided = freight.byHand || (freight.charge !== undefined ? freight.charge !== null : hasLeft(shipment.status))
  return {
    shown,
    charge,
    byRule: shown ? (freight.byRule.charge ?? null) : null,
    currency: freight.currency,
    state: freight.byHand ? 'byHand' : decided ? 'byRule' : 'open',
    basis: phrase(`charge.basis.${freight.byRule.basis}`, { parcels: shipment.parcels.length, count: shipment.parcels.length }),
  }
}

/** Why the office cannot type the freight now (null: it can): shipping.freight.manage, the price grain, until cancelled. */
export function freightHeld(shipment: Pick<Shipment, 'status'>, can: Pick<ShippingAbilities, 'freight' | 'price'>): Phrase | null {
  if (!can.freight) return phrase('held.noFreight')
  if (!can.price) return phrase('held.noPrice')
  if (shipment.status === 'CANCELLED') return phrase('held.freightCancelled')
  return null
}

// ---- Void labels (design pop:sh-void) ----------------------------------------------------------------------------------

export interface VoidPlan {
  /** The labelled parcels the carrier is asked to cancel. */
  toVoid: Parcel[]
  /** Labelled parcels the carrier already has (tracking past "label created"): they keep their label. */
  kept: { seq: number; status: string }[]
}

export function voidPlan(shipment: Pick<Shipment, 'parcels'>, tracking: Pick<Tracking, 'parcels'> | null): VoidPlan {
  const statusOf = new Map((tracking?.parcels ?? []).map((parcel) => [parcel.parcelId, parcel.status]))
  const labelled = shipment.parcels.filter((parcel) => parcel.trackingNumber !== null).sort((a, b) => a.seq - b.seq)
  const collected = (parcel: Parcel) => {
    const status = statusOf.get(parcel.id) ?? null
    return status !== null && (COLLECTED_STATUSES as readonly string[]).includes(status) ? status : null
  }
  return {
    toVoid: labelled.filter((parcel) => collected(parcel) === null),
    kept: labelled.flatMap((parcel) => {
      const status = collected(parcel)
      return status ? [{ seq: parcel.seq, status }] : []
    }),
  }
}

/** Why "Void labels" waits (null: it can run): the right, before the goods leave, a label to void, not all collected. */
export function voidHeld(shipment: Pick<Shipment, 'status' | 'parcels'>, plan: VoidPlan, can: Pick<ShippingAbilities, 'voidLabels'>): Phrase | null {
  if (!can.voidLabels) return phrase('held.noVoid')
  if (shipment.status !== 'DRAFT' && shipment.status !== 'PACKED') return phrase('held.voidLeft')
  if (plan.toVoid.length + plan.kept.length === 0) return phrase('held.noLabels')
  if (plan.toVoid.length === 0) return phrase('held.voidCollected', { count: plan.kept.length })
  return null
}

/** The carrier's answer for one parcel, in this screen's words. */
export const voidOutcomeKey = (outcome: { ok: boolean; carrier: 'CANCELLED' | 'QUEUED' | 'NOT_SENT' | null }): string => (outcome.ok ? `void.outcome.${outcome.carrier ?? 'NOT_SENT'}` : 'void.outcome.kept')

// ---- the order's lines on this shipment (design sh-lines: SizeGridProgress) and the backorder -----------------------------

export const PROGRESS_MEASURES = ['ordered', 'released', 'shippedBefore', 'otherOpen', 'thisShipment', 'left'] as const
export type ProgressMeasure = (typeof PROGRESS_MEASURES)[number]

const MEASURE_OF: Record<ProgressMeasure, (size: SizeBackorder) => number> = {
  ordered: (size) => size.ordered,
  released: (size) => size.netReleased,
  shippedBefore: (size) => size.shipped,
  otherOpen: (size) => size.open,
  thisShipment: (size) => size.thisShipment,
  left: (size) => size.backorder,
}

/**
 * One order line as a size grid: a row per measure (ordered, released, shipped before, on other shipments still here,
 * this shipment, still to ship), a column per size and the line's total. "On other shipments" only when there is one.
 */
export function progressRows(line: Backorder['lines'][number]): { measure: ProgressMeasure; values: number[]; total: number }[] {
  return PROGRESS_MEASURES.filter((measure) => measure !== 'otherOpen' || line.sizes.some((size) => size.open > 0)).map((measure) => {
    const values = line.sizes.map(MEASURE_OF[measure])
    return { measure, values, total: values.reduce((sum, value) => sum + value, 0) }
  })
}

/** What this shipment leaves of the order, in words: it completes it, or N stay on backorder (ready now, still to make). */
export function backorderSummary(backorder: Pick<Backorder, 'totals' | 'lines'>): Phrase {
  const { totals } = backorder
  if (totals.backorder === 0) return phrase(totals.closed > 0 ? 'backorder.completeShort' : 'backorder.complete', { closed: totals.closed, count: totals.closed })
  if (totals.readyNow > 0 && totals.inProduction > 0) return phrase('backorder.partialBoth', { count: totals.backorder, ready: totals.readyNow, making: totals.inProduction })
  if (totals.readyNow > 0) return phrase('backorder.partialReady', { count: totals.backorder, ready: totals.readyNow })
  return phrase('backorder.partialMaking', { count: totals.backorder })
}

// ---- Print N DDTs (design sh-grid selection row) ---------------------------------------------------------------------------

export function printDdtsPlan(rows: readonly ShipmentRow[]): { printable: ShipmentRow[]; skipped: ShipmentRow[] } {
  const printable = rows.filter((row) => row.ddt !== null && row.status !== 'CANCELLED')
  const ids = new Set(printable.map((row) => row.id))
  return { printable, skipped: rows.filter((row) => !ids.has(row.id)) }
}

/** Why "Print N DDTs" waits (null: it can run). */
export function printDdtsHeld(plan: { printable: readonly ShipmentRow[] }, can: Pick<ShippingAbilities, 'pack'>): Phrase | null {
  if (!can.pack) return phrase('held.noPrintDdt')
  if (plan.printable.length === 0) return phrase('held.noDdtSelected')
  return null
}

/** One shipment's print, as the dialog says it. */
export interface PrintOutcome {
  id: string
  number: string
  ddt: string | null
  state: 'queued' | 'refused' | 'skipped'
  words: Phrase
}

// ---- the packing list's versions (design sh-docs-other) --------------------------------------------------------------------

/** The version the pack prints: the one that lists the parcels as they are now, else the newest. */
export const packingListToPrint = (versions: readonly PackingListVersion[] | null): PackingListVersion | null => versions?.find((entry) => entry.current) ?? versions?.[0] ?? null

// ---- the driver's pack (design tab:sh-tab-pack "All documents") --------------------------------------------------------------

export type PackDocumentKind = 'DDT' | 'PACKING_LIST' | 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'

export interface PackDocument {
  key: string
  kind: PackDocumentKind
  /** "158/2026", "SH-00160/2", a style's code. */
  label: string
  /** The file to draw; null: none to print (with why). */
  fileId: string | null
  missing: Phrase | null
}

/** What goes in the driver's pack, in print order: the DDT, the packing list, each style's DoC and user information. */
export function packDocuments(input: { ddt: { number: string; fileId: string | null } | null; ddtRequired: boolean; packingList: PackingListVersion | null; travel: readonly TravelDocument[] | null }): PackDocument[] {
  const documents: PackDocument[] = []
  if (input.ddtRequired) {
    documents.push({
      key: 'DDT',
      kind: 'DDT',
      label: input.ddt?.number ?? '',
      fileId: input.ddt?.fileId ?? null,
      missing: !input.ddt ? phrase('pack.missing.ddt') : !input.ddt.fileId ? phrase('pack.missing.ddtPdf') : null,
    })
  }
  documents.push({ key: 'PACKING_LIST', kind: 'PACKING_LIST', label: input.packingList ? input.packingList.number : '', fileId: input.packingList?.fileId ?? null, missing: input.packingList ? null : phrase('pack.missing.packingList') })
  for (const entry of input.travel ?? []) {
    if (entry.kind !== 'DECLARATION_OF_CONFORMITY' && entry.kind !== 'USER_INFORMATION') continue
    const file = entry.copy ?? entry.source
    documents.push({ key: entry.key, kind: entry.kind, label: entry.style ? entry.style.code : '', fileId: file?.id ?? null, missing: file ? null : phrase('pack.missing.travel') })
  }
  return documents
}

// ---- the intra-EU transport evidence (design sh-export: "intra-EU evidence files", LOG-090) ---------------------------------

/** Factory-domain shipping/evidence TRANSPORT_DOCUMENTS: the three transport documents (art. 45a(3)(a)). */
export const TRANSPORT_DOCUMENTS: readonly EvidenceKind[] = ['CMR', 'CARRIER_INVOICE', 'POD']

const available = (papers: readonly EvidencePaper[]) => papers.filter((paper) => paper.status === 'AVAILABLE')

/** The papers are enough to be checked: at least two, at least one a transport document (the API's own count rule). */
export function evidenceEnough(papers: readonly EvidencePaper[]): boolean {
  const kinds = available(papers).map((paper) => paper.kind)
  return kinds.length >= 2 && kinds.some((kind) => TRANSPORT_DOCUMENTS.includes(kind))
}

/** Why the sale needs the evidence, or not, in this screen's words (the API's `need` is English). */
export function evidenceNeed(evidence: Pick<Evidence, 'status' | 'neededBySale'>, shipment: Pick<Shipment, 'status' | 'shipTo'>): Phrase {
  const country = typeof shipment.shipTo.country === 'string' && shipment.shipTo.country ? shipment.shipTo.country.toUpperCase() : '—'
  if (!hasLeft(shipment.status) && evidence.status === 'NOT_NEEDED') return phrase(evidence.neededBySale ? 'evidence.need.whenLeaves' : 'evidence.need.later', { country })
  if (evidence.neededBySale) return phrase('evidence.need.sale', { country })
  if (evidence.status !== 'NOT_NEEDED') return phrase('evidence.need.byOffice', { country })
  return phrase(country === 'IT' ? 'evidence.need.italy' : 'evidence.need.none', { country })
}

/** What is still missing, in words (null: nothing, or not needed). */
export function evidenceMissing(evidence: Pick<Evidence, 'status' | 'papers'>): Phrase | null {
  if (evidence.status === 'NOT_NEEDED' || evidence.status === 'COMPLETE') return null
  const kinds = available(evidence.papers).map((paper) => paper.kind)
  if (evidenceEnough(evidence.papers)) return phrase('evidence.missing.check')
  if (kinds.length === 0) return phrase('evidence.missing.none')
  if (!kinds.some((kind) => TRANSPORT_DOCUMENTS.includes(kind))) return phrase('evidence.missing.transport', { count: kinds.length })
  return phrase('evidence.missing.second', { count: kinds.length })
}

export interface EvidenceHelds {
  file: Phrase | null
  complete: Phrase | null
  reopen: Phrase | null
  /** Say it needs the evidence after all (NOT_NEEDED → AWAITED / PARTIAL), or that it does not (AWAITED without papers). */
  need: Phrase | null
}

export function evidenceHelds(evidence: Pick<Evidence, 'status' | 'papers'>, shipment: Pick<Shipment, 'status'>, can: Pick<ShippingAbilities, 'evidence' | 'uploadFiles'>): EvidenceHelds {
  const left = hasLeft(shipment.status)
  const none = !can.evidence ? phrase('held.noEvidence') : null
  const papers = available(evidence.papers).length
  return {
    file: none ?? (!can.uploadFiles ? phrase('held.noUpload') : !left ? phrase('held.evidenceNotLeft') : evidence.status === 'NOT_NEEDED' ? phrase('held.evidenceNotNeeded') : null),
    complete: none ?? (evidence.status === 'COMPLETE' ? phrase('held.evidenceComplete') : evidence.status === 'NOT_NEEDED' ? phrase('held.evidenceNotNeeded') : !evidenceEnough(evidence.papers) ? phrase('held.evidenceShort') : null),
    reopen: none ?? (evidence.status !== 'COMPLETE' ? phrase('held.evidenceOpen') : null),
    need: none ?? (!left ? phrase('held.evidenceNotLeft') : evidence.status === 'COMPLETE' ? phrase('held.evidenceReopenFirst') : evidence.status !== 'NOT_NEEDED' && papers > 0 ? phrase('held.evidencePapers', { count: papers }) : null),
  }
}

/** The papers a person may file (factory-domain RETAIN: kept 10 years); the API's ATTACHMENT kind takes PDF and images up to 25 MB. */
export const PAPER_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const
export const PAPER_MAX_BYTES = 25 * 1_048_576

/** Why a picked file cannot be filed (a message key), or null. */
export function paperProblem(file: { type: string; size: number; name: string }): string | null {
  if (file.size === 0) return 'evidence.file.empty'
  if (file.size > PAPER_MAX_BYTES) return 'evidence.file.size'
  const type = file.type.toLowerCase()
  if (!(PAPER_TYPES as readonly string[]).includes(type) && !/\.(pdf|jpe?g|png|webp|heic)$/i.test(file.name)) return 'evidence.file.type'
  return null
}

/** A file's size as people read it ("182 KB", "1,4 MB"). */
export function fileSize(bytes: number, locale: Locale): string {
  if (bytes >= 1_048_576) return `${formatNumber(bytes / 1_048_576, locale, { maximumFractionDigits: 1 })} MB`
  return `${formatNumber(Math.max(1, Math.round(bytes / 1024)), locale)} KB`
}
