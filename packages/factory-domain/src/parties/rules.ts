import type { Issue } from '../core/errors'
import { isCurrencyCode } from '../core/money'
import { defineMachine } from '../state/machine'
import { isCountryCode, isLanguageCode } from './geo'

/**
 * A party's own rules (plan A1 §2.4 A "One party record for customers and suppliers"; features SAL-001, SCM-001,
 * SCM-002), pure. ONE record per business partner, whatever it does for us: its roles say so (a tannery that is also a
 * customer is one party with two roles). apps/factory-api's modules/parties checks every create, change and import
 * against these rules BEFORE it writes.
 *
 *   code        1 to 24 capital letters or digits, with . _ - inside; unique in the tenant (the database says so)
 *   legal name  as on its invoices (FatturaPA Denominazione, which carries at most 80 characters: a longer name is kept
 *               and warned about, ./warnings.ts)
 *   roles       one or more of CUSTOMER, BRAND, SUPPLIER, SUBCONTRACTOR, CARRIER, each once
 *   country     ISO 3166-1 alpha-2; currency ISO 4217; language ISO 639-1 (its documents and mail)
 *
 * Status (`partyMachine`): PROSPECT → ACTIVE ⇄ BLOCKED; PROSPECT and ACTIVE → ARCHIVED → ACTIVE. A blocked party is
 * unblocked before it is archived, so a block (a decision of its own, parties.block) is never lost by an archive and a
 * reactivation. An archived party is read only until it is reactivated; master data in use is never deleted.
 */

export const PARTY_KINDS = ['ORGANISATION', 'PERSON'] as const
export type PartyKind = (typeof PARTY_KINDS)[number]
export const PARTY_ROLES = ['CUSTOMER', 'BRAND', 'SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'] as const
export type PartyRole = (typeof PARTY_ROLES)[number]
export const PARTY_STATUSES = ['PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED'] as const
export type PartyStatus = (typeof PARTY_STATUSES)[number]
/** The statuses a party may be created with. */
export const NEW_PARTY_STATUSES = ['PROSPECT', 'ACTIVE'] as const satisfies readonly PartyStatus[]

/** The roles we sell to (Sales › Customers lists them). */
export const CUSTOMER_ROLES = ['CUSTOMER', 'BRAND'] as const satisfies readonly PartyRole[]
/** The roles we buy from or send work and goods with (Purchasing › Suppliers lists them). */
export const SUPPLIER_ROLES = ['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER'] as const satisfies readonly PartyRole[]

export const isCustomer = (roles: readonly PartyRole[]): boolean => roles.some((role) => (CUSTOMER_ROLES as readonly string[]).includes(role))
export const isSupplier = (roles: readonly PartyRole[]): boolean => roles.some((role) => (SUPPLIER_ROLES as readonly string[]).includes(role))

export const partyMachine = defineMachine({
  name: 'party',
  states: PARTY_STATUSES,
  transitions: {
    PROSPECT: ['ACTIVE', 'ARCHIVED'],
    ACTIVE: ['BLOCKED', 'ARCHIVED'],
    BLOCKED: ['ACTIVE'],
    ARCHIVED: ['ACTIVE'],
  },
})

export const PARTY_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/
export const PARTY_CODE_RULE = '1 to 24 capital letters or digits, with . _ - inside'

export const LIMITS = Object.freeze({ legalName: 200, tradeName: 200, paymentTerms: 500, internalNote: 4000, reason: 500 })

/** The fields of a party a person types (its company and status have their own rules). */
export interface PartyFields {
  readonly code: string
  readonly kind: PartyKind
  readonly legalName: string
  readonly tradeName: string | null
  readonly roles: readonly PartyRole[]
  readonly country: string
  readonly currency: string
  readonly language: string
  readonly paymentTerms: string | null
  readonly internalNote: string | null
}
export type PartyField = keyof PartyFields
export const PARTY_FIELDS: readonly PartyField[] = Object.freeze(['code', 'kind', 'legalName', 'tradeName', 'roles', 'country', 'currency', 'language', 'paymentTerms', 'internalNote'])

/** A new party as typed: what is left out takes its default (ORGANISATION, IT, EUR, it). */
export interface PartyInput {
  readonly code: string
  readonly kind?: PartyKind | undefined
  readonly legalName: string
  readonly tradeName?: string | null | undefined
  readonly roles: readonly PartyRole[]
  readonly country?: string | undefined
  readonly currency?: string | undefined
  readonly language?: string | undefined
  readonly paymentTerms?: string | null | undefined
  readonly internalNote?: string | null | undefined
}
export type PartyPatch = { readonly [Field in PartyField]?: PartyFields[Field] | undefined }

/** Trimmed, inner runs of spaces made one; empty is null. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}
/** Trimmed, line breaks kept (notes, terms); empty is null. */
export function cleanNote(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.replace(/\r\n?/g, '\n').trim()
  return text === '' ? null : text
}

export const normaliseCode = (value: string): string => value.trim().toUpperCase()

/** Each role once, in the enum's order. */
export const normaliseRoles = (roles: readonly PartyRole[]): PartyRole[] => PARTY_ROLES.filter((role) => roles.includes(role))

function normalised(fields: PartyFields): PartyFields {
  return {
    code: normaliseCode(fields.code),
    kind: fields.kind,
    legalName: cleanText(fields.legalName) ?? '',
    tradeName: cleanText(fields.tradeName),
    roles: normaliseRoles(fields.roles),
    country: fields.country.trim().toUpperCase(),
    currency: fields.currency.trim().toUpperCase(),
    language: fields.language.trim().toLowerCase(),
    paymentTerms: cleanNote(fields.paymentTerms),
    internalNote: cleanNote(fields.internalNote),
  }
}

/** Every rule of a party's own fields; issue paths are field names. */
export function partyProblems(fields: PartyFields): Issue[] {
  const issues: Issue[] = []
  if (!PARTY_CODE.test(fields.code)) issues.push({ path: 'code', message: `Expected ${PARTY_CODE_RULE}.` })
  if (!(PARTY_KINDS as readonly string[]).includes(fields.kind)) issues.push({ path: 'kind', message: `Expected one of ${PARTY_KINDS.join(', ')}.` })
  if (fields.legalName === '') issues.push({ path: 'legalName', message: 'The legal name is needed: the name on its invoices.' })
  else if (fields.legalName.length > LIMITS.legalName) issues.push({ path: 'legalName', message: `At most ${LIMITS.legalName} characters.` })
  if (fields.tradeName !== null && fields.tradeName.length > LIMITS.tradeName) issues.push({ path: 'tradeName', message: `At most ${LIMITS.tradeName} characters.` })
  if (fields.roles.length === 0) issues.push({ path: 'roles', message: `Give it at least one role: ${PARTY_ROLES.join(', ')}.` })
  if (fields.roles.some((role) => !(PARTY_ROLES as readonly string[]).includes(role))) issues.push({ path: 'roles', message: `Expected roles from ${PARTY_ROLES.join(', ')}.` })
  if (!isCountryCode(fields.country)) issues.push({ path: 'country', message: 'Expected an ISO 3166-1 country code (IT, DE, FR…).' })
  if (!isCurrencyCode(fields.currency)) issues.push({ path: 'currency', message: 'Expected an ISO 4217 currency code (EUR, USD…).' })
  if (!isLanguageCode(fields.language)) issues.push({ path: 'language', message: 'Expected an ISO 639-1 language code (it, en, de…).' })
  if (fields.paymentTerms !== null && fields.paymentTerms.length > LIMITS.paymentTerms) issues.push({ path: 'paymentTerms', message: `At most ${LIMITS.paymentTerms} characters.` })
  if (fields.internalNote !== null && fields.internalNote.length > LIMITS.internalNote) issues.push({ path: 'internalNote', message: `At most ${LIMITS.internalNote} characters.` })
  return issues
}

export type PartyOutcome = { readonly ok: true; readonly party: PartyFields } | { readonly ok: false; readonly issues: readonly Issue[] }

export function newParty(input: PartyInput): PartyOutcome {
  const party = normalised({
    code: input.code,
    kind: input.kind ?? 'ORGANISATION',
    legalName: input.legalName,
    tradeName: input.tradeName ?? null,
    roles: input.roles,
    country: input.country ?? 'IT',
    currency: input.currency ?? 'EUR',
    language: input.language ?? 'it',
    paymentTerms: input.paymentTerms ?? null,
    internalNote: input.internalNote ?? null,
  })
  const issues = partyProblems(party)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, party }
}

export type PartyChange =
  | { readonly ok: true; readonly party: PartyFields; readonly changed: readonly PartyField[] }
  | { readonly ok: false; readonly issues: readonly Issue[] }

const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b)

/** The patch over the current fields (undefined: not sent; null clears an optional text), then every rule. */
export function changeParty(current: PartyFields, patch: PartyPatch): PartyChange {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<PartyFields>
  const party = normalised({ ...current, ...given })
  const issues = partyProblems(party)
  if (issues.length > 0) return { ok: false, issues }
  const changed = PARTY_FIELDS.filter((field) => !same(current[field], party[field]))
  return { ok: true, party, changed }
}

/** A reason a person gives (a block, an archive): trimmed, 1 to 500 characters. */
export function reasonProblems(reason: string | null | undefined, required: boolean): Issue[] {
  const text = cleanNote(reason)
  if (text === null) return required ? [{ path: 'reason', message: 'Say why: the reason is kept with the change.' }] : []
  return text.length > LIMITS.reason ? [{ path: 'reason', message: `At most ${LIMITS.reason} characters.` }] : []
}
