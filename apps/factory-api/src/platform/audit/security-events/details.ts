/**
 * The details of a security event (B-W2b-399; PLT-075): codes only, as the database holds them (the …_security_audit_w2b_guards
 * check `factory_security_details_ok`: an object of up to 20 camelCase keys whose values are a one-line string of 1 to 200
 * characters without `@`, a number, true/false, null, or a list of up to 50 of them; at most 4,000 characters). A value that
 * is not a code is left out here rather than refused there, so an event never fails the command or request it belongs to:
 * never an e-mail address, a name, an address or free text about a person.
 */

export type Detail = string | number | boolean | null | readonly (string | number | boolean | null)[]

const KEY = /^[a-z][A-Za-z0-9]{0,39}$/
/** A code: letters, digits and the separators of keys, actions and routes (`WRONG_PIN`, `roles.assign`, `GET /audit/reads`). */
const CODE = /^[A-Za-z0-9_.:/ -]{1,200}$/
const MAX_KEYS = 20
const MAX_LIST = 50

function valueOf(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return CODE.test(value) && value.trim() === value ? value : undefined
  return undefined
}

/** The details to store: codes kept, anything else (and undefined) left out. */
export function detailsOf(details: Readonly<Record<string, unknown>>): Record<string, Detail> {
  const out: Record<string, Detail> = {}
  for (const [key, raw] of Object.entries(details)) {
    if (Object.keys(out).length >= MAX_KEYS) break
    if (!KEY.test(key) || raw === undefined) continue
    if (Array.isArray(raw)) {
      const list = raw.slice(0, MAX_LIST).map(valueOf)
      if (list.every((item) => item !== undefined)) out[key] = list as (string | number | boolean | null)[]
      continue
    }
    const value = valueOf(raw)
    if (value !== undefined) out[key] = value
  }
  return out
}
