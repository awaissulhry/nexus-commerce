/**
 * SD-AUD (2026-10-20) — what the Sponsored Display lookups share: a market's locale and country as Amazon's discovery
 * APIs take them, and Amazon's refusal of a read in its own words (status, `code`, `description` / `details` /
 * `message`), never a generic "failed".
 */
import { AmazonAdsQuotaError } from '../ads-api-client.js'

/** Amazon's locale for a market (the enum of /sd/targets/recommendations, /targetableEntities/list, the SP refinements). */
const LOCALE: Record<string, string> = {
  IT: 'it_IT', DE: 'de_DE', FR: 'fr_FR', ES: 'es_ES', UK: 'en_GB', GB: 'en_GB', NL: 'nl_NL', SE: 'sv_SE', PL: 'pl_PL',
  TR: 'tr_TR', US: 'en_US', CA: 'en_CA', MX: 'es_MX', BR: 'pt_BR', JP: 'ja_JP', AU: 'en_AU', IN: 'en_IN', SG: 'en_SG', AE: 'en_AE',
}

/** The locale for a market code, or undefined (Amazon then answers in the marketplace's own language). */
export const sdLocaleOf = (market: string): string | undefined => LOCALE[market.toUpperCase()]

/** The ISO alpha-2 country of a market (`countries` of the audiences API): UK is GB. */
export const sdCountryOf = (market: string): string => (market.toUpperCase() === 'UK' ? 'GB' : market.toUpperCase())

/** Amazon's own words inside an error body: every code and description / details / message it carries. */
function bodyWords(body: string): string {
  try {
    const b = JSON.parse(body) as Record<string, unknown>
    const said: string[] = []
    const push = (v: unknown) => { const s = typeof v === 'string' ? v.trim() : ''; if (s && !said.includes(s)) said.push(s) }
    push(b.code)
    push(b.description ?? b.details ?? b.message)
    for (const e of Array.isArray(b.errors) ? b.errors : []) {
      const x = e as Record<string, unknown>
      push([x.errorType ?? x.code, x.fieldName, x.message ?? x.description].filter((p) => typeof p === 'string' && p).join(' '))
    }
    return said.join(' — ')
  } catch {
    return body.trim()
  }
}

/** A failed SD read as one sentence: Amazon's status and its own words. */
export function sdReadFailure(err: unknown): string {
  if (err instanceof AmazonAdsQuotaError) return `Nexus's Amazon Ads allowance for this region is used up for now. Try again in ${err.retryAfterSec} s.`
  const e = err as { statusCode?: unknown; body?: unknown; message?: unknown }
  const status = typeof e.statusCode === 'number' ? e.statusCode : null
  const words = typeof e.body === 'string' && e.body.trim() ? bodyWords(e.body).slice(0, 400) : ''
  if (status === 401 || status === 403) return `Amazon refused the Ads sign-in for this market (HTTP ${status}${words ? `: ${words}` : ''}). Reconnect Amazon Ads for it.`
  if (status === 429) return `Amazon is busy (HTTP 429${words ? `: ${words}` : ''}). Try again in a few minutes.`
  if (status != null) return `Amazon refused the read (HTTP ${status}${words ? `: ${words}` : ''}).`
  return `Amazon could not be read: ${typeof e.message === 'string' ? e.message.slice(0, 300) : String(err).slice(0, 300)}`
}
