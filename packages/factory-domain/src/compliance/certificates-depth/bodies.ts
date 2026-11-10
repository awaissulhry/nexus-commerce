import type { Issue } from '../../core/errors'
import { NOTIFIED_BODY_NUMBER } from '../certificates/rules'

/**
 * The notified body directory (B-W2b-255; PRD-286; Reg. (EU) 2016/425 art. 24-35 and Annex II 1.4(j); design
 * compliance.certificates › pop:ce-nb "Notified bodies", rec Certificate › Notified body). B-W2b-216's NotifiedBody: one
 * row per body in the tenant — the four-digit number NANDO gives it, its name, postal address and country, what it is
 * notified for (the scopes as NANDO says them), its NANDO entry (an https address: the Commission's database, opened in a
 * new tab, never read by a machine: plan GATE-SPEND, NANDO is read by a person), contact and note. W1 types the body's
 * name and number on each certificate; a certificate now picks its body from here (its typed number must be the body's).
 *
 * `scopeCheck` is the design's "Listed for protective motorcycle clothing ✓": whether the body's recorded scopes name
 * the PPE Regulation and the kind of product the certificate is for. It reads only what a person typed from NANDO: a
 * warning to look again, never a refusal (NANDO's own words win). Pure.
 */

export const BODY_NAME_MAX = 300
export const BODY_ADDRESS_MAX = 500
export const BODY_SCOPE_MAX = 300
export const BODY_SCOPES_MAX = 50
export const BODY_EMAIL_MAX = 200
export const BODY_PHONE_MAX = 40
export const BODY_NOTE_MAX = 2000
export const BODY_URL_MAX = 2000
export const COUNTRY = /^[A-Z]{2}$/

const CONTROL = /\p{Cc}/u
const CONTROL_BUT_LINES = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/
const HTTPS = /^https:\/\/[^\s\p{Cc}]+$/u
const EMAIL = /^[^\s\p{Cc}@]+@[^\s\p{Cc}@]+\.[^\s\p{Cc}@]+$/u

export interface BodyDraft {
  readonly number?: string | undefined
  readonly name?: string | undefined
  readonly address?: string | undefined
  readonly country?: string | undefined
  readonly nandoUrl?: string | null | undefined
  readonly scopes?: readonly string[] | undefined
  readonly contactEmail?: string | null | undefined
  readonly contactPhone?: string | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): boolean => value === null || value === undefined || value.trim() === ''
const line = (value: string, max: number): boolean => value.trim() !== '' && value.length <= max && !CONTROL.test(value)
const words = (value: string, max: number): boolean => value.trim() !== '' && value.length <= max && !CONTROL_BUT_LINES.test(value)

/**
 * What is wrong with a body's data (the database's NotifiedBody_check, said first in words); fields left out are not
 * checked (an edit sends only what changes). Paths are field names (`scopes/2` for one scope).
 */
export function bodyProblems(draft: BodyDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.number !== undefined && !NOTIFIED_BODY_NUMBER.test(draft.number.trim())) {
    problems.push({ path: 'number', message: 'The four-digit identification number NANDO gives the body (for example 0498).' })
  }
  if (draft.name !== undefined && !line(draft.name, BODY_NAME_MAX)) problems.push({ path: 'name', message: `The body's name as NANDO lists it, at most ${BODY_NAME_MAX} characters.` })
  if (draft.address !== undefined && !words(draft.address, BODY_ADDRESS_MAX)) problems.push({ path: 'address', message: `The postal address, at most ${BODY_ADDRESS_MAX} characters (line breaks allowed).` })
  if (draft.country !== undefined && !COUNTRY.test(draft.country.trim())) problems.push({ path: 'country', message: 'The country as two capital letters (IT, DE, FR …).' })
  if (draft.nandoUrl !== undefined && !blank(draft.nandoUrl) && (draft.nandoUrl!.length > BODY_URL_MAX || !HTTPS.test(draft.nandoUrl!.trim()))) {
    problems.push({ path: 'nandoUrl', message: "The body's NANDO entry as an https address (copied from the Commission's NANDO site), or none." })
  }
  if (draft.scopes !== undefined) {
    if (draft.scopes.length > BODY_SCOPES_MAX) problems.push({ path: 'scopes', message: `At most ${BODY_SCOPES_MAX} scopes.` })
    const seen = new Set<string>()
    draft.scopes.forEach((scope, index) => {
      if (!line(scope, BODY_SCOPE_MAX)) problems.push({ path: `scopes/${index}`, message: `Each scope in 1 to ${BODY_SCOPE_MAX} characters, as NANDO says it.` })
      else if (seen.has(scope.trim().toLowerCase())) problems.push({ path: `scopes/${index}`, message: 'This scope is listed twice.' })
      seen.add(scope.trim().toLowerCase())
    })
  }
  if (draft.contactEmail !== undefined && !blank(draft.contactEmail) && (draft.contactEmail!.length > BODY_EMAIL_MAX || !EMAIL.test(draft.contactEmail!.trim()))) {
    problems.push({ path: 'contactEmail', message: 'An e-mail address (name@example.org), or none.' })
  }
  if (draft.contactPhone !== undefined && !blank(draft.contactPhone) && !line(draft.contactPhone!, BODY_PHONE_MAX)) {
    problems.push({ path: 'contactPhone', message: `A phone number of at most ${BODY_PHONE_MAX} characters, or none.` })
  }
  if (draft.note !== undefined && !blank(draft.note) && !words(draft.note!, BODY_NOTE_MAX)) problems.push({ path: 'note', message: `A note of at most ${BODY_NOTE_MAX} characters, or none.` })
  return problems
}

/** The scopes as stored: trimmed, blanks dropped, each once (the first spelling kept). */
export function cleanScopes(scopes: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const scope of scopes) {
    const text = scope.trim()
    if (!text || seen.has(text.toLowerCase())) continue
    seen.add(text.toLowerCase())
    out.push(text)
  }
  return out
}

/** The kinds of certificate the register keeps (the web's `kindOf` reads the same standards). */
export const CERTIFICATE_KINDS = ['GARMENT', 'PROTECTOR', 'GLOVE', 'OTHER'] as const
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number]

/** What the standard certifies: an EN 17092 garment, an EN 1621 protector, an EN 13594 glove, or another standard. */
export function certificateKindOf(standard: string): CertificateKind {
  const text = standard.trim().toUpperCase().replace(/\s+/g, ' ')
  if (/^EN ?17092\b/.test(text)) return 'GARMENT'
  if (/^EN ?1621\b/.test(text)) return 'PROTECTOR'
  if (/^EN ?13594\b/.test(text)) return 'GLOVE'
  return 'OTHER'
}

/** The PPE Regulation named in a scope (its number, or the usual words for it in English and Italian). */
const PPE_REGULATION = /2016\s*\/\s*425|\bPPE\b|\bDPI\b|personal protective equipment|dispositivi di protezione individuale/i

/** The words that say a scope reaches the product kind (English and Italian; NANDO lists English). */
const KIND_WORDS: Readonly<Record<CertificateKind, RegExp>> = Object.freeze({
  GARMENT: /cloth|garment|motorcycl|abrasion|abbigliament|indument/i,
  PROTECTOR: /impact|protector|protective equipment against mechanical|urti|protettor|paraspalle|paraschiena/i,
  GLOVE: /glove|hand|guant|mani\b/i,
  OTHER: /./,
})

export type ScopeState = 'LISTED' | 'NOT_LISTED' | 'NO_SCOPES'

export interface ScopeCheck {
  readonly state: ScopeState
  /** The recorded scope that answers it (LISTED). */
  readonly scope: string | null
  /** The kind the check was made for. */
  readonly kind: CertificateKind
}

/**
 * Is the body listed for this kind of product (design: "Listed for protective motorcycle clothing ✓", "warning when not
 * listed for protective clothing")? LISTED: a scope names the PPE Regulation and the kind; NOT_LISTED: no scope does;
 * NO_SCOPES: none recorded yet (open the NANDO entry and type them).
 */
export function scopeCheck(scopes: readonly string[], kind: CertificateKind = 'GARMENT'): ScopeCheck {
  if (scopes.length === 0) return { state: 'NO_SCOPES', scope: null, kind }
  const listed = scopes.find((scope) => PPE_REGULATION.test(scope) && KIND_WORDS[kind].test(scope.replace(PPE_REGULATION, ' ')))
  return listed ? { state: 'LISTED', scope: listed, kind } : { state: 'NOT_LISTED', scope: null, kind }
}

/** The NANDO address to open, or null (only an https address is ever offered as a link). */
export const nandoLink = (url: string | null | undefined): string | null => (url && HTTPS.test(url.trim()) && url.length <= BODY_URL_MAX ? url.trim() : null)
