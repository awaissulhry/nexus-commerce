import { z } from 'zod'
import { CHANGE_KINDS, CHANGE_STATUSES, IMPACTS, REGULATION_KINDS, REGULATION_STATUSES, type RegulationKind, type RegulationStatus, type StandardChangeImpact, type StandardChangeKind } from '@nexus/factory-domain/compliance/register-of-rules/rules'
import { DOCUMENTS } from '@nexus/factory-domain/compliance/markets/rules'
import { OPERATOR_ROLES, SCOPE_LEVELS, type OperatorRole } from '@nexus/factory-domain/compliance/operators/rules'
import { CELL_STATES, PHRASE_KINDS, TRANSLATION_STATUSES, type PhraseKind } from '@nexus/factory-domain/compliance/phrases/rules'
import { COMPLIANCE_GATES, FIX_PLACES, PRODUCT_TYPES, REQUIREMENT_KINDS, WHO, type ComplianceGate, type ProductType, type RequirementKind } from '@nexus/factory-domain/compliance/requirements/rules'
import { PPE_CATEGORIES, type PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { EVIDENCE_RULES, SETTING_SOURCES, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Compliance › Settings › Rules & markets (SCR-262; B-W2b-265 on the API of B-W2b-249 and B-W2b-254, and W1's Cr VI
 * evidence rule of B-W1-34): the chromium VI rule (GET/PUT /quality/settings), the gate matrix and its requirements
 * (/compliance/requirements), the register of laws and standards and its change watch (/compliance/rules/standards,
 * /compliance/rules/standard-changes), the markets and their LanguageMatrix (/compliance/rules/markets), the phrase library
 * (/compliance/rules/phrases) and the economic operators (/compliance/rules/operators), plus the pickers (materials that need a
 * Cr VI test, styles, brands, parties). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are
 * dropped). The API's English is never shown: the screens say their own words from the codes. No money, no person's figure.
 */

const seg = (value: string) => encodeURIComponent(value)
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const words = z.record(z.string(), z.string())

// ---- the chromium VI evidence rule (W1, B-W1-34) ---------------------------------------------------------------------------

export const crViSchema = z.object({
  companyId: z.string().nullable(),
  crViEvidenceRule: z.enum(EVIDENCE_RULES),
  source: z.enum(SETTING_SOURCES),
  default: z.enum(EVIDENCE_RULES),
  legalLimitMgKg: z.string(),
  law: z.string(),
  version: z.number(),
  updatedAt: z.string().nullable(),
})
export type CrViSettings = z.infer<typeof crViSchema>

/** GET /quality/settings: the rule in force for the company (or every company's, `companyId` null). */
export async function readCrVi(api: ApiClient, companyId: string | null): Promise<CrViSettings> {
  const answer = await api.get('/quality/settings', { query: companyId ? { companyId } : {}, schema: z.object({ settings: crViSchema }) })
  return answer.settings
}

/** PUT /quality/settings: loosening sends the reason and asks the step-up (the caller's guard). */
export async function saveCrVi(api: ApiClient, body: { companyId: string | null; rule: EvidenceRule; version: number; reason: string | null }, key: string): Promise<CrViSettings> {
  const answer = await api.request('PUT', '/quality/settings', {
    body: { companyId: body.companyId, crViEvidenceRule: body.rule, version: body.version, ...(body.reason ? { reason: body.reason } : {}) },
    schema: z.object({ settings: crViSchema }),
    idempotencyKey: key,
  })
  return answer.settings
}

const materialSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), requiresCrViTest: z.boolean(), crViLimitMgKg: z.string().nullable() })
export type CrViMaterial = z.infer<typeof materialSchema>

/** GET /product/materials?requiresCrViTest=true: the materials that need a Cr VI test, each with its own (lower) limit. */
export async function readCrViMaterials(api: ApiClient): Promise<{ materials: CrViMaterial[]; count: number }> {
  const answer = await api.get('/product/materials', { query: { requiresCrViTest: 'true', status: 'ACTIVE', limit: 200 }, schema: z.object({ materials: z.array(materialSchema), count: z.number() }) })
  return { materials: answer.materials, count: answer.count }
}

// ---- requirements and the gate matrix (B-W2b-254) --------------------------------------------------------------------------

export const requirementSchema = z.object({
  id: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: words,
  companyId: z.string().nullable(),
  kind: z.enum(REQUIREMENT_KINDS),
  checkKey: z.string().nullable(),
  check: z.string(),
  operatorRole: z.enum(OPERATOR_ROLES).nullable(),
  productTypes: z.array(z.enum(PRODUCT_TYPES)),
  productTypeProfileId: z.string().nullable(),
  ppeCategories: z.array(z.enum(PPE_CATEGORIES)),
  marketCode: z.string().nullable(),
  blocks: z.array(z.enum(COMPLIANCE_GATES)),
  lockedBlocks: z.array(z.enum(COMPLIANCE_GATES)),
  overrideRoleKeys: z.array(z.string()),
  overrideMaxDays: z.number(),
  legalReference: z.string(),
  regulation: z.object({ id: z.string(), label: z.string(), link: z.string().nullable() }).nullable(),
  explanationI18n: words,
  appliesFrom: z.string().nullable(),
  appliesUntil: z.string().nullable(),
  seq: z.number(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: z.string().nullable(),
  switchedBy: person,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  who: z.enum(WHO),
  fixPlace: z.enum(FIX_PLACES),
  version: z.number(),
  updatedAt: z.string().nullable(),
  builtIn: z.boolean(),
})
export type Requirement = z.infer<typeof requirementSchema>

const matrixRowSchema = z.object({
  requirement: requirementSchema,
  cells: z.array(z.object({ gate: z.enum(COMPLIANCE_GATES), blocks: z.boolean(), locked: z.boolean() })),
  overrideRoleKeys: z.array(z.string()),
  overrideMaxDays: z.number(),
  mayLoosen: z.boolean(),
})
export type GateRow = z.infer<typeof matrixRowSchema>
const gateMatrixSchema = z.object({ gates: z.array(z.enum(COMPLIANCE_GATES)), rows: z.array(matrixRowSchema), asOf: z.string(), mayManage: z.boolean() })
export type GateMatrix = z.infer<typeof gateMatrixSchema>

/** GET /compliance/requirements/gates — the matrix: requirement × place, the padlocks, who may override and how long. */
export function readGates(api: ApiClient): Promise<GateMatrix> {
  return api.get('/compliance/requirements/gates', { schema: gateMatrixSchema })
}

/** GET /compliance/requirements?status=ALL — every requirement (the suggestions skip the check keys already there). */
export function readRequirements(api: ApiClient): Promise<{ requirements: Requirement[]; mayManage: boolean }> {
  return api.get('/compliance/requirements', { query: { status: 'ALL' }, schema: z.object({ requirements: z.array(requirementSchema), mayManage: z.boolean() }) })
}

export interface RequirementBody {
  readonly code: string
  readonly kind: RequirementKind
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
  readonly checkKey: string | null
  readonly operatorRole: OperatorRole | null
  readonly productTypes: readonly ProductType[]
  readonly ppeCategories: readonly PpeCategory[]
  readonly marketCode: string | null
  readonly blocks: readonly ComplianceGate[]
  readonly overrideRoleKeys: readonly string[]
  readonly overrideMaxDays: number
  readonly legalReference: string
  readonly explanationI18n: Readonly<Record<string, string>> | null
  readonly seq: number
  readonly switchedOn: boolean
  readonly offReason: string | null
}

/** POST /compliance/requirements — a new requirement (tightening: no step-up); OFF names its reason. */
export async function createRequirement(api: ApiClient, body: RequirementBody, key: string): Promise<Requirement> {
  const answer = await api.post('/compliance/requirements', {
    body: {
      code: body.code,
      kind: body.kind,
      name: body.name,
      ...(body.nameI18n ? { nameI18n: body.nameI18n } : {}),
      checkKey: body.checkKey,
      operatorRole: body.operatorRole,
      productTypes: body.productTypes,
      ppeCategories: body.ppeCategories,
      marketCode: body.marketCode,
      blocks: body.blocks,
      overrideRoleKeys: body.overrideRoleKeys,
      overrideMaxDays: body.overrideMaxDays,
      legalReference: body.legalReference,
      ...(body.explanationI18n ? { explanationI18n: body.explanationI18n } : {}),
      seq: body.seq,
      switchedOn: body.switchedOn,
      ...(body.switchedOn ? {} : { offReason: body.offReason ?? '' }),
    },
    schema: z.object({ requirement: requirementSchema }),
    idempotencyKey: key,
  })
  return answer.requirement
}

/** PATCH /compliance/requirements/:code — gates, who may override and how long; a looser change answers 403 `stepUp` first. */
export async function editRequirement(api: ApiClient, code: string, body: { version: number; blocks?: ComplianceGate[]; overrideRoleKeys?: string[]; overrideMaxDays?: number }, key: string): Promise<{ requirement: Requirement; loosened: { code: string }[] }> {
  return api.request('PATCH', `/compliance/requirements/${seg(code)}`, { body, schema: z.object({ requirement: requirementSchema, loosened: z.array(z.object({ code: z.string() })) }), idempotencyKey: key })
}

/** PUT /compliance/requirements/:code/switch — ON, or OFF with the reason (OFF loosens: step-up). */
export async function switchRequirement(api: ApiClient, code: string, body: { version: number; on: boolean; reason: string | null }, key: string): Promise<Requirement> {
  const answer = await api.request('PUT', `/compliance/requirements/${seg(code)}/switch`, {
    body: { version: body.version, on: body.on, ...(body.reason ? { reason: body.reason } : {}) },
    schema: z.object({ requirement: requirementSchema }),
    idempotencyKey: key,
  })
  return answer.requirement
}

/** POST /compliance/requirements/w1 — W1's certificate requirement written as its row now. */
export async function writeW1(api: ApiClient, key: string): Promise<{ requirement: Requirement; created: boolean }> {
  return api.post('/compliance/requirements/w1', { schema: z.object({ requirement: requirementSchema, created: z.boolean() }), idempotencyKey: key })
}

// ---- the register of laws and standards, and the change watch (B-W2b-249) --------------------------------------------------

export const entrySchema = z.object({
  id: z.string(),
  code: z.string(),
  edition: z.string().nullable(),
  label: z.string(),
  title: z.string(),
  titleI18n: words,
  kind: z.enum(REGULATION_KINDS),
  status: z.enum(REGULATION_STATUSES),
  ojReference: z.string().nullable(),
  ojDate: z.string().nullable(),
  supersededBy: z.object({ id: z.string(), label: z.string() }).nullable(),
  link: z.string().nullable(),
  note: z.string().nullable(),
  usedBy: z.number(),
  openChanges: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type Entry = z.infer<typeof entrySchema>

export const changeSchema = z.object({
  id: z.string(),
  standard: z.object({ id: z.string(), label: z.string(), status: z.enum(REGULATION_STATUSES) }),
  newStandard: z.object({ id: z.string(), label: z.string() }).nullable(),
  kind: z.enum(CHANGE_KINDS),
  whatChanged: z.string(),
  sourceReference: z.string().nullable(),
  noticedAt: z.string(),
  noticedBy: person,
  transitionEndsOn: z.string().nullable(),
  transition: z.enum(['NONE', 'RUNNING', 'ENDS_SOON', 'ENDED']),
  status: z.enum(CHANGE_STATUSES),
  impact: z.enum(IMPACTS).nullable(),
  assessment: z.string().nullable(),
  assessedAt: z.string().nullable(),
  assessedBy: person,
  closedAt: z.string().nullable(),
  closedBy: person,
  certificates: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), validTo: z.string() })),
  styles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), certificateIds: z.array(z.string()) })),
  reviews: z.array(z.object({ id: z.string(), status: z.string(), certificateId: z.string(), styleId: z.string(), styleCode: z.string(), revision: z.number() })),
  task: z.object({ id: z.string(), title: z.string(), status: z.string() }).nullable(),
  version: z.number(),
  createdAt: z.string(),
})
export type Change = z.infer<typeof changeSchema>

const entriesSchema = z.object({ entries: z.array(entrySchema), asOf: z.string(), mayManage: z.boolean() })
export type EntriesAnswer = z.infer<typeof entriesSchema>

/** GET /compliance/rules/standards — the register (its kind, status and words filters are the API's). */
export function readEntries(api: ApiClient, query: { kind?: RegulationKind | null; status?: RegulationStatus | null; q?: string }): Promise<EntriesAnswer> {
  return api.get('/compliance/rules/standards', { query: { kind: query.kind ?? undefined, status: query.status ?? undefined, q: query.q?.trim() || undefined }, schema: entriesSchema })
}

const certificateRef = z.object({ id: z.string(), number: z.string(), standard: z.string(), status: z.string(), validTo: z.string(), styles: z.number() })
const entryRecordSchema = z.object({ entry: entrySchema, certificates: z.array(certificateRef), supersedes: z.array(z.object({ id: z.string(), label: z.string() })), changes: z.array(changeSchema), asOf: z.string() })
export type EntryRecord = z.infer<typeof entryRecordSchema>

/** GET /compliance/rules/standards/:id — the entry, the certificates that cite it, what it supersedes and its changes. */
export function readEntry(api: ApiClient, id: string): Promise<EntryRecord> {
  return api.get(`/compliance/rules/standards/${seg(id)}`, { schema: entryRecordSchema })
}

export interface EntryBody {
  readonly code: string
  readonly edition: string | null
  readonly title: string
  readonly kind: RegulationKind
  readonly ojReference: string | null
  readonly ojDate: string | null
  readonly link: string | null
  readonly status: RegulationStatus
}

/** POST /compliance/rules/standards — one entry per code and edition. */
export async function createEntry(api: ApiClient, body: EntryBody, key: string): Promise<Entry> {
  const answer = await api.post('/compliance/rules/standards', { body, schema: z.object({ entry: entrySchema }), idempotencyKey: key })
  return answer.entry
}

export interface EntryEdit {
  readonly version: number
  readonly title?: string
  readonly ojReference?: string | null
  readonly link?: string | null
  readonly note?: string | null
  readonly status?: RegulationStatus
  readonly supersededById?: string | null
  readonly reason?: string
  readonly transitionEndsOn?: string | null
}

/** PATCH /compliance/rules/standards/:id — a cell, or a move to SUPERSEDED / WITHDRAWN that raises a change (its words). */
export function editEntry(api: ApiClient, id: string, body: EntryEdit, key: string): Promise<{ entry: Entry; raised: Change | null }> {
  return api.request('PATCH', `/compliance/rules/standards/${seg(id)}`, { body, schema: z.object({ entry: entrySchema, raised: changeSchema.nullable() }), idempotencyKey: key })
}

/** DELETE /compliance/rules/standards/:id — a row typed by mistake (refused in words while anything names it). */
export function deleteEntry(api: ApiClient, id: string, version: number, key: string): Promise<{ deleted: string }> {
  return api.request('DELETE', `/compliance/rules/standards/${seg(id)}`, { query: { version }, schema: z.object({ deleted: z.string() }), idempotencyKey: key })
}

/** POST /compliance/rules/standards/:id/changes — a change a person noticed. */
export async function recordChange(api: ApiClient, id: string, body: { kind: StandardChangeKind; whatChanged: string; sourceReference: string | null; transitionEndsOn: string | null; newStandardId: string | null }, key: string): Promise<Change> {
  const answer = await api.post(`/compliance/rules/standards/${seg(id)}/changes`, { body, schema: z.object({ change: changeSchema }), idempotencyKey: key })
  return answer.change
}

/** GET /compliance/rules/standard-changes — the watch: open first (transition ending soonest), then closed. */
export async function readChanges(api: ApiClient, open: boolean): Promise<Change[]> {
  const answer = await api.get('/compliance/rules/standard-changes', { query: open ? { open: 'true' } : {}, schema: z.object({ changes: z.array(changeSchema) }) })
  return answer.changes
}

/** GET /compliance/rules/standard-changes/:id */
export async function readChange(api: ApiClient, id: string): Promise<Change> {
  const answer = await api.get(`/compliance/rules/standard-changes/${seg(id)}`, { schema: z.object({ change: changeSchema }) })
  return answer.change
}

const changePath = (id: string, verb: string) => `/compliance/rules/standard-changes/${seg(id)}/${verb}`
const oneChange = z.object({ change: changeSchema })

/** POST …/assess — impact and assessment, filed once; REVIEW / RETEST open W2a's type-change reviews for the named certificates. */
export async function assessChange(api: ApiClient, id: string, body: { version: number; impact: StandardChangeImpact; assessment: string; reviewCertificateIds: string[] }, key: string): Promise<Change> {
  return (await api.post(changePath(id, 'assess'), { body, schema: oneChange, idempotencyKey: key })).change
}

/** POST …/task — the impact task with one checklist item per affected style ("Open impact task"). */
export async function openImpactTask(api: ApiClient, id: string, body: { version: number; language: 'it' | 'en' }, key: string): Promise<Change> {
  return (await api.post(changePath(id, 'task'), { body, schema: oneChange, idempotencyKey: key })).change
}

/** POST …/close — ASSESSED → CLOSED (frozen). */
export async function closeChange(api: ApiClient, id: string, version: number, key: string): Promise<Change> {
  return (await api.post(changePath(id, 'close'), { body: { version }, schema: oneChange, idempotencyKey: key })).change
}

// ---- markets and the LanguageMatrix (B-W2b-249) ----------------------------------------------------------------------------

export const marketSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  nameI18n: words,
  companyId: z.string().nullable(),
  labelLanguages: z.array(z.string()),
  docLanguages: z.array(z.string()),
  userInfoLanguages: z.array(z.string()),
  markings: z.array(z.string()),
  nationalRules: z.array(z.object({ key: z.string(), words, law: z.string().nullable(), href: z.string().nullable() })),
  importerNeeded: z.boolean(),
  gpsrContactNeeded: z.boolean(),
  seq: z.number(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: z.string().nullable(),
  switchedBy: person,
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
  updatedAt: z.string(),
})
export type Market = z.infer<typeof marketSchema>
export type NationalRule = Market['nationalRules'][number]

export const matrixSchema = z.object({
  languages: z.array(z.string()),
  markets: z.array(z.object({ code: z.string(), name: z.string(), switchedOn: z.boolean(), needs: z.array(z.object({ language: z.string(), documents: z.array(z.enum(DOCUMENTS)) })) })),
})
export type LanguageMatrixData = z.infer<typeof matrixSchema>

const marketsSchema = z.object({ markets: z.array(marketSchema), matrix: matrixSchema, asOf: z.string(), mayManage: z.boolean() })
export type MarketsAnswer = z.infer<typeof marketsSchema>

/** GET /compliance/rules/markets?status= — the markets with the matrix of what each needs. */
export function readMarkets(api: ApiClient, status: 'ACTIVE' | 'ALL' = 'ALL'): Promise<MarketsAnswer> {
  return api.get('/compliance/rules/markets', { query: { status }, schema: marketsSchema })
}

const coverageSchema = z.object({ language: z.string(), inLibrary: z.number(), ready: z.number(), proposed: z.number(), stale: z.number(), missing: z.number() })
export type Coverage = z.infer<typeof coverageSchema>
const languagesSchema = z.object({ matrix: matrixSchema, phrases: z.array(coverageSchema), asOf: z.string() })
export type LanguagesAnswer = z.infer<typeof languagesSchema>

/** GET /compliance/rules/markets/languages — the matrix and, per language the switched-on markets need, the phrases ready. */
export function readLanguages(api: ApiClient): Promise<LanguagesAnswer> {
  return api.get('/compliance/rules/markets/languages', { schema: languagesSchema })
}

export interface MarketBody {
  readonly code: string
  readonly name: string
  readonly labelLanguages: readonly string[]
  readonly docLanguages: readonly string[]
  readonly userInfoLanguages: readonly string[]
  readonly markings: readonly string[]
  readonly importerNeeded: boolean
  readonly gpsrContactNeeded: boolean
  readonly switchedOn: boolean
  readonly offReason: string | null
}

/** POST /compliance/rules/markets — ON by default; OFF names its reason. */
export async function createMarket(api: ApiClient, body: MarketBody, key: string): Promise<Market> {
  const { offReason, ...rest } = body
  const answer = await api.post('/compliance/rules/markets', { body: { ...rest, ...(body.switchedOn ? {} : { offReason: offReason ?? '' }) }, schema: z.object({ market: marketSchema }), idempotencyKey: key })
  return answer.market
}

export interface MarketEdit {
  readonly version: number
  readonly name?: string
  readonly labelLanguages?: readonly string[]
  readonly docLanguages?: readonly string[]
  readonly userInfoLanguages?: readonly string[]
  readonly markings?: readonly string[]
  readonly nationalRules?: readonly { key: string; words: Record<string, string>; law?: string; href?: string }[]
  readonly importerNeeded?: boolean
  readonly gpsrContactNeeded?: boolean
  readonly note?: string | null
  readonly status?: 'ACTIVE' | 'ARCHIVED'
}

/** PATCH /compliance/rules/markets/:code — one cell (autosaved) or the market's dialog; the code and company stay. */
export async function editMarket(api: ApiClient, code: string, body: MarketEdit, key: string): Promise<Market> {
  const answer = await api.request('PATCH', `/compliance/rules/markets/${seg(code)}`, { body, schema: z.object({ market: marketSchema }), idempotencyKey: key })
  return answer.market
}

/** PUT /compliance/rules/markets/:code/switch — ON, or OFF with the reason in words. */
export async function switchMarket(api: ApiClient, code: string, body: { version: number; on: boolean; reason: string | null }, key: string): Promise<Market> {
  const answer = await api.request('PUT', `/compliance/rules/markets/${seg(code)}/switch`, {
    body: { version: body.version, on: body.on, ...(body.reason ? { reason: body.reason } : {}) },
    schema: z.object({ market: marketSchema }),
    idempotencyKey: key,
  })
  return answer.market
}

// ---- phrases and translations (B-W2b-249) ----------------------------------------------------------------------------------

const cellSchema = z.object({
  language: z.string(),
  state: z.enum(CELL_STATES),
  approved: z.object({ id: z.string(), text: z.string(), revision: z.number(), sourceRevision: z.number(), approvedAt: z.string().nullable(), approvedBy: person }).nullable(),
  draft: z.object({ id: z.string(), text: z.string(), revision: z.number(), sourceRevision: z.number(), proposedBy: person, version: z.number() }).nullable(),
})
export type PhraseCell = z.infer<typeof cellSchema>

export const phraseSchema = z.object({
  id: z.string(),
  key: z.string(),
  kind: z.enum(PHRASE_KINDS),
  companyId: z.string().nullable(),
  sourceLanguage: z.string(),
  sourceText: z.string(),
  revision: z.number(),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
  updatedAt: z.string(),
  cells: z.array(cellSchema),
})
export type Phrase = z.infer<typeof phraseSchema>

const phrasesSchema = z.object({ phrases: z.array(phraseSchema), languages: z.array(z.string()), asOf: z.string(), mayManage: z.boolean(), mayApprove: z.boolean() })
export type PhrasesAnswer = z.infer<typeof phrasesSchema>

/** GET /compliance/rules/phrases — one cell per language (default: every language a switched-on market needs). */
export function readPhrases(api: ApiClient, query: { kind?: PhraseKind | null; q?: string }): Promise<PhrasesAnswer> {
  return api.get('/compliance/rules/phrases', { query: { kind: query.kind ?? undefined, q: query.q?.trim() || undefined, status: 'ACTIVE' }, schema: phrasesSchema })
}

const historySchema = z.object({
  id: z.string(),
  language: z.string(),
  revision: z.number(),
  text: z.string(),
  status: z.enum(TRANSLATION_STATUSES),
  sourceRevision: z.number(),
  proposedBy: person,
  proposedAt: z.string(),
  approvedBy: person,
  approvedAt: z.string().nullable(),
})
export type TranslationHistory = z.infer<typeof historySchema>
const phraseRecordSchema = z.object({ phrase: phraseSchema, history: z.array(historySchema) })
export type PhraseRecord = z.infer<typeof phraseRecordSchema>

/** GET /compliance/rules/phrases/:key — the phrase, its cells and every translation it ever had. */
export function readPhrase(api: ApiClient, key: string): Promise<PhraseRecord> {
  return api.get(`/compliance/rules/phrases/${seg(key)}`, { schema: phraseRecordSchema })
}

const onePhrase = z.object({ phrase: phraseSchema })

/** POST /compliance/rules/phrases — key unique in the tenant, Italian source by default. */
export async function createPhrase(api: ApiClient, body: { key: string; kind: PhraseKind; sourceLanguage: string; sourceText: string; note: string | null }, key: string): Promise<Phrase> {
  return (await api.post('/compliance/rules/phrases', { body, schema: onePhrase, idempotencyKey: key })).phrase
}

/** PATCH /compliance/rules/phrases/:key — new source words: the next revision (approved translations go stale). */
export async function editPhrase(api: ApiClient, phraseKey: string, body: { version: number; sourceText?: string; kind?: PhraseKind; note?: string | null; status?: 'ACTIVE' | 'ARCHIVED' }, key: string): Promise<Phrase> {
  return (await api.request('PATCH', `/compliance/rules/phrases/${seg(phraseKey)}`, { body, schema: onePhrase, idempotencyKey: key })).phrase
}

/** POST /compliance/rules/phrases/:key/translations — a new draft, or new words for the waiting draft (its version). */
export async function proposeTranslation(api: ApiClient, phraseKey: string, body: { language: string; text: string; version?: number }, key: string): Promise<Phrase> {
  return (await api.post(`/compliance/rules/phrases/${seg(phraseKey)}/translations`, { body, schema: onePhrase, idempotencyKey: key })).phrase
}

/** POST …/translations/:id/approve — a second person approves (never one's own). */
export async function approveTranslation(api: ApiClient, phraseKey: string, translationId: string, version: number, key: string): Promise<Phrase> {
  return (await api.post(`/compliance/rules/phrases/${seg(phraseKey)}/translations/${seg(translationId)}/approve`, { body: { version }, schema: onePhrase, idempotencyKey: key })).phrase
}

/** DELETE …/translations/:id — a draft only. */
export async function withdrawTranslation(api: ApiClient, phraseKey: string, translationId: string, version: number, key: string): Promise<Phrase> {
  return (await api.request('DELETE', `/compliance/rules/phrases/${seg(phraseKey)}/translations/${seg(translationId)}`, { query: { version }, schema: onePhrase, idempotencyKey: key })).phrase
}

// ---- economic operators (B-W2b-249) ----------------------------------------------------------------------------------------

export const operatorSchema = z.object({
  id: z.string(),
  role: z.enum(OPERATOR_ROLES),
  level: z.enum(SCOPE_LEVELS),
  companyId: z.string().nullable(),
  style: ref.nullable(),
  brand: ref.nullable(),
  marketCode: z.string().nullable(),
  party: ref.nullable(),
  printedName: z.string(),
  printedAddress: z.string(),
  contact: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  validOnDay: z.boolean(),
  note: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type Operator = z.infer<typeof operatorSchema>
const operatorsSchema = z.object({ operators: z.array(operatorSchema), day: z.string(), asOf: z.string(), mayManage: z.boolean() })
export type OperatorsAnswer = z.infer<typeof operatorsSchema>

/** GET /compliance/rules/operators — every row (the role and market filters are the API's; `current` only today's). */
export function readOperators(api: ApiClient, query: { role?: OperatorRole | null; marketCode?: string | null; current?: boolean }): Promise<OperatorsAnswer> {
  return api.get('/compliance/rules/operators', { query: { role: query.role ?? undefined, marketCode: query.marketCode ?? undefined, current: query.current ? 'true' : undefined }, schema: operatorsSchema })
}

export interface OperatorBody {
  readonly role: OperatorRole
  readonly styleId: string | null
  readonly brandPartyId: string | null
  readonly companyId: string | null
  readonly marketCode: string | null
  readonly partyId: string | null
  readonly printedName: string
  readonly printedAddress: string
  readonly contact: string | null
  readonly validFrom: string
  readonly validTo: string | null
  readonly note: string | null
}

/** POST /compliance/rules/operators — style XOR brand XOR default; an overlap on the same scope, market and role is refused. */
export async function createOperator(api: ApiClient, body: OperatorBody, key: string): Promise<Operator> {
  return (await api.post('/compliance/rules/operators', { body, schema: z.object({ operator: operatorSchema }), idempotencyKey: key })).operator
}

/** PATCH /compliance/rules/operators/:id — the printed words, the party and the dates (scope, role and market stay). */
export async function editOperator(api: ApiClient, id: string, body: { version: number; partyId?: string | null; printedName?: string; printedAddress?: string; contact?: string | null; validFrom?: string; validTo?: string | null; note?: string | null }, key: string): Promise<Operator> {
  return (await api.request('PATCH', `/compliance/rules/operators/${seg(id)}`, { body, schema: z.object({ operator: operatorSchema }), idempotencyKey: key })).operator
}

// ---- pickers -----------------------------------------------------------------------------------------------------------------

const styleRow = z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable() })
export type StyleChoice = z.infer<typeof styleRow>

/** GET /product/styles?q= — the styles an operator row may name (product.styles.view). */
export async function searchStyles(api: ApiClient, q: string): Promise<StyleChoice[]> {
  const answer = await api.get('/product/styles', { query: { q: q.trim() || undefined, status: 'OPEN', limit: 50 }, schema: z.object({ styles: z.array(styleRow) }) })
  return answer.styles
}

const partyRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), roles: z.array(z.string()) })
export type PartyChoice = z.infer<typeof partyRow>

/** GET /parties?q=&role= — the parties an operator row may name (parties.view); brands with role BRAND. */
export async function searchParties(api: ApiClient, q: string, role?: string): Promise<PartyChoice[]> {
  const answer = await api.get('/parties', { query: { q: q.trim() || undefined, role, status: 'ACTIVE', limit: 50 }, schema: z.object({ parties: z.array(partyRow) }) })
  return answer.parties
}
