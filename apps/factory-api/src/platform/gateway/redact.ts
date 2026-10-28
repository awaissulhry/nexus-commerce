import type { Prisma } from '@nexus/factory-db'
import { REDACTED, redact } from '../../core/logger'

/**
 * What the call ledger may keep of a request or an answer (feature PLT-195; GDPR art. 5(1)(c) and 32), the pattern of
 * Commerce's gateway redact.ts:
 *   - secret keys (the logger's rule: passwords, tokens, keys, signatures, credentials … and money fields) → [redacted];
 *   - personal data keys (names, e-mail addresses, phones, addresses, tax ids, IBANs, recipients) → [personal];
 *   - in every string: the account's own secret values (its opened credentials) → [redacted], and anything shaped like
 *     an e-mail address → [email];
 *   - at most 8 KiB of JSON per summary, then a marker with the first 8 KiB.
 * Never throws: a summary that cannot be made becomes a marker.
 */

export const PERSONAL = '[personal]'
export const SUMMARY_MAX_BYTES = 8 * 1024
const MAX_DEPTH = 8

/** Keys whose value is personal data, compared without case and punctuation (`first_name` = `firstName`). */
const PERSONAL_KEYS = new Set([
  'name',
  'firstname',
  'lastname',
  'fullname',
  'displayname',
  'contactname',
  'email',
  'emailaddress',
  'mail',
  'phone',
  'phonenumber',
  'mobile',
  'fax',
  'address',
  'street',
  'city',
  'postalcode',
  'postcode',
  'zip',
  'zipcode',
  'province',
  'iban',
  'bic',
  'swift',
  'vatnumber',
  'fiscalcode',
  'taxcode',
  'taxid',
  'codicefiscale',
  'partitaiva',
  'birthdate',
  'dateofbirth',
  'to',
  'cc',
  'bcc',
  'from',
  'replyto',
  'recipient',
  'recipients',
  'sender',
  'ip',
  'ipaddress',
])
const PERSONAL_PATTERN = /^(address|street)(line)?\d*$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

const isPersonalKey = (key: string): boolean => {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return PERSONAL_KEYS.has(compact) || PERSONAL_PATTERN.test(compact)
}

/** Removes the account's secret values and e-mail addresses from a text. */
export function scrubText(text: string, secretValues: readonly string[]): string {
  let out = text
  for (const secret of secretValues) if (secret.length >= 4) out = out.split(secret).join(REDACTED)
  return out.replace(EMAIL, '[email]')
}

function strip(value: unknown, secretValues: readonly string[], depth: number): unknown {
  if (typeof value === 'string') return scrubText(value, secretValues)
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => strip(item, secretValues, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = item !== null && item !== undefined && item !== '' && item !== REDACTED && isPersonalKey(key) ? PERSONAL : strip(item, secretValues, depth + 1)
  }
  return out
}

/** A request or answer made safe for the ledger; undefined for nothing. */
export function ledgerSummary(value: unknown, secretValues: readonly string[] = []): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    let parsed: unknown = value
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          parsed = trimmed
        }
      }
    }
    const safe = strip(redact(parsed), secretValues, 0)
    const text = JSON.stringify(safe) ?? 'null'
    if (Buffer.byteLength(text) <= SUMMARY_MAX_BYTES) return JSON.parse(text) as Prisma.InputJsonValue
    return { truncated: true, bytes: Buffer.byteLength(text), preview: text.slice(0, SUMMARY_MAX_BYTES) }
  } catch {
    return { unserialisable: true }
  }
}

/** Every string inside an opened credentials value (an object of keys and tokens), for scrubText. */
export function secretStrings(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return value.length >= 4 ? [value] : []
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return []
  return Object.values(value as Record<string, unknown>).flatMap((item) => secretStrings(item, depth + 1))
}
