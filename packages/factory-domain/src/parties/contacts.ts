import type { Issue } from '../core/errors'
import { phoneProblem } from './addresses'
import { isLanguageCode } from './geo'
import { cleanText } from './rules'
import { isEmailAddress } from './tax'

/**
 * A party's contacts (features SAL-004, SCM-004), pure: the people at a party and what they deal with. Personal data
 * (GDPR art. 5(1)(c)): a name, and an email, a phone and a language only when given. One person who works for two
 * parties is two contacts. A contact in use is archived, never deleted.
 *
 *   ORDERS    quotes, order confirmations and their links (a customer's buyer); purchase orders (a supplier's desk)
 *   INVOICES  invoices, deposit requests and payments
 *   QUALITY   certificates, test reports, complaints
 *   DESIGN    tech packs and samples
 *   OWNER     the owner or decision maker
 *   RIDER     wears a made-to-measure garment (the person of a measurement profile)
 *
 * A contact who receives documents (ORDERS, INVOICES, QUALITY) has an email: the documents and links go to it, and
 * inbound mail from it finds the party. Two active contacts of one party never share an email (the module checks).
 */

export const CONTACT_ROLES = ['ORDERS', 'INVOICES', 'QUALITY', 'DESIGN', 'OWNER', 'RIDER'] as const
export type ContactRole = (typeof CONTACT_ROLES)[number]
/** The roles that receive documents by email. */
export const MAILED_CONTACT_ROLES = ['ORDERS', 'INVOICES', 'QUALITY'] as const satisfies readonly ContactRole[]

export interface ContactFields {
  readonly name: string
  /** Trimmed, lower case. */
  readonly email: string | null
  readonly phone: string | null
  readonly roles: readonly ContactRole[]
  /** ISO 639-1; null: the party's language. */
  readonly language: string | null
}
export type ContactField = keyof ContactFields
export const CONTACT_FIELDS: readonly ContactField[] = Object.freeze(['name', 'email', 'phone', 'roles', 'language'])

export interface ContactInput {
  readonly name: string
  readonly email?: string | null | undefined
  readonly phone?: string | null | undefined
  readonly roles?: readonly ContactRole[] | undefined
  readonly language?: string | null | undefined
}

export const normaliseEmail = (value: string | null | undefined): string | null => {
  const text = value?.trim().toLowerCase() ?? ''
  return text === '' ? null : text
}

export function normaliseContact(input: ContactInput): ContactFields {
  const language = input.language?.trim().toLowerCase() ?? ''
  return {
    name: cleanText(input.name) ?? '',
    email: normaliseEmail(input.email),
    phone: cleanText(input.phone),
    roles: CONTACT_ROLES.filter((role) => (input.roles ?? []).includes(role)),
    language: language === '' ? null : language,
  }
}

/** Every rule of a contact; issue paths are field names. */
export function contactProblems(contact: ContactFields): Issue[] {
  const issues: Issue[] = []
  if (contact.name === '') issues.push({ path: 'name', message: "The contact's name is needed." })
  else if (contact.name.length > 120) issues.push({ path: 'name', message: 'At most 120 characters.' })
  if (contact.email !== null && !isEmailAddress(contact.email)) issues.push({ path: 'email', message: 'Expected an email address.' })
  if (contact.phone !== null) {
    const problem = phoneProblem(contact.phone)
    if (problem) issues.push({ path: 'phone', message: problem })
  }
  if (contact.language !== null && !isLanguageCode(contact.language)) issues.push({ path: 'language', message: 'Expected an ISO 639-1 language code (it, en, de…).' })
  const mailed = contact.roles.filter((role) => (MAILED_CONTACT_ROLES as readonly string[]).includes(role))
  if (mailed.length > 0 && contact.email === null) issues.push({ path: 'email', message: `A contact for ${mailed.join(', ').toLowerCase()} has an email: the documents go to it.` })
  return issues
}

export type ContactOutcome = { readonly ok: true; readonly contact: ContactFields } | { readonly ok: false; readonly issues: readonly Issue[] }

export function checkContact(input: ContactInput): ContactOutcome {
  const contact = normaliseContact(input)
  const issues = contactProblems(contact)
  return issues.length > 0 ? { ok: false, issues } : { ok: true, contact }
}

const same = (a: unknown, b: unknown): boolean => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((value, index) => value === b[index]) : a === b)

/** A change of a contact: the patch over its fields, every rule, and the fields that changed. */
export function changeContact(
  current: ContactFields,
  patch: { readonly [Field in ContactField]?: ContactFields[Field] | undefined },
): { readonly ok: true; readonly contact: ContactFields; readonly changed: readonly ContactField[] } | { readonly ok: false; readonly issues: readonly Issue[] } {
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<ContactFields>
  const outcome = checkContact({ ...current, ...given })
  if (!outcome.ok) return outcome
  return { ok: true, contact: outcome.contact, changed: CONTACT_FIELDS.filter((field) => !same(current[field], outcome.contact[field])) }
}

/** Emails used twice among a list of contacts (one party's active ones): the module refuses a second. */
export function duplicateEmails(contacts: readonly Pick<ContactFields, 'email'>[]): string[] {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const { email } of contacts) {
    if (email === null) continue
    if (seen.has(email)) twice.add(email)
    seen.add(email)
  }
  return [...twice].sort()
}
