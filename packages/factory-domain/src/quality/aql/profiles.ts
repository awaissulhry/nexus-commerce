import { SAFETY_LAW } from '../defects/severity'
import { INSPECTION_LEVELS, isInspectionLevel } from './iso2859'
import { AQL_VALUES_WORDS, isAqlValue } from './sampling'

/**
 * AQL profiles per customer and style (B-W2b-93; QHS-021; design quality.plans pl-aql "Saved sets per customer and
 * style", quality.inspections aql-profile "Source chain: style override › customer profile › company default").
 *
 * A profile (AqlProfile, B-W2b-76) is a company's named set: an inspection level and the major and minor AQLs; critical
 * is always 0 (QHS-002, locked: the database refuses anything else). One profile is the company's default. An
 * assignment (AqlProfileAssignment) names a profile for a customer, a style, or a style of one customer; one active row
 * per pair, a replaced or ended one is set inactive (the history stays).
 *
 * Which profile applies to an inspection, the first that answers:
 *   1. the plan version's own profile (InspectionPlanVersion.aqlProfileId, sampling AQL_PROFILE),
 *   2. the style of this customer (an assignment with both),
 *   3. the style (an assignment with the style only),
 *   4. the customer (an assignment with the customer only),
 *   5. the company's default.
 * Goods made for several customers at once (one work order, cells of more than one customer) skip the customer steps:
 * the answer says so, and a person may name a profile with a reason.
 */

/** What happened to a profile (the event quality.aql_profile_changed). */
export const PROFILE_CHANGES = ['CREATED', 'EDITED', 'RETIRED', 'REACTIVATED', 'DEFAULT_SET'] as const
export type ProfileChange = (typeof PROFILE_CHANGES)[number]
/** What happened to an assignment (the event quality.aql_assignment_changed): REPLACED = a new one ended the pair's old one. */
export const ASSIGNMENT_CHANGES = ['ASSIGNED', 'REPLACED', 'ENDED'] as const
export type AssignmentChange = (typeof ASSIGNMENT_CHANGES)[number]

export const PROFILE_CODE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/
export const PROFILE_LIMITS = Object.freeze({ name: 100, note: 500, perCompany: 200, reason: 500, reasonMin: 3 })

export interface ProfileDraft {
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly inspectionLevel?: string | undefined
  readonly aqlMajor?: string | undefined
  readonly aqlMinor?: string | undefined
  /** Only 0 is taken (critical is locked); anything else is refused in words. */
  readonly aqlCritical?: string | undefined
  readonly note?: string | null | undefined
}

export interface ProfileProblem {
  readonly path: string
  readonly message: string
}

/** Critical is locked at 0, in words with its law (QHS-002). */
export const CRITICAL_LOCKED_WORDS = `Critical is always 0: a critical defect is never accepted (${SAFETY_LAW}).`

/** What is wrong with a profile, every problem at once; `creating`: the code and every field are needed. */
export function profileDraftProblems(draft: ProfileDraft, creating: boolean): ProfileProblem[] {
  const problems: ProfileProblem[] = []
  if (creating) {
    const code = draft.code?.trim() ?? ''
    if (!PROFILE_CODE.test(code)) problems.push({ path: 'code', message: 'A code of 1 to 40 capitals, digits, dots, dashes or underscores, no spaces ("AQL-EXM").' })
  } else if (draft.code !== undefined) {
    problems.push({ path: 'code', message: "A profile's code never changes (inspections and plans name it): make a new profile instead." })
  }
  if (creating || draft.name !== undefined) {
    const name = draft.name?.trim() ?? ''
    if (name === '') problems.push({ path: 'name', message: 'Give the profile a name.' })
    else if (name.length > PROFILE_LIMITS.name) problems.push({ path: 'name', message: `At most ${PROFILE_LIMITS.name} characters.` })
  }
  if (creating || draft.inspectionLevel !== undefined) {
    if (!isInspectionLevel(draft.inspectionLevel)) problems.push({ path: 'inspectionLevel', message: `An ISO 2859-1 inspection level: ${INSPECTION_LEVELS.join(', ')}.` })
  }
  for (const key of ['aqlMajor', 'aqlMinor'] as const) {
    if (!creating && draft[key] === undefined) continue
    const value = draft[key] ?? ''
    if (!isAqlValue(value)) problems.push({ path: key, message: `An AQL of ISO 2859-1 Table 2-A (percent of units with a defect): ${AQL_VALUES_WORDS}. "${value}" is not one.` })
  }
  if (draft.aqlCritical !== undefined && !/^0+(\.0+)?$/.test(draft.aqlCritical.trim())) problems.push({ path: 'aqlCritical', message: CRITICAL_LOCKED_WORDS })
  if ((draft.note?.trim().length ?? 0) > PROFILE_LIMITS.note) problems.push({ path: 'note', message: `At most ${PROFILE_LIMITS.note} characters.` })
  return problems
}

/** A written reason (a profile other than the one the chain gives): 3 to 500 characters; null when fine. */
export function reasonProblem(reason: string | null | undefined, path = 'reason'): ProfileProblem | null {
  const text = reason?.trim() ?? ''
  if (text.length < PROFILE_LIMITS.reasonMin) return { path, message: `Say why, in at least ${PROFILE_LIMITS.reasonMin} characters.` }
  if (text.length > PROFILE_LIMITS.reason) return { path, message: `At most ${PROFILE_LIMITS.reason} characters.` }
  return null
}

// ---- the chain ------------------------------------------------------------------------------------------------------

export const PROFILE_SOURCES = ['PLAN_VERSION', 'STYLE_CUSTOMER', 'STYLE', 'CUSTOMER', 'COMPANY_DEFAULT', 'NAMED', 'NONE'] as const
/** Where the profile came from: a chain step, NAMED (a person chose it, with a reason) or NONE (no profile at all). */
export type ProfileSource = (typeof PROFILE_SOURCES)[number]

export const SOURCE_WORDS: Readonly<Record<ProfileSource, { readonly it: string; readonly en: string }>> = Object.freeze({
  PLAN_VERSION: { it: 'Profilo del piano di controllo', en: "The inspection plan's profile" },
  STYLE_CUSTOMER: { it: 'Profilo del modello per questo cliente', en: 'The style for this customer' },
  STYLE: { it: 'Profilo del modello', en: 'The style override' },
  CUSTOMER: { it: 'Profilo del cliente', en: "The customer's profile" },
  COMPANY_DEFAULT: { it: "Predefinito dell'azienda", en: "The company's default" },
  NAMED: { it: 'Scelto da una persona, con il motivo', en: 'Chosen by a person, with the reason' },
  NONE: { it: 'Nessun profilo', en: 'No profile' },
})

export interface ProfileFacts {
  readonly id: string
  readonly code: string
  readonly active: boolean
  readonly isDefault: boolean
}

export interface AssignmentFacts {
  readonly id: string
  readonly profileId: string
  readonly customerId: string | null
  readonly styleId: string | null
  readonly active: boolean
}

export interface ChainAsk {
  /** The plan version's own profile (sampling AQL_PROFILE with a profile named); null: none named. */
  readonly planProfileId?: string | null | undefined
  readonly styleId: string | null
  /** The customers the goods are for (a work order's cells); more than one skips the customer steps. */
  readonly customerIds: readonly string[]
}

export interface ChainStep {
  readonly source: Exclude<ProfileSource, 'NAMED' | 'NONE'>
  /** The profile this step names; null: the step has none (or is skipped). */
  readonly profileId: string | null
  readonly assignmentId: string | null
  readonly skipped: string | null
}

export interface ChainAnswer {
  readonly profileId: string | null
  readonly source: ProfileSource
  readonly assignmentId: string | null
  readonly steps: readonly ChainStep[]
  readonly words: string
}

/**
 * The profile that applies (QHS-021): the first chain step with an active profile. Only active assignments and active
 * profiles answer (a retired profile is never applied to a new inspection: the database refuses it).
 */
export function resolveProfile(ask: ChainAsk, profiles: readonly ProfileFacts[], assignments: readonly AssignmentFacts[]): ChainAnswer {
  const live = new Map(profiles.filter((profile) => profile.active).map((profile) => [profile.id, profile]))
  const active = assignments.filter((row) => row.active && live.has(row.profileId))
  const customers = [...new Set(ask.customerIds)]
  const customer = customers.length === 1 ? customers[0]! : null
  const manyCustomers = customers.length > 1 ? `The goods are for ${customers.length} customers: the customer steps are skipped.` : null
  const noCustomer = customers.length === 0 ? 'No customer is named.' : null
  const find = (customerId: string | null, styleId: string | null) => active.find((row) => row.customerId === customerId && row.styleId === styleId) ?? null
  const step = (source: ChainStep['source'], row: AssignmentFacts | null, skipped: string | null = null): ChainStep => ({ source, profileId: row?.profileId ?? null, assignmentId: row?.id ?? null, skipped })
  const planProfile = ask.planProfileId && live.has(ask.planProfileId) ? ask.planProfileId : null
  const steps: ChainStep[] = [
    { source: 'PLAN_VERSION', profileId: planProfile, assignmentId: null, skipped: ask.planProfileId && !planProfile ? 'The plan names a retired profile.' : null },
    ask.styleId && customer ? step('STYLE_CUSTOMER', find(customer, ask.styleId)) : step('STYLE_CUSTOMER', null, manyCustomers ?? noCustomer ?? 'No style is named.'),
    ask.styleId ? step('STYLE', find(null, ask.styleId)) : step('STYLE', null, 'No style is named.'),
    customer ? step('CUSTOMER', find(customer, null)) : step('CUSTOMER', null, manyCustomers ?? noCustomer),
    { source: 'COMPANY_DEFAULT', profileId: profiles.find((profile) => profile.isDefault && profile.active)?.id ?? null, assignmentId: null, skipped: null },
  ]
  const hit = steps.find((entry) => entry.profileId !== null)
  if (!hit) return { profileId: null, source: 'NONE', assignmentId: null, steps, words: 'No profile applies: the company has no default AQL profile and no assignment answers.' }
  const code = live.get(hit.profileId!)!.code
  return { profileId: hit.profileId, source: hit.source, assignmentId: hit.assignmentId, steps, words: `${SOURCE_WORDS[hit.source].en}: ${code}.${manyCustomers ? ` ${manyCustomers}` : ''}` }
}
