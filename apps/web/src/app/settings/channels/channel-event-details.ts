/** Keep technical account keys in the audit data, not in the operator-facing summary. */
const HIDDEN_KEYS = /^(actorKind|userId|sellerId|(?:external)?accountId|(?:target|channel)?connectionId|profileId|marketplaceId)$/i
const OPAQUE_ACCOUNT = /^(?:A(?=[A-Z0-9]*\d)[A-Z0-9]{9,19}|c[a-z0-9]{24}|\d{6,}|amzn1\..+|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/
const EMBEDDED_ACCOUNT = /A(?=[A-Z0-9]*\d)[A-Z0-9]{9,19}|c[a-z0-9]{24}|amzn1\.[A-Za-z0-9.-]+|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}/

export type AccountNames = Readonly<Record<string, string>>

/** Historical provider errors embed account keys in prose, not just identity fields. */
export function readableAccountText(text: string, names: AccountNames = {}): string {
  const knownIds = Object.keys(names).filter(Boolean).sort((a, b) => b.length - a.length)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const tokens = new RegExp(`\\b(?:${[...knownIds, EMBEDDED_ACCOUNT.source].join('|')})\\b`, 'g')
  // A single pass avoids interpreting a human label as a second identifier.
  return text.replace(tokens, (id) => Object.prototype.hasOwnProperty.call(names, id) ? names[id] : 'account (name unavailable)')
}

function readable(value: unknown, names: AccountNames): unknown {
  if (typeof value === 'string') return OPAQUE_ACCOUNT.test(value.trim()) ? undefined : readableAccountText(value, names)
  if (Array.isArray(value)) return value.map((v) => readable(v, names)).filter((v) => v !== undefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, v]) => !HIDDEN_KEYS.test(key) && !(key.toLowerCase() === 'identity' && typeof v === 'number'))
      .map(([key, v]) => [key, readable(v, names)])
      .filter(([, v]) => v !== undefined))
  }
  return value
}

export function summariseDetail(detail: Record<string, unknown> | null, names: AccountNames = {}): string {
  if (!detail) return ''
  return Object.entries(readable(detail, names) as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}
