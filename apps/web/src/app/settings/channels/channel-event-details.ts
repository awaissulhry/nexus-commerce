/** Keep technical account keys in the audit data, not in the operator-facing summary. */
const HIDDEN_KEYS = /^(actorKind|userId|sellerId|(?:external)?accountId|(?:target|channel)?connectionId|profileId|marketplaceId)$/i
const OPAQUE_ACCOUNT = /^(?:A(?=[A-Z0-9]*\d)[A-Z0-9]{9,19}|c[a-z0-9]{24}|\d{6,}|amzn1\..+|[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12})$/

function readable(value: unknown): unknown {
  if (typeof value === 'string' && OPAQUE_ACCOUNT.test(value.trim())) return undefined
  if (Array.isArray(value)) return value.map(readable).filter((v) => v !== undefined)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, v]) => !HIDDEN_KEYS.test(key) && !(key.toLowerCase() === 'identity' && typeof v === 'number'))
      .map(([key, v]) => [key, readable(v)])
      .filter(([, v]) => v !== undefined))
  }
  return value
}

export function summariseDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return ''
  return Object.entries(readable(detail) as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}
