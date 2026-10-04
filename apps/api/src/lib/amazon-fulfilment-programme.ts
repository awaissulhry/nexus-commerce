/**
 * Amazon sheet gaps (D3, design-draft-and-remote.md §B) — what an Amazon fulfilment channel code means, in ONE place.
 *
 * Amazon's API rules we cache offer only `AMAZON_EU` (FBA) and `DEFAULT` (FBM). Seller Central adds codes of its own:
 * Remote Fulfilment with FBA (`AMAZON_EU_RAFN` = EU stock sold in the UK store, `AMAZON_EU2AE_RAFN` = EU stock → UAE,
 * `AMAZON_UK2NL_RAFN` = UK stock → Netherlands, …) and `AMAZON_EU_VCS`. Amazon creates those offers itself after the
 * seller enrols, so Nexus shows them read-only, keeps them on every save and treats every one of them as FBA. The
 * mapping is inferred from the code names (Amazon documents none of them in the API), so the raw code stays visible.
 *
 * The code can sit in two places on a listing: `platformAttributes.fulfillment_availability[*]` (what the fulfilment
 * door writes) and `platformAttributes.attributes.fulfillment_availability[*]` (what Amazon's pull reports). Both are
 * read, every entry — never only the first. Old flat-file saves stored the LABEL as the code
 * ("Gestito dal venditore (default)"); it is read as the code it names.
 */

export type AmazonFulfilmentKind = 'FBA' | 'FBM' | 'REMOTE' | 'UNKNOWN'

export interface AmazonFulfilmentProgramme {
  /** The normalised code (upper case; a label resolved to the code it names). */
  code: string
  kind: AmazonFulfilmentKind
  /** What Nexus treats the code as. `null` = an unknown code: never rebuilt, never sent. */
  method: 'FBA' | 'FBM' | null
  /** Remote Fulfilment only: the stock's home and the store it sells in. */
  from: string | null
  to: string | null
  /** VCS: Amazon's own variant of FBA. */
  vcs: boolean
  /** Short words for a cell or a chip. */
  label: string
  /** The sentence a read-only cell shows; `null` for the two codes Nexus sets itself (FBA / FBM). */
  readOnlyReason: string | null
}

/** The codes Nexus itself writes. Everything else is Amazon's, kept as reported. */
export const AMAZON_FBA_CODE = 'AMAZON_EU'
export const AMAZON_FBM_CODE = 'DEFAULT'
/** The choices a person has (D3): FBA or FBM. Remote Fulfilment is switched on in Seller Central, never here. */
export const AMAZON_FULFILMENT_CHOICES = [AMAZON_FBA_CODE, AMAZON_FBM_CODE] as const

const STORE_NAMES: Readonly<Record<string, string>> = {
  EU: 'EU', UK: 'UK', GB: 'UK', AE: 'UAE', SA: 'Saudi Arabia', TR: 'Türkiye', IE: 'Ireland', NL: 'Netherlands',
  SE: 'Sweden', PL: 'Poland', BE: 'Belgium', DE: 'Germany', FR: 'France', IT: 'Italy', ES: 'Spain', US: 'US',
}
const storeName = (code: string): string => STORE_NAMES[code] ?? code
/** `AMAZON_EU_RAFN` / `AMAZON_UK_RAFN` name no destination: EU stock sells in the UK store and UK stock in the EU. */
const DEFAULT_REMOTE_TO: Readonly<Record<string, string>> = { EU: 'UK', UK: 'EU' }
const REMOTE = /^AMAZON_([A-Z]{2})(?:2([A-Z]{2}))?_RAFN$/

/** Option words of the Fulfillment method column (the two choices). */
export const AMAZON_FULFILMENT_OPTION_LABELS: Readonly<Record<string, string>> = {
  [AMAZON_FBA_CODE]: 'FBA — Amazon stores and ships',
  [AMAZON_FBM_CODE]: 'FBM — you ship',
}

/** A stored code or label → the code. `"Gestito dal venditore (default)"` → `DEFAULT`; blank → `''`. */
export function normaliseAmazonFulfilmentCode(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const s = raw.trim().toUpperCase()
  if (!s) return ''
  // A label with the code in brackets (the old flat-file pick-list stored the label itself).
  const bracketed = /\(([A-Z0-9_]+)\)\s*$/.exec(s)
  return bracketed ? bracketed[1] : s
}

/** Does this (normalised) code mean Amazon fulfils the order? Fail-closed: any `AMAZON…` code, or Amazon's `AFN`. */
export function isFbaFulfilmentCode(code: string): boolean {
  const c = normaliseAmazonFulfilmentCode(code)
  return c.startsWith('AMAZON') || c === 'AFN'
}

/** Every fulfilment code a listing carries, from BOTH places, every entry, normalised, without repeats. */
export function amazonFulfilmentCodes(platformAttributes: unknown): string[] {
  const pa = platformAttributes && typeof platformAttributes === 'object' ? platformAttributes as Record<string, unknown> : {}
  const nested = pa.attributes && typeof pa.attributes === 'object' ? (pa.attributes as Record<string, unknown>).fulfillment_availability : undefined
  const out: string[] = []
  for (const list of [pa.fulfillment_availability, nested]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const code = normaliseAmazonFulfilmentCode((entry as { fulfillment_channel_code?: unknown } | null)?.fulfillment_channel_code)
      if (code && !out.includes(code)) out.push(code)
    }
  }
  return out
}

/**
 * The FBA guard's code test. D9 = A (Owner, 2026-10-03: "all products except GALE are FBM"): an FBA code counts when
 * Nexus's own fulfilment entry holds it (the door writes `platformAttributes.fulfillment_availability`), and a code only
 * Amazon sets (Remote Fulfilment, VCS) counts from either place. Plain `AMAZON_EU` found only in the copy Amazon's pull
 * left (`attributes.fulfillment_availability`) does NOT block on its own — those copies can be months old (162 local FBM
 * listings still carried one); the screens show it as "Amazon reports AFN — differs from Nexus". FBA stock, an active
 * FBA offer, the typed method and the product flag still close the guard (`isFbaCoordinate`).
 */
export function hasFbaFulfilmentCode(platformAttributes: unknown): boolean {
  const pa = platformAttributes && typeof platformAttributes === 'object' ? platformAttributes as Record<string, unknown> : {}
  const own = amazonFulfilmentCodes({ fulfillment_availability: pa.fulfillment_availability })
  return own.some(isFbaFulfilmentCode) || keptAmazonFulfilmentCodes(platformAttributes).length > 0
}

/** The Amazon-only codes Nexus never rewrites: Remote Fulfilment, VCS and any other `AMAZON_*` beside `AMAZON_EU`. */
export function keptAmazonFulfilmentCodes(platformAttributes: unknown): string[] {
  return amazonFulfilmentCodes(platformAttributes).filter((c) => c.startsWith('AMAZON') && c !== AMAZON_FBA_CODE)
}

const REMOTE_SENTENCE = (route: string) =>
  `Remote Fulfilment (${route}) is switched on in Seller Central → Inventory → Remote Fulfilment with FBA → Marketplace Enrolment. Nexus keeps the code Amazon reports.`

/** What one code means, with the words every screen shows for it. */
export function describeAmazonFulfilmentCode(raw: unknown): AmazonFulfilmentProgramme {
  const code = normaliseAmazonFulfilmentCode(raw)
  const base = { code, from: null, to: null, vcs: false, readOnlyReason: null }
  if (code === AMAZON_FBM_CODE || code === 'MFN') return { ...base, kind: 'FBM', method: 'FBM', label: 'FBM' }
  if (code === AMAZON_FBA_CODE || code === 'AFN') return { ...base, kind: 'FBA', method: 'FBA', label: 'FBA' }
  const remote = REMOTE.exec(code)
  if (remote) {
    const from = remote[1]
    const to = remote[2] ?? DEFAULT_REMOTE_TO[from] ?? null
    const route = `${storeName(from)} stock → ${to ? storeName(to) : 'another store'}`
    return { ...base, kind: 'REMOTE', method: 'FBA', from, to, label: `Remote Fulfilment · ${route}`, readOnlyReason: REMOTE_SENTENCE(route) }
  }
  if (code === 'AMAZON_EU_VCS') {
    return { ...base, kind: 'FBA', method: 'FBA', vcs: true, label: 'FBA (VCS)',
      readOnlyReason: `Amazon reports ${code} for this listing, a Seller Central setting. Nexus treats it as FBA and keeps the code Amazon reports.` }
  }
  if (code.startsWith('AMAZON')) {
    return { ...base, kind: 'FBA', method: 'FBA', label: `FBA (${code})`,
      readOnlyReason: `Amazon reports ${code} for this listing, a Seller Central setting. Nexus treats it as FBA and keeps the code Amazon reports.` }
  }
  return { ...base, kind: 'UNKNOWN', method: null, label: code || 'Not set',
    readOnlyReason: code ? `Amazon reports an unknown fulfilment code (${code}). Nexus never sends a fulfilment change for it; check the listing in Seller Central.` : null }
}

/** The option label of the Fulfillment method column; any other code keeps its own words. */
export function amazonFulfilmentOptionLabel(code: string): string {
  return AMAZON_FULFILMENT_OPTION_LABELS[code] ?? describeAmazonFulfilmentCode(code).label
}
