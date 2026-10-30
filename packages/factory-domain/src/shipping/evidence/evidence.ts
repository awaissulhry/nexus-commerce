/**
 * Transport evidence for intra-EU sales (B-W2a-48; LOG-090; SCOPE rule 3 "transport proof"; art. 41 DL 331/1993 and
 * Reg. (EU) 282/2011 art. 45a): a zero-rated supply to a business in another EU state stands only if the seller can
 * prove that the goods were carried there. The papers are files of the shipment (StoredFile recordType "Shipment"); the
 * shipment keeps the state (Shipment.transportEvidence, COMPLETE with when and by whom). Pure rules; apps/factory-api's
 * modules/shipping/documents keeps the files and the state. Chasing the papers (reminders) is later (SCOPE "chasing
 * later").
 *
 *   needed     a sale the order made zero-rated as intra-EU (taxMode EU_B2B) whose goods go to another EU state than
 *              the seller's: AWAITED when the goods leave (SHIPPED); otherwise NOT_NEEDED. The office may say otherwise
 *              (with a reason) once the goods left.
 *   PARTIAL    at least one paper is on file, not yet enough
 *   COMPLETE   a person checked that the papers are enough: art. 45a asks for two non-contradictory items from two
 *              parties independent of each other, of the seller and of the buyer (a signed CMR, the carrier's invoice,
 *              the carrier's proof of delivery), or one of them with another kind (insurance of the transport, the bank's
 *              proof the transport was paid, a public authority's or the warehouse keeper's paper at the destination):
 *              at least two papers, at least one a transport document. The person's check is the "independent parties"
 *              part; the rule here is the count and the kinds.
 *   reopened   COMPLETE goes back (PARTIAL, or AWAITED without papers) with a reason (a paper found wrong).
 */

/** The 27 EU member states (ISO 3166-1 alpha-2; Greece is GR here, EL only in VAT numbers). */
export const EU_COUNTRIES: readonly string[] = Object.freeze([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

export const isEuCountry = (country: string | null | undefined): boolean => typeof country === 'string' && EU_COUNTRIES.includes(country.trim().toUpperCase())

export const TRANSPORT_EVIDENCE_STATUSES = ['NOT_NEEDED', 'AWAITED', 'PARTIAL', 'COMPLETE'] as const
export type TransportEvidenceStatus = (typeof TRANSPORT_EVIDENCE_STATUSES)[number]

/** The kinds of paper: three transport documents (art. 45a(3)(a)) and the other kinds (art. 45a(3)(b)). */
export const EVIDENCE_KINDS = ['CMR', 'CARRIER_INVOICE', 'POD', 'OTHER'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export const TRANSPORT_DOCUMENTS: readonly EvidenceKind[] = Object.freeze(['CMR', 'CARRIER_INVOICE', 'POD'])

const KIND_WORDS: Readonly<Record<EvidenceKind, string>> = { CMR: 'signed CMR', CARRIER_INVOICE: "carrier's invoice", POD: 'proof of delivery', OTHER: 'other paper' }
export const evidenceKindWords = (kind: EvidenceKind): string => KIND_WORDS[kind]

export interface NeedFacts {
  /** The order's VAT treatment (SalesOrder.taxMode). */
  readonly taxMode: string
  /** Where the goods go (the shipment's ship-to snapshot's country). */
  readonly shipToCountry: string | null
  /** The seller's country (Company.country). */
  readonly companyCountry: string
}

/** Whether a shipment that leaves needs intra-EU transport evidence, and why (in words). */
export function evidenceNeed(facts: NeedFacts): { readonly needed: boolean; readonly words: string } {
  const to = facts.shipToCountry?.trim().toUpperCase() ?? ''
  const from = facts.companyCountry.trim().toUpperCase()
  if (facts.taxMode !== 'EU_B2B') return { needed: false, words: 'Not a zero-rated intra-EU sale: no transport evidence is needed.' }
  if (!isEuCountry(to)) return { needed: false, words: `The goods go to ${to || 'an unknown country'}, not to an EU state: art. 41 does not apply (an export has its own proof of exit).` }
  if (to === from) return { needed: false, words: `The goods stay in ${to}: the sale is not an intra-EU supply.` }
  return { needed: true, words: `A zero-rated intra-EU sale to ${to} (art. 41 DL 331/1993): keep the proof that the goods arrived there.` }
}

/** The state after a paper is filed: AWAITED → PARTIAL; PARTIAL and COMPLETE stay. */
export function stateAfterFiling(current: TransportEvidenceStatus): TransportEvidenceStatus {
  return current === 'AWAITED' ? 'PARTIAL' : current
}

/** Why a paper cannot be filed now (empty: it can): only for a shipment that left and needs the evidence. */
export function filingProblems(shipmentStatus: string, current: TransportEvidenceStatus): string[] {
  if (!['SHIPPED', 'DELIVERED', 'RETURNED'].includes(shipmentStatus)) return [`The shipment is ${shipmentStatus}: transport evidence is filed once the goods left.`]
  if (current === 'NOT_NEEDED') return ['This shipment needs no intra-EU transport evidence: say it does first (with the reason), then file the papers.']
  return []
}

/** What COMPLETE asks of the papers on file (empty: they are enough to be checked). */
export function completeProblems(current: TransportEvidenceStatus, kinds: readonly EvidenceKind[]): string[] {
  if (current === 'NOT_NEEDED') return ['This shipment needs no intra-EU transport evidence.']
  if (current === 'COMPLETE') return ['The transport evidence is complete already.']
  const transport = kinds.filter((kind) => TRANSPORT_DOCUMENTS.includes(kind)).length
  if (kinds.length >= 2 && transport >= 1) return []
  const onFile = kinds.length === 0 ? 'nothing' : summary(kinds)
  return [
    `Art. 45a Reg. (EU) 282/2011 asks for two non-contradictory papers from parties independent of each other: two transport documents (a signed CMR, the carrier's invoice, the proof of delivery), or one with an insurance, bank or authority paper. On file: ${onFile}.`,
  ]
}

/** "1 proof of delivery, 1 signed CMR". */
export function summary(kinds: readonly EvidenceKind[]): string {
  const counts = new Map<EvidenceKind, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return EVIDENCE_KINDS.filter((kind) => counts.has(kind))
    .map((kind) => `${counts.get(kind)} ${KIND_WORDS[kind]}`)
    .join(', ')
}

/** Where a reopened COMPLETE goes: PARTIAL with papers on file, AWAITED without. */
export const stateAfterReopen = (papers: number): TransportEvidenceStatus => (papers > 0 ? 'PARTIAL' : 'AWAITED')

/** Why the office cannot say a shipment does (or does not) need the evidence (empty: it can). */
export function needChangeProblems(shipmentStatus: string, current: TransportEvidenceStatus, needed: boolean, papers: number): string[] {
  if (!['SHIPPED', 'DELIVERED', 'RETURNED'].includes(shipmentStatus)) return [`The shipment is ${shipmentStatus}: whether it needs transport evidence is decided when the goods leave.`]
  if (needed && current !== 'NOT_NEEDED') return ['The shipment already needs its transport evidence.']
  if (!needed && current === 'NOT_NEEDED') return ['The shipment already needs no transport evidence.']
  if (!needed && current === 'COMPLETE') return ['The transport evidence is complete: reopen it first.']
  if (!needed && papers > 0) return [`${papers} paper(s) are on file as transport evidence: a shipment with papers stays one that needs them.`]
  return []
}

/** The state when the office says the shipment needs the evidence after all: AWAITED, or PARTIAL with papers. */
export const stateWhenNeeded = (papers: number): TransportEvidenceStatus => (papers > 0 ? 'PARTIAL' : 'AWAITED')

/** What is missing, in words, for the record (null: nothing, or not needed). */
export function missingWords(current: TransportEvidenceStatus, kinds: readonly EvidenceKind[]): string | null {
  if (current === 'NOT_NEEDED' || current === 'COMPLETE') return null
  const problems = completeProblems(current, kinds)
  return problems.length > 0 ? problems[0]! : 'The papers on file may be enough: a person checks them and marks the evidence complete.'
}
