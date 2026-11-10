import { DECLARATION_KINDS } from '@nexus/factory-domain/compliance/substances/rules'
import { ORIGIN_COUNTRY, PROFILE_LIMITS } from '@nexus/factory-domain/compliance/material-profiles/rules'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import type { MaterialEvaluation, ParameterStatus, ProfileRecord, ProfileRow, ProfileState, RuleVerdict } from './api'

/**
 * Material profiles (B-W2b-267; design compliance.tests sec:ts-profiles, the material record's Compliance tab) without React:
 * the view's address (the API's own filters `state`, `kind`, `q`), the tiles, the state's words and tone, what keeps a
 * profile from complete in OUR words from the flags (never the evaluator's English), the innocuousness marks, the rule
 * verdicts grouped, the edit's problems and the CSV. The state is the evaluator's: nothing here sets it. Pure.
 */

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral'
type Words = (key: string, params?: Record<string, string | number>) => string

export const PROFILE_STATES = ['INCOMPLETE', 'COMPLETE', 'BLOCKED', 'NONE'] as const
export type ProfileFilter = (typeof PROFILE_STATES)[number]

export interface ProfilesAddress {
  readonly state: ProfileFilter | null
  readonly kind: string | null
  readonly q: string
}

const KIND = /^[A-Z]{2,20}$/

export function profilesAddressOf(params: { get(name: string): string | null } | null | undefined): ProfilesAddress {
  const state = params?.get('state') ?? ''
  const kind = params?.get('kind') ?? ''
  return { state: (PROFILE_STATES as readonly string[]).includes(state) ? (state as ProfileFilter) : null, kind: KIND.test(kind) ? kind : null, q: params?.get('q') ?? '' }
}

export function profilesAddressText(address: ProfilesAddress): string {
  const search = new URLSearchParams()
  search.set('view', 'profiles')
  if (address.state) search.set('state', address.state)
  if (address.kind) search.set('kind', address.kind)
  if (address.q.trim()) search.set('q', address.q.trim())
  return `?${search.toString()}`
}

/** A tannage code in our words' key (`tannage.CHROME`), or null for a value that is not one of the codes (shown as it is). */
export const tannageKey = (tannage: string | null): string | null => (tannage && (TANNAGES as readonly string[]).includes(tannage) ? `tannage.${tannage}` : null)

export const STATE_TONE: Readonly<Record<ProfileState | 'NONE', Tone>> = { COMPLETE: 'success', INCOMPLETE: 'warning', BLOCKED: 'danger', NONE: 'neutral' }
export const stateOf = (row: Pick<ProfileRow, 'state'>): ProfileState | 'NONE' => row.state ?? 'NONE'

export const PARAMETER_TONE: Readonly<Record<ParameterStatus, Tone>> = { MET: 'success', FILE: 'info', MISSING: 'warning', FAILED: 'danger' }

export interface ProfilesCan {
  readonly view: boolean
  /** Confirmations, origin, note, Evaluate again (compliance.substances.manage). */
  readonly edit: boolean
  /** Request declarations (compliance.supplierDeclarations.manage). */
  readonly ask: boolean
  /** The material's record (product.materials.view). */
  readonly materials: boolean
}

export function profilesCan(permissions: readonly string[]): ProfilesCan {
  const held = new Set(permissions)
  return {
    view: held.has('compliance.certificates.view'),
    edit: held.has('compliance.substances.manage'),
    ask: held.has('compliance.supplierDeclarations.manage'),
    materials: held.has('product.materials.view'),
  }
}

/** The material's record, its Compliance tab (products.materials, SCR-048). */
export const materialHref = (prefix: string, itemId: string): string => `${prefix}/products/materials/${encodeURIComponent(itemId)}?tab=compliance#material-profile`

/**
 * What keeps a profile from complete, as our words' keys, from the flags: composition and tannage not confirmed,
 * declarations missing (asked or not), tests needed, innocuousness missing or failed. The evaluator's own sentence stays
 * the API's (read, never shown).
 */
export function gapKeys(row: ProfileRow): { key: string; params?: Record<string, string | number> }[] {
  const gaps: { key: string; params?: Record<string, string | number> }[] = []
  if (!row.compositionConfirmed) gaps.push({ key: 'gap.composition' })
  if (row.tannageConfirmed === false) gaps.push({ key: 'gap.tannage' })
  const notAsked = row.declarations.missing.filter((kind) => !row.declarations.asked.includes(kind))
  const asked = row.declarations.missing.filter((kind) => row.declarations.asked.includes(kind))
  if (notAsked.length > 0) gaps.push({ key: 'gap.declarations', params: { count: notAsked.length } })
  if (asked.length > 0) gaps.push({ key: 'gap.asked', params: { count: asked.length } })
  if (row.innocuousness.required) {
    const failed = row.innocuousness.parameters.filter((entry) => entry.status === 'FAILED').length
    const missing = row.innocuousness.parameters.filter((entry) => entry.status === 'MISSING').length
    if (failed > 0) gaps.push({ key: 'gap.innocuousFailed', params: { count: failed } })
    if (missing > 0) gaps.push({ key: 'gap.innocuousMissing', params: { count: missing } })
  }
  if (row.state === null) gaps.push({ key: 'gap.never' })
  return gaps
}

/** The kinds a Request declarations would ask of this material (missing and not asked yet), in the catalogue's order. */
export const toAsk = (row: Pick<ProfileRow, 'declarations'>) => DECLARATION_KINDS.filter((kind) => row.declarations.missing.includes(kind) && !row.declarations.asked.includes(kind))

/** The verdicts in the order a person reads them: failed, missing, met, then the rules that do not apply. */
export function verdictGroups(evaluation: MaterialEvaluation | null): { failed: RuleVerdict[]; missing: RuleVerdict[]; met: RuleVerdict[]; notApplicable: RuleVerdict[] } {
  const rules = evaluation?.rules ?? []
  return {
    failed: rules.filter((rule) => rule.status === 'FAILED'),
    missing: rules.filter((rule) => rule.status === 'MISSING'),
    met: rules.filter((rule) => rule.status === 'MET'),
    notApplicable: rules.filter((rule) => rule.status === 'NOT_APPLICABLE'),
  }
}

export const VERDICT_TONE: Readonly<Record<RuleVerdict['status'], Tone>> = { MET: 'success', FAILED: 'danger', MISSING: 'warning', NOT_APPLICABLE: 'neutral' }

/** Why a rule does not apply, as a words key (the evaluator's reasons; an unknown one says so). */
export const NOT_APPLICABLE_KEYS = ['ARCHIVED', 'SWITCHED_OFF', 'MATERIAL_KIND', 'EXEMPT_NATURAL_LEATHER', 'MARKET', 'OTHER_COMPANY', 'PRODUCT_TYPE', 'BRAND', 'EXEMPT_PPE'] as const
export const whyKey = (why: string | null): string => (why && (NOT_APPLICABLE_KEYS as readonly string[]).includes(why) ? `why.${why}` : 'why.other')

// ---- the profile's edit -----------------------------------------------------------------------------------------------

export interface ProfileDraft {
  readonly compositionConfirmed: boolean
  readonly tannageConfirmed: boolean | null
  readonly originCountry: string
  readonly note: string
}

export const draftOf = (profile: Pick<ProfileRecord, 'compositionConfirmed' | 'tannageConfirmed' | 'originCountry' | 'note'>): ProfileDraft => ({
  compositionConfirmed: profile.compositionConfirmed,
  tannageConfirmed: profile.tannageConfirmed,
  originCountry: profile.originCountry ?? '',
  note: profile.note ?? '',
})

/** The fields that changed, as the PATCH sends them (none: nothing to save). */
export function profileChanges(profile: ProfileRecord, draft: ProfileDraft) {
  const changes: { compositionConfirmed?: boolean; tannageConfirmed?: boolean; originCountry?: string | null; note?: string | null } = {}
  if (draft.compositionConfirmed !== profile.compositionConfirmed) changes.compositionConfirmed = draft.compositionConfirmed
  if (profile.tannageConfirmed !== null && draft.tannageConfirmed !== null && draft.tannageConfirmed !== profile.tannageConfirmed) changes.tannageConfirmed = draft.tannageConfirmed
  const origin = draft.originCountry.trim().toUpperCase()
  if (origin !== (profile.originCountry ?? '')) changes.originCountry = origin || null
  const note = draft.note.trim()
  if (note !== (profile.note ?? '')) changes.note = note || null
  return changes
}

/** What holds the save, field by field (our words' keys). */
export function profileDraftProblems(draft: ProfileDraft): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {}
  const origin = draft.originCountry.trim().toUpperCase()
  if (origin && !ORIGIN_COUNTRY.test(origin)) problems.originCountry = 'card.problem.origin'
  if (draft.note.trim().length > PROFILE_LIMITS.note) problems.note = 'card.problem.note'
  return problems
}

// ---- CSV ----------------------------------------------------------------------------------------------------------------

export function profilesCsv(rows: readonly ProfileRow[], t: Words): string[][] {
  const header = ['csv.code', 'csv.name', 'csv.kind', 'csv.composition', 'csv.tannage', 'csv.origin', 'csv.supplier', 'csv.tests', 'csv.present', 'csv.missing', 'csv.state'].map((key) => t(key))
  return [
    header,
    ...rows.map((row) => [
      row.material.code,
      row.material.name,
      t(`materialKind.${row.material.kind}`),
      row.composition ?? '',
      tannageKey(row.tannage) ? t(tannageKey(row.tannage)!) : (row.tannage ?? ''),
      row.originCountry ?? '',
      row.supplier ? `${row.supplier.code} · ${row.supplier.name}` : '',
      row.testsNeeded.map((test) => t(`test.${test}`)).join('; '),
      row.declarations.present.map((kind) => t(`kind.${kind}`)).join('; '),
      row.declarations.missing.map((kind) => t(`kind.${kind}`)).join('; '),
      t(`state.${stateOf(row)}`),
    ]),
  ]
}
