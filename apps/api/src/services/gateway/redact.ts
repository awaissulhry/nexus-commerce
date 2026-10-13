/**
 * P1.1 — what the call ledger may keep of a request or an answer (plan section 7.1 item 11: "personal
 * data and secrets removed and bodies capped").
 *
 * Secrets: any key that looks like credential material (the logger's own rule, utils/logger.ts `redact`).
 * Personal data: buyer and address fields the channels return on orders, returns and messages. A value
 * under such a key becomes "[personal]"; the structure stays, so a failure can still be read.
 * Size: 32 KB per body, then a marker with the first 32 KB (the ledger's existing cap).
 */
import { redact as redactSecrets } from '../../utils/logger.js'

const PERSONAL_KEY = /^(buyer.*|recipient.*|shipTo|shippingAddress|billingAddress|address(line\d*)?|addressLine\d*|street\d*|postalCode|zip(code)?|city|county|stateOrProvince|phone(number)?|email(address)?|buyerEmail|firstName|lastName|fullName|name|contactAddress|customer|taxIdentifier|vatNumber|primaryPhone|deliveryAddress)$/i
/**
 * OAuth's form-encoded bodies (`grant_type=refresh_token&refresh_token=…&client_secret=…`) and the
 * answers some token endpoints give in the same shape: the value after each credential name is masked.
 * `code` is the one-time authorisation code; the boundary keeps `postal_code=` and `country_code=` intact.
 */
const FORM_SECRET = /(^|[?&\s])(access_token|refresh_token|id_token|client_secret|code|code_verifier|token|assertion|client_assertion)=([^&\s]*)/gi
const MAX_DEPTH = 8
export const LEDGER_BODY_MAX = 32 * 1024

function stripPersonal(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((v) => stripPersonal(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = PERSONAL_KEY.test(k) && v !== null && v !== undefined && v !== '' ? '[personal]' : stripPersonal(v, depth + 1)
  }
  return out
}

/** A body (JSON text, object, XML text) made safe for the ledger. Never throws. */
export function ledgerSafeBody(body: unknown): unknown {
  if (body === undefined || body === null || body === '') return undefined
  try {
    let value: unknown = body
    if (typeof body === 'string') {
      const trimmed = body.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { value = JSON.parse(trimmed) } catch { value = trimmed }
      } else {
        // XML (eBay Trading) or text: mask credential elements and obvious personal elements.
        value = trimmed
          .replace(FORM_SECRET, (_m, lead: string, name: string) => `${lead}${name}=[redacted]`)
          .replace(/<(eBayAuthToken|RequesterCredentials|Password|Token)>[\s\S]*?<\/\1>/gi, '<$1>[redacted]</$1>')
          .replace(/<(Email|Phone|Name|Street1|Street2|PostalCode|CityName|StateOrProvince)>[\s\S]*?<\/\1>/gi, '<$1>[personal]</$1>')
      }
    }
    const safe = typeof value === 'string' ? value : stripPersonal(redactSecrets(value))
    const text = typeof safe === 'string' ? safe : JSON.stringify(safe)
    if (text.length <= LEDGER_BODY_MAX) return safe
    return { __truncated: true, bytes: text.length, preview: text.slice(0, LEDGER_BODY_MAX) }
  } catch {
    return { __unserialisable: true }
  }
}
