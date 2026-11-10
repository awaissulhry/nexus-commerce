/**
 * Language packs per market (B-W2b-258; PRD-351; Reg. (EU) 2016/425 art. 8(7): the instructions and information in a
 * language easily understood by users in the Member State where the PPE is made available), pure. A market's pack is the
 * user information of one style revision in every language the market asks for its user information
 * (MarketProfile.userInfoLanguages, B-W2b-249): per language, the signed leaflet (W1's, the live route) and the generated
 * one (a draft until GATE-PPE-TEXTS) with its translation state.
 *
 * One generated leaflet per style revision and language (B-W2b-218's key): a language several markets ask for is one
 * leaflet serving them all; `marketCode` on a leaflet names the market it was made for (its operators: the importer).
 */

export const PACK_STATES = ['ISSUED', 'CHECKED', 'DRAFT', 'IN_TRANSLATION', 'WITHDRAWN', 'MISSING'] as const
export type PackState = (typeof PACK_STATES)[number]

export interface PackMarket {
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly userInfoLanguages: readonly string[]
  readonly switchedOn: boolean
}

export interface PackDocument {
  readonly id: string
  readonly language: string
  readonly revision: number
  readonly status: string
  readonly origin: string
  readonly translationOfId: string | null
  readonly translationStatus: string | null
  readonly marketCode: string | null
  readonly number: string | null
}

export interface PackLanguage {
  language: string
  /** ISSUED: a signed leaflet is live; else the generated one's state (a draft); MISSING: none. */
  state: PackState
  signed: PackDocument | null
  generated: PackDocument | null
}

export interface LanguagePack {
  market: { code: string; name: string; switchedOn: boolean }
  languages: PackLanguage[]
  /** Every language has a signed, issued leaflet: the pack can travel. */
  live: boolean
  /** The languages without any leaflet (signed or generated) of the revision. */
  missing: string[]
}

/** The state of one language of a revision: the signed leaflet first (live), else the generated draft. */
export function packLanguage(language: string, documents: readonly PackDocument[]): PackLanguage {
  const own = documents.filter((document) => document.language === language)
  const signed = own.find((document) => document.origin === 'SIGNED' && document.status === 'ISSUED') ?? null
  const generated = own.find((document) => document.origin === 'GENERATED') ?? null
  let state: PackState = 'MISSING'
  if (signed) state = 'ISSUED'
  else if (generated?.status === 'WITHDRAWN') state = 'WITHDRAWN'
  else if (generated) state = generated.translationStatus === 'CHECKED' ? 'CHECKED' : generated.translationStatus === 'IN_TRANSLATION' ? 'IN_TRANSLATION' : 'DRAFT'
  return { language, state, signed: signed ? { ...signed } : null, generated: generated ? { ...generated } : null }
}

/**
 * The packs of one style revision: per market that applies to the style's company (its own and every company's), the
 * languages it asks with their leaflets. `documents`: the user information of that revision (signed and generated).
 */
export function languagePacks(markets: readonly PackMarket[], documents: readonly PackDocument[], companyId: string | null): LanguagePack[] {
  return markets
    .filter((market) => market.companyId === null || companyId === null || market.companyId === companyId)
    .filter((market) => market.userInfoLanguages.length > 0)
    .map((market) => {
      const languages = market.userInfoLanguages.map((language) => packLanguage(language, documents))
      return {
        market: { code: market.code, name: market.name, switchedOn: market.switchedOn },
        languages,
        live: languages.every((entry) => entry.state === 'ISSUED'),
        missing: languages.filter((entry) => entry.state === 'MISSING').map((entry) => entry.language),
      }
    })
}

/**
 * The translations a pack still needs, for the markets asked: each language they ask that has no generated leaflet of the
 * revision yet (and is not the original's), with the market it is made for — the one market asking for it, else none
 * (a language several of them ask serves them all).
 */
export function packTranslations(markets: readonly PackMarket[], asked: readonly string[], originalLanguage: string, taken: readonly string[]): { language: string; marketCode: string | null }[] {
  const chosen = markets.filter((market) => asked.includes(market.code))
  const out: { language: string; marketCode: string | null }[] = []
  const languages = [...new Set(chosen.flatMap((market) => market.userInfoLanguages))]
  for (const language of languages) {
    if (language === originalLanguage || taken.includes(language)) continue
    const askers = chosen.filter((market) => market.userInfoLanguages.includes(language))
    out.push({ language, marketCode: askers.length === 1 ? askers[0]!.code : null })
  }
  return out
}

// ---- the version per batch (PRD-352) ----------------------------------------------------------------------------------------

export interface BatchWorkOrder {
  readonly id: string
  readonly number: string
  readonly batchNumber: string | null
  readonly styleId: string
  /** The revision the work order froze (its leaflet's revision). */
  readonly revision: number | null
}

export interface BatchRecord {
  readonly documentId: string
  readonly batchNumber: string
  readonly workOrderId: string | null
  readonly shipmentId: string | null
}

export interface BatchLeaflet {
  language: string
  documentId: string
  number: string | null
  revision: number
  status: string
  /** Recorded with the batch (B-W2b-257's records): the shipments that carried it; null: not recorded yet. */
  recorded: { shipmentIds: string[] } | null
}

/**
 * Which user information goes with a batch (PRD-352): the signed leaflets recorded with it (whatever their revision), and
 * for a work order's batch the signed, issued leaflets of the revision it froze that are not recorded yet (they go with it
 * when it ships). `drafts`: the generated leaflets of that revision (never travelling before GATE-PPE-TEXTS).
 */
export function batchLeaflets(input: {
  readonly workOrder: BatchWorkOrder | null
  readonly batchNumber: string
  readonly records: readonly BatchRecord[]
  readonly documents: readonly PackDocument[]
}): { leaflets: BatchLeaflet[]; drafts: { language: string; documentId: string; status: string; translationStatus: string | null }[] } {
  const documentOf = new Map(input.documents.map((document) => [document.id, document]))
  const own = input.records.filter((record) => record.batchNumber === input.batchNumber && (input.workOrder === null || record.workOrderId === null || record.workOrderId === input.workOrder.id))
  const byDocument = new Map<string, Set<string>>()
  for (const record of own) {
    if (!documentOf.has(record.documentId)) continue
    const shipments = byDocument.get(record.documentId) ?? new Set<string>()
    if (record.shipmentId) shipments.add(record.shipmentId)
    byDocument.set(record.documentId, shipments)
  }
  const leaflets: BatchLeaflet[] = [...byDocument.entries()].map(([documentId, shipments]) => {
    const document = documentOf.get(documentId)!
    return { language: document.language, documentId, number: document.number, revision: document.revision, status: document.status, recorded: { shipmentIds: [...shipments].sort() } }
  })
  const revision = input.workOrder?.revision ?? null
  if (revision !== null) {
    for (const document of input.documents) {
      if (document.origin !== 'SIGNED' || document.status !== 'ISSUED' || document.revision !== revision || byDocument.has(document.id)) continue
      if (leaflets.some((entry) => entry.language === document.language && entry.revision === revision)) continue
      leaflets.push({ language: document.language, documentId: document.id, number: document.number, revision: document.revision, status: document.status, recorded: null })
    }
  }
  const drafts = revision === null ? [] : input.documents.filter((document) => document.origin === 'GENERATED' && document.revision === revision).map((document) => ({ language: document.language, documentId: document.id, status: document.status, translationStatus: document.translationStatus }))
  leaflets.sort((a, b) => a.language.localeCompare(b.language) || b.revision - a.revision)
  drafts.sort((a, b) => a.language.localeCompare(b.language))
  return { leaflets, drafts }
}
