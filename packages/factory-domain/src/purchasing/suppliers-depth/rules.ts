import type { Issue } from '../../core/errors'
import { isCountryCode } from '../../parties/geo'
import { cleanNote, cleanText, type PartyRole, type PartyStatus } from '../../parties/rules'
import { TANNAGES, type Tannage } from '../../product/materials/rules'

/**
 * Suppliers in depth (B-W2b-311; features SCM-002, SCM-008, SCM-016; the columns are B-W2b-287's, factory-db
 * parties.prisma + suppliers-depth.prisma): what kind of supplier a party is, where it stands with us and where it makes
 * what it sells us. Pure; apps/factory-api modules/purchasing/suppliers-depth writes it through command(), and the
 * …_suppliers_depth_w2b_guards triggers hold the same shapes for every login.
 *
 *   kinds     TANNERY, TEXTILE_MILL, TRIMS, PROTECTOR_MAKER, SUBCONTRACTOR, CARRIER, SERVICE: one or more, each once, only on
 *             a party with the SUPPLIER, SUBCONTRACTOR or CARRIER role
 *   status    PROSPECT → APPROVED | CONDITIONAL → ON_HOLD | BLOCKED → … INACTIVE (the moves below), with a reason for
 *             CONDITIONAL, ON_HOLD and BLOCKED. Null = not set: W1's party status alone stands (no backfill). A supplier
 *             ON_HOLD, BLOCKED or INACTIVE gets no new purchase order, said in words; a PROSPECT only a sample order.
 *             W1's party status (BLOCKED, ARCHIVED) is read beside it: either one stops a new order.
 *   origin    the country (ISO 3166-1 alpha-2), region and words of where it makes what it sells us; as a tannery the
 *             countries its raw hides come from and its tannages (Reg. (EU) 2024/3015 due diligence from 14 Dec 2027).
 */

export const SUPPLIER_KINDS = ['TANNERY', 'TEXTILE_MILL', 'TRIMS', 'PROTECTOR_MAKER', 'SUBCONTRACTOR', 'CARRIER', 'SERVICE'] as const
export type SupplierKind = (typeof SUPPLIER_KINDS)[number]

export const SUPPLIER_STATUSES = ['PROSPECT', 'APPROVED', 'CONDITIONAL', 'ON_HOLD', 'BLOCKED', 'INACTIVE'] as const
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number]

/** The roles that may carry supplier kinds and a supplier status (the database's rule too). */
export const SUPPLIER_ROLES = ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'] as const satisfies readonly PartyRole[]
export const hasSupplierRole = (roles: readonly string[]): boolean => roles.some((role) => (SUPPLIER_ROLES as readonly string[]).includes(role))

export const KIND_WORDS: Readonly<Record<SupplierKind, string>> = Object.freeze({
  TANNERY: 'tannery',
  TEXTILE_MILL: 'textile mill',
  TRIMS: 'trims',
  PROTECTOR_MAKER: 'protector maker',
  SUBCONTRACTOR: 'subcontractor',
  CARRIER: 'carrier',
  SERVICE: 'service',
})

export const STATUS_WORDS: Readonly<Record<SupplierStatus, string>> = Object.freeze({
  PROSPECT: 'a prospect',
  APPROVED: 'approved',
  CONDITIONAL: 'approved with conditions',
  ON_HOLD: 'on hold',
  BLOCKED: 'blocked',
  INACTIVE: 'inactive',
})

/** The statuses that need a reason (the database's rule too). */
export const REASON_NEEDED: readonly SupplierStatus[] = Object.freeze(['CONDITIONAL', 'ON_HOLD', 'BLOCKED'])
/** The statuses that take no new purchase order. */
export const NO_NEW_ORDER: readonly SupplierStatus[] = Object.freeze(['ON_HOLD', 'BLOCKED', 'INACTIVE'])
export const REASON_MAX = 500
export const LIMITS = Object.freeze({ region: 120, note: 2000, hideCountries: 50, leadTimeDays: 366 })

/**
 * Where a supplier may go from where it stands. A first status (none set yet) may be any. An INACTIVE supplier comes back
 * as a prospect or approved again; nothing goes back to PROSPECT from a decision.
 */
export const STATUS_MOVES: Readonly<Record<SupplierStatus, readonly SupplierStatus[]>> = Object.freeze({
  PROSPECT: ['APPROVED', 'CONDITIONAL', 'BLOCKED', 'INACTIVE'],
  APPROVED: ['CONDITIONAL', 'ON_HOLD', 'BLOCKED', 'INACTIVE'],
  CONDITIONAL: ['APPROVED', 'ON_HOLD', 'BLOCKED', 'INACTIVE'],
  ON_HOLD: ['APPROVED', 'CONDITIONAL', 'BLOCKED', 'INACTIVE'],
  BLOCKED: ['APPROVED', 'CONDITIONAL', 'ON_HOLD', 'INACTIVE'],
  INACTIVE: ['PROSPECT', 'APPROVED', 'CONDITIONAL'],
})

export const isSupplierStatus = (value: unknown): value is SupplierStatus => (SUPPLIER_STATUSES as readonly unknown[]).includes(value)

/** A status's reason, one line, trimmed; empty is null. */
export const cleanReason = (value: string | null | undefined): string | null => cleanText(value)

/**
 * What stands against setting `to` (with `reason`) on a supplier at `from` (null: none set yet). The same status again is
 * a correction of its reason only (the database moves neither the time nor the person then).
 */
export function statusChangeProblems(from: SupplierStatus | null, to: SupplierStatus, reason: string | null): Issue[] {
  const issues: Issue[] = []
  if (!isSupplierStatus(to)) return [{ path: 'status', message: `Expected one of ${SUPPLIER_STATUSES.join(', ')}.` }]
  if (reason !== null && reason.length > REASON_MAX) issues.push({ path: 'reason', message: `At most ${REASON_MAX} characters.` })
  if (REASON_NEEDED.includes(to) && reason === null) issues.push({ path: 'reason', message: `Say why the supplier is ${STATUS_WORDS[to]}: the reason is kept with the status.` })
  if (from === to) {
    if (reason === null) issues.push({ path: 'status', message: `The supplier is ${STATUS_WORDS[to]} already.` })
  } else if (from !== null && !STATUS_MOVES[from].includes(to)) {
    issues.push({ path: 'status', message: `A supplier that is ${STATUS_WORDS[from]} is not made ${STATUS_WORDS[to]}: ${STATUS_MOVES[from].map((status) => STATUS_WORDS[status]).join(', ')} only.` })
  }
  return issues
}

/** The supplier status a new supplier starts with (B-W2b-287's "from now on"): its W1 status read as one. */
export function initialSupplierStatus(partyStatus: PartyStatus): SupplierStatus {
  switch (partyStatus) {
    case 'PROSPECT':
      return 'PROSPECT'
    case 'ACTIVE':
      return 'APPROVED'
    case 'BLOCKED':
      return 'BLOCKED'
    case 'ARCHIVED':
      return 'INACTIVE'
  }
}

/** Where a supplier stands, for the words and the checks. */
export interface Standing {
  readonly name: string
  readonly partyStatus: PartyStatus
  readonly supplierStatus: SupplierStatus | null
  /** The status's reason (office only: the partner never reads it). */
  readonly reason: string | null
  /** The business day the status was set; null: not known. */
  readonly since: string | null
}

/** The status a list shows: W1's BLOCKED and ARCHIVED stand over the supplier status; else the supplier status, else W1's read as one. */
export function effectiveStatus(partyStatus: PartyStatus, supplierStatus: SupplierStatus | null): { readonly status: SupplierStatus; readonly source: 'PARTY' | 'SUPPLIER' } {
  if (partyStatus === 'BLOCKED' || partyStatus === 'ARCHIVED') return { status: initialSupplierStatus(partyStatus), source: 'PARTY' }
  if (supplierStatus !== null) return { status: supplierStatus, source: 'SUPPLIER' }
  return { status: initialSupplierStatus(partyStatus), source: 'PARTY' }
}

const sinceWords = (since: string | null): string => (since ? ` since ${since}` : '')
const reasonWords = (reason: string | null): string => (reason ? ` (${reason})` : '')

/**
 * Why no new purchase order goes to the supplier as its supplier status stands (null: nothing against it here). W1's
 * party status is checked by its own rule first (purchasing assertBuyable): this adds ON_HOLD, BLOCKED and INACTIVE.
 */
export function newOrderProblem(standing: Standing): string | null {
  const status = standing.supplierStatus
  if (status === null || !NO_NEW_ORDER.includes(status)) return null
  const at = `${standing.name} is ${STATUS_WORDS[status]} as a supplier${sinceWords(standing.since)}${reasonWords(standing.reason)}`
  return status === 'INACTIVE' ? `${at}: no new purchase order goes to it; set it approved again to buy from it.` : `${at}: no new purchase order goes to it; pick another approved source.`
}

/** Why an order to the supplier is not sent as its supplier status stands: a new order's problem, or a prospect's standard order. */
export function sendProblem(standing: Standing, orderKind: 'STANDARD' | 'SAMPLE' = 'STANDARD'): string | null {
  const problem = newOrderProblem(standing)
  if (problem) return problem
  if (standing.supplierStatus === 'PROSPECT' && orderKind !== 'SAMPLE') return `${standing.name} is still a prospect: only a sample order goes to it; approve it as a supplier first.`
  return null
}

// ---- kinds ---------------------------------------------------------------------------------------------------------------

/** Each kind once, in the enum's order. */
export const normaliseKinds = (kinds: readonly string[]): SupplierKind[] => SUPPLIER_KINDS.filter((kind) => kinds.includes(kind))

export function kindsProblems(kinds: readonly string[], roles: readonly string[]): Issue[] {
  const unknown = kinds.filter((kind) => !(SUPPLIER_KINDS as readonly string[]).includes(kind))
  if (unknown.length > 0) return [{ path: 'kinds', message: `Expected kinds from ${SUPPLIER_KINDS.join(', ')}.` }]
  if (kinds.length > 0 && !hasSupplierRole(roles)) return [{ path: 'kinds', message: 'Supplier kinds are a supplier’s: give the party the supplier, subcontractor or carrier role first.' }]
  return []
}

// ---- origin --------------------------------------------------------------------------------------------------------------

export interface OriginFields {
  readonly originCountry: string | null
  readonly originRegion: string | null
  readonly originNote: string | null
  /** ISO 3166-1 alpha-2, each once (a tannery's). */
  readonly hideOriginCountries: readonly string[]
  /** Each once (a tannery's). */
  readonly tannages: readonly Tannage[]
}

export const normaliseCountries = (countries: readonly string[]): string[] => [...new Set(countries.map((country) => country.trim().toUpperCase()).filter((country) => country !== ''))]
export const normaliseTannages = (tannages: readonly string[]): Tannage[] => TANNAGES.filter((tannage) => tannages.includes(tannage))

export function originProblems(origin: OriginFields, kinds: readonly string[]): Issue[] {
  const issues: Issue[] = []
  if (origin.originCountry !== null && !isCountryCode(origin.originCountry)) issues.push({ path: 'originCountry', message: 'Expected a country code (ISO 3166-1 alpha-2, IT, PK, IN …).' })
  if (origin.originRegion !== null && (origin.originRegion.length > LIMITS.region || /[\r\n]/.test(origin.originRegion))) issues.push({ path: 'originRegion', message: `One line, at most ${LIMITS.region} characters.` })
  if (origin.originNote !== null && origin.originNote.length > LIMITS.note) issues.push({ path: 'originNote', message: `At most ${LIMITS.note} characters.` })
  const bad = origin.hideOriginCountries.filter((country) => !isCountryCode(country))
  if (bad.length > 0) issues.push({ path: 'hideOriginCountries', message: `Not a country code: ${bad.join(', ')}.` })
  if (origin.hideOriginCountries.length > LIMITS.hideCountries) issues.push({ path: 'hideOriginCountries', message: `At most ${LIMITS.hideCountries} countries.` })
  if (origin.tannages.some((tannage) => !(TANNAGES as readonly string[]).includes(tannage))) issues.push({ path: 'tannages', message: `Expected tannages from ${TANNAGES.join(', ')}.` })
  if ((origin.hideOriginCountries.length > 0 || origin.tannages.length > 0) && !kinds.includes('TANNERY')) {
    issues.push({ path: origin.hideOriginCountries.length > 0 ? 'hideOriginCountries' : 'tannages', message: 'The raw hides’ origin and the tannages are a tannery’s: give the supplier the tannery kind, or leave them empty.' })
  }
  return issues
}

// ---- the supplier profile: kinds, the default lead time, origin --------------------------------------------------------

export interface SupplierProfile extends OriginFields {
  readonly kinds: readonly SupplierKind[]
  /** Calendar days from the order to the goods at our site (the W1 default lead time); null: none. */
  readonly leadTimeDays: number | null
}
export type ProfileField = keyof SupplierProfile
export const PROFILE_FIELDS: readonly ProfileField[] = Object.freeze(['kinds', 'leadTimeDays', 'originCountry', 'originRegion', 'originNote', 'hideOriginCountries', 'tannages'])

/** A change of the profile: a field left out is kept; null clears a single value; a list replaces the list. */
export type ProfilePatch = { readonly [Field in ProfileField]?: SupplierProfile[Field] | undefined }

/**
 * The profile a patch leaves (normalised: codes upper case, lists each once in order, text cleaned) with the fields that
 * change, or the issues (paths are the field names). The kinds need a supplier role; hides and tannages need TANNERY in
 * the kinds as they are AFTER the patch, so removing TANNERY clears or refuses them in one change.
 */
export function changeProfile(current: SupplierProfile, patch: ProfilePatch, roles: readonly string[]): { readonly ok: true; readonly profile: SupplierProfile; readonly changed: ProfileField[] } | { readonly ok: false; readonly issues: Issue[] } {
  const kindsIssues = patch.kinds === undefined ? [] : kindsProblems(patch.kinds, roles)
  if (kindsIssues.length > 0) return { ok: false, issues: kindsIssues }
  if (patch.tannages !== undefined && patch.tannages.some((tannage) => !(TANNAGES as readonly string[]).includes(tannage))) return { ok: false, issues: [{ path: 'tannages', message: `Expected tannages from ${TANNAGES.join(', ')}.` }] }
  const next: SupplierProfile = {
    kinds: patch.kinds === undefined ? current.kinds : normaliseKinds(patch.kinds),
    leadTimeDays: patch.leadTimeDays === undefined ? current.leadTimeDays : patch.leadTimeDays,
    originCountry: patch.originCountry === undefined ? current.originCountry : (cleanText(patch.originCountry)?.toUpperCase() ?? null),
    originRegion: patch.originRegion === undefined ? current.originRegion : cleanText(patch.originRegion),
    originNote: patch.originNote === undefined ? current.originNote : cleanNote(patch.originNote),
    hideOriginCountries: patch.hideOriginCountries === undefined ? current.hideOriginCountries : normaliseCountries(patch.hideOriginCountries),
    tannages: patch.tannages === undefined ? current.tannages : normaliseTannages(patch.tannages),
  }
  const issues: Issue[] = []
  if (next.leadTimeDays !== null && (!Number.isSafeInteger(next.leadTimeDays) || next.leadTimeDays < 0 || next.leadTimeDays > LIMITS.leadTimeDays)) issues.push({ path: 'leadTimeDays', message: `Whole days from 0 to ${LIMITS.leadTimeDays}.` })
  issues.push(...originProblems(next, next.kinds))
  if (issues.length > 0) return { ok: false, issues }
  const same = (field: ProfileField) => JSON.stringify(current[field]) === JSON.stringify(next[field])
  return { ok: true, profile: next, changed: PROFILE_FIELDS.filter((field) => !same(field)) }
}

/**
 * B-W2b-287's gap: the database does not refuse removing a party's last supplier role while it carries supplier kinds or a
 * status (a status is never cleared). The parties' commands ask this before they write new roles (null: nothing against).
 */
export function supplierRoleProblem(name: string, before: readonly string[], after: readonly string[], held: { readonly kinds: readonly string[]; readonly supplierStatus: SupplierStatus | null }): string | null {
  if (!hasSupplierRole(before) || hasSupplierRole(after)) return null
  if (held.kinds.length === 0 && held.supplierStatus === null) return null
  return held.supplierStatus !== null
    ? `${name} has a supplier status (${STATUS_WORDS[held.supplierStatus]}): it keeps a supplier, subcontractor or carrier role. Set its supplier status to inactive instead.`
    : `${name} has supplier kinds: remove them on its supplier record before it loses its supplier, subcontractor or carrier role.`
}
