import { z } from 'zod'
import { WARNING_REASONS } from '@nexus/factory-domain/compliance/label-rules/marking'
import { FINDING_SEVERITIES, LABEL_RULE_KEYS, LABEL_RULE_OUTCOMES } from '@nexus/factory-domain/compliance/label-rules/rules'
import { LABEL_KINDS, LABEL_QR_TARGETS } from '@nexus/factory-domain/compliance/labels/rules'
import { CELL_STATES, PHRASE_KINDS } from '@nexus/factory-domain/compliance/phrases/rules'
import { CHECK_KEYS } from '@nexus/factory-domain/compliance/textile-rules/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { completeUpload, downloadLink, requestUpload } from '../../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../../record-panels/store'
import { detailSchema, type LabelDetail } from '../api'

/**
 * The W2b calls of Labels & marking (B-W2b-270, SCR-053), beside W1's (../api.ts): what a PPE label must say per market
 * (B-W2b-253 `/compliance/label-rules`), the textile, leather and origin checks of the label's style (B-W2b-208
 * `/compliance/textile-rules`), the label's artwork proofs and their approval by a second person (B-W2b-259
 * `/compliance/label-artwork`, with this step's `…/waiting` read), the phrase library and the markets (B-W2b-249
 * `/compliance/rules/phrases`, `/compliance/rules/markets`). The answers are checked against local schemas that mirror the
 * API's contracts; unknown fields are ignored. Every write sends the version it was made on and an idempotency key.
 */

const enc = encodeURIComponent
const key = () => ({ idempotencyKey: newIdempotencyKey() })

export const lawSchema = z.object({ law: z.string(), plain: z.string(), href: z.string().nullable() })
export type Law = z.infer<typeof lawSchema>

// ---- what a PPE label must say (B-W2b-253) ----------------------------------------------------------------------------

const ruleCheckSchema = z.object({
  key: z.enum(LABEL_RULE_KEYS),
  gateKey: z.string(),
  title: z.string(),
  outcome: z.enum(LABEL_RULE_OUTCOMES),
  blocks: z.boolean(),
  words: z.string(),
  law: z.array(lawSchema),
  findings: z.array(z.object({ path: z.string(), message: z.string(), severity: z.enum(FINDING_SEVERITIES) })),
})
export type RuleCheck = z.infer<typeof ruleCheckSchema>

const senderSchema = z.object({ who: z.enum(['BRAND', 'COMPANY']), name: z.string().nullable(), address: z.string().nullable(), contact: z.string().nullable(), operatorId: z.string().nullable() })
export type Sender = z.infer<typeof senderSchema>
const levelSchema = z.object({ level: z.string(), knuckle: z.boolean() })

export const marketRefSchema = z.object({ code: z.string(), name: z.string(), switchedOn: z.boolean(), labelLanguages: z.array(z.string()), markings: z.array(z.string()), gpsrContactNeeded: z.boolean() })
export type MarketRef = z.infer<typeof marketRefSchema>

export const labelChecksSchema = z.object({
  label: z.object({ id: z.string(), code: z.string(), revision: z.number().int(), status: z.string(), kind: z.enum(LABEL_KINDS), qrTarget: z.enum(LABEL_QR_TARGETS), gpsrContact: z.string().nullable(), languages: z.array(z.string()), version: z.number().int() }),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeStandard: z.string().nullable(), ppeClass: z.string().nullable(), productType: z.string(), soldUnderOurName: z.boolean() }),
  revisionId: z.string().nullable(),
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), released: z.boolean() }).nullable(),
  markets: z.array(z.object({ market: marketRefSchema.nullable(), sender: senderSchema, blocks: z.boolean(), checks: z.array(ruleCheckSchema) })),
  marking: z.object({
    qr: z
      .object({
        target: z.enum(LABEL_QR_TARGETS),
        kind: z.enum(['BATCH', 'STYLE']),
        address: z.string().nullable(),
        printed: z.string().nullable(),
        recordType: z.string().nullable(),
        recordId: z.string().nullable(),
        reference: z.string().nullable(),
        origin: z.string(),
        live: z.boolean().nullable(),
      })
      .nullable(),
    warnings: z.array(z.object({ reason: z.enum(WARNING_REASONS), key: z.string(), texts: z.array(z.object({ language: z.string(), text: z.string().nullable() })), draft: z.boolean() })),
    glove: z.object({ level: levelSchema, text: z.string(), granted: levelSchema.nullable() }).nullable(),
    gpsr: z.object({ typed: z.string().nullable(), expected: senderSchema, suggested: z.string().nullable() }),
  }),
  asOf: z.string(),
})
export type LabelChecks = z.infer<typeof labelChecksSchema>
export type MarketChecks = LabelChecks['markets'][number]
export type LabelWarning = LabelChecks['marking']['warnings'][number]

/** The label's marking checks: per market asked, else every switched-on market (the API's choice of style and revision). */
export function readLabelChecks(api: ApiClient, templateId: string, query: { styleId?: string | null; styleRevisionId?: string | null; marketCode?: string | null } = {}, signal?: AbortSignal): Promise<LabelChecks> {
  return api
    .get(`/compliance/label-rules/templates/${enc(templateId)}`, {
      query: { styleId: query.styleId ?? undefined, styleRevisionId: query.styleRevisionId ?? undefined, marketCode: query.marketCode ?? undefined },
      schema: z.object({ checks: labelChecksSchema }),
      signal,
    })
    .then((answer) => answer.checks)
}

export interface MarkingBody {
  kind?: (typeof LABEL_KINDS)[number]
  gpsrContact?: string | null
  qrTarget?: (typeof LABEL_QR_TARGETS)[number]
}

/** A draft label's kind, GPSR contact and QR target (409 out of DRAFT or on a stale version). */
export function saveMarking(api: ApiClient, template: Pick<LabelDetail, 'id' | 'version'>, body: MarkingBody): Promise<LabelDetail> {
  return api
    .request('PUT', `/compliance/label-rules/templates/${enc(template.id)}/marking`, { body: { ...body, version: template.version }, schema: z.object({ template: detailSchema }), ...key() })
    .then((answer) => answer.template)
}

// ---- the textile, leather and origin checks (B-W2b-208) ---------------------------------------------------------------

const textileFindingSchema = z.object({ path: z.string(), message: z.string(), severity: z.enum(['FAIL', 'WARN']) })
export const TEXTILE_OUTCOMES = ['PASS', 'FAIL', 'WARN', 'UNKNOWN', 'NOT_APPLICABLE', 'OFF'] as const

const partSchema = z.object({
  component: z.string(),
  part: z.string(),
  words: z.object({ en: z.string(), it: z.string() }),
  fibres: z.array(z.object({ fibre: z.string(), annex: z.boolean(), percent: z.string(), names: z.record(z.string(), z.string()) })).nullable(),
  basis: z.enum(['ONE_COMPOSITION', 'BY_WEIGHT']).nullable(),
  materials: z.array(z.string()),
})
export type ComputedPart = z.infer<typeof partSchema>

export const textileChecksSchema = z.object({
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), originCountry: z.string().nullable(), netMassKg: z.string().nullable() }),
  revision: z.object({ id: z.string(), revision: z.number().int(), status: z.string() }),
  size: z.string().nullable(),
  label: z.object({ id: z.string(), code: z.string(), revision: z.number().int(), status: z.string(), languages: z.array(z.string()) }).nullable(),
  composition: z.array(z.object({ colourways: z.array(z.string()), parts: z.array(partSchema), findings: z.array(textileFindingSchema) })),
  textileShare: z.array(
    z.object({
      colourways: z.array(z.string()),
      pct: z.string().nullable(),
      applies: z.boolean().nullable(),
      basis: z.enum(['NET_MASS', 'BOM']).nullable(),
      missing: z.array(z.object({ seq: z.number().int(), code: z.string(), why: z.string() })),
    }),
  ),
  results: z.array(z.object({ key: z.enum(CHECK_KEYS), title: z.string(), on: z.boolean(), switchable: z.boolean(), outcome: z.enum(TEXTILE_OUTCOMES), words: z.string(), law: z.array(lawSchema), findings: z.array(textileFindingSchema) })),
  asOf: z.string(),
})
export type TextileChecks = z.infer<typeof textileChecksSchema>
export type TextileResult = TextileChecks['results'][number]

/** A style revision's textile checks (the revision asked, else RELEASED, else the newest draft) in the base size. */
export function readTextileChecks(api: ApiClient, styleId: string, query: { revisionId?: string | null } = {}, signal?: AbortSignal): Promise<TextileChecks> {
  return api
    .get(`/compliance/textile-rules/styles/${enc(styleId)}`, { query: { revisionId: query.revisionId ?? undefined }, schema: z.object({ checks: textileChecksSchema }), signal })
    .then((answer) => answer.checks)
}

// ---- artwork proofs and their approval (B-W2b-259) --------------------------------------------------------------------

const person = z.object({ id: z.string(), name: z.string() }).nullable()
export const ARTWORK_STATUSES = ['DRAFT', 'APPROVED', 'RETIRED'] as const

export const artworkSchema = z.object({
  label: z.object({ id: z.string(), code: z.string(), revision: z.number().int(), name: z.string(), status: z.string(), kind: z.string(), companyId: z.string().nullable(), styleId: z.string().nullable() }),
  versions: z.array(
    z.object({
      id: z.string(),
      versionNo: z.number().int(),
      status: z.enum(ARTWORK_STATUSES),
      file: z.object({ id: z.string(), name: z.string(), contentType: z.string(), status: z.string() }).nullable(),
      author: person,
      byYou: z.boolean(),
      approvedAt: z.string().nullable(),
      approvedBy: person,
      retiredAt: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: z.string(),
      version: z.number().int(),
      approveHeld: z.string().nullable(),
    }),
  ),
  approvedId: z.string().nullable(),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), firstPrintAt: z.string().nullable(), artwork: z.object({ id: z.string(), versionNo: z.number().int() }).nullable() })),
  mayManage: z.boolean(),
  mayApprove: z.boolean(),
  asOf: z.string(),
})
export type Artwork = z.infer<typeof artworkSchema>
export type ArtworkVersion = Artwork['versions'][number]
const oneArtwork = z.object({ artwork: artworkSchema })

export function readArtwork(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<Artwork> {
  return api.get(`/compliance/label-artwork/templates/${enc(templateId)}`, { schema: oneArtwork, signal }).then((answer) => answer.artwork)
}

export const waitingSchema = z.object({ waiting: z.array(z.object({ templateId: z.string(), artworkId: z.string(), versionNo: z.number().int(), byYou: z.boolean(), createdAt: z.string() })), asOf: z.string() })
export type Waiting = z.infer<typeof waitingSchema>

/** The DRAFT proofs waiting for a second person, of the labels the reader sees (this step's read). */
export function readWaitingArtwork(api: ApiClient, signal?: AbortSignal): Promise<Waiting> {
  return api.get('/compliance/label-artwork/waiting', { schema: z.object({ artwork: waitingSchema }), signal }).then((answer) => answer.artwork)
}

export function addArtwork(api: ApiClient, templateId: string, body: { fileId: string; note: string | null }): Promise<Artwork> {
  return api.post(`/compliance/label-artwork/templates/${enc(templateId)}/versions`, { body, schema: oneArtwork, ...key() }).then((answer) => answer.artwork)
}

export function approveArtwork(api: ApiClient, version: Pick<ArtworkVersion, 'id' | 'version'>, reason: string): Promise<Artwork> {
  return api
    .post(`/compliance/label-artwork/versions/${enc(version.id)}/approve`, { body: { version: version.version, ...(reason.trim() ? { reason: reason.trim() } : {}) }, schema: oneArtwork, ...key() })
    .then((answer) => answer.artwork)
}

export function retireArtwork(api: ApiClient, version: Pick<ArtworkVersion, 'id' | 'version'>, reason: string): Promise<Artwork> {
  return api
    .post(`/compliance/label-artwork/versions/${enc(version.id)}/retire`, { body: { version: version.version, ...(reason.trim() ? { reason: reason.trim() } : {}) }, schema: oneArtwork, ...key() })
    .then((answer) => answer.artwork)
}

export function removeArtwork(api: ApiClient, version: Pick<ArtworkVersion, 'id' | 'version'>): Promise<Artwork> {
  return api.request('DELETE', `/compliance/label-artwork/versions/${enc(version.id)}`, { query: { version: version.version }, schema: oneArtwork, ...key() }).then((answer) => answer.artwork)
}

/** The proof's file: announced as a file of the label template (kind DOCUMENT), sent to the store, then completed. */
export async function uploadProof(api: ApiClient, template: { id: string; companyId: string | null }, file: { name: string; contentType: string; bytes: ArrayBuffer }): Promise<string> {
  const announced = await requestUpload(api, {
    companyId: template.companyId,
    record: { type: 'LabelTemplate', id: template.id },
    kind: 'DOCUMENT',
    name: file.name,
    contentType: file.contentType || 'application/pdf',
    sizeBytes: file.bytes.byteLength,
    sha256: await sha256Hex(file.bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(announced.upload, file.bytes)
  const done = await completeUpload(api, announced.file.id)
  return done.file.id
}

/** A kept proof's bytes (read once: the store's address lives 60 seconds). */
export async function proofBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { download } = await downloadLink(api, fileId)
  return readFromStore(download)
}

// ---- the phrase library and the markets (B-W2b-249) -------------------------------------------------------------------

const cellSchema = z.object({
  language: z.string(),
  state: z.enum(CELL_STATES),
  approved: z.object({ id: z.string(), text: z.string(), revision: z.number().int() }).nullable(),
  draft: z.object({ id: z.string(), text: z.string(), revision: z.number().int(), proposedBy: person, version: z.number().int() }).nullable(),
})
export const phraseSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(PHRASE_KINDS),
  sourceLanguage: z.string(),
  sourceText: z.string(),
  revision: z.number().int(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  cells: z.array(cellSchema),
})
export type Phrase = z.infer<typeof phraseSchema>
export type PhraseCell = Phrase['cells'][number]

export const phrasesSchema = z.object({ phrases: z.array(phraseSchema), languages: z.array(z.string()), asOf: z.string(), mayManage: z.boolean(), mayApprove: z.boolean() })
export type Phrases = z.infer<typeof phrasesSchema>

/** The ACTIVE phrases with one cell per language asked. */
export function readPhrases(api: ApiClient, languages: readonly string[], signal?: AbortSignal): Promise<Phrases> {
  return api.get('/compliance/rules/phrases', { query: { status: 'ACTIVE', languages: languages.length > 0 ? languages.join(',') : undefined }, schema: phrasesSchema, signal })
}

export const textsSchema = z.object({ texts: z.array(z.object({ key: z.string(), language: z.string(), text: z.string().nullable(), revision: z.number().int() })) })
export type PhraseText = z.infer<typeof textsSchema>['texts'][number]

/** What prints per key and language (null: missing; revision 0: the key is not in the library). At most 100 keys. */
export function readPhraseTexts(api: ApiClient, keys: readonly string[], languages: readonly string[], signal?: AbortSignal): Promise<PhraseText[]> {
  if (keys.length === 0 || languages.length === 0) return Promise.resolve([])
  return api.get('/compliance/rules/phrases/texts', { query: { keys: keys.slice(0, 100).join(','), languages: languages.slice(0, 30).join(',') }, schema: textsSchema, signal }).then((answer) => answer.texts)
}

/** A new proposal (a draft of the language), or new words for the waiting draft (its version). */
export function proposeTranslation(api: ApiClient, phraseKey: string, body: { language: string; text: string; version?: number }): Promise<Phrase> {
  return api.post(`/compliance/rules/phrases/${enc(phraseKey)}/translations`, { body, schema: z.object({ phrase: phraseSchema }), ...key() }).then((answer) => answer.phrase)
}

/** A second person approves a waiting translation. */
export function approveTranslation(api: ApiClient, phraseKey: string, draft: { id: string; version: number }): Promise<Phrase> {
  return api
    .post(`/compliance/rules/phrases/${enc(phraseKey)}/translations/${enc(draft.id)}/approve`, { body: { version: draft.version }, schema: z.object({ phrase: phraseSchema }), ...key() })
    .then((answer) => answer.phrase)
}

export const marketSchema = z.object({ code: z.string(), name: z.string(), companyId: z.string().nullable(), labelLanguages: z.array(z.string()), switchedOn: z.boolean(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
export type Market = z.infer<typeof marketSchema>
export const matrixSchema = z.object({
  languages: z.array(z.string()),
  markets: z.array(z.object({ code: z.string(), name: z.string(), switchedOn: z.boolean(), needs: z.array(z.object({ language: z.string(), documents: z.array(z.enum(['LABEL', 'DOC', 'USER_INFO'])) })) })),
})
export type Matrix = z.infer<typeof matrixSchema>

/** The ACTIVE markets the reader's companies reach, with the LanguageMatrix. */
export function readMarkets(api: ApiClient, signal?: AbortSignal): Promise<{ markets: Market[]; matrix: Matrix }> {
  return api.get('/compliance/rules/markets', { query: { status: 'ACTIVE' }, schema: z.object({ markets: z.array(marketSchema), matrix: matrixSchema }), signal })
}
