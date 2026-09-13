import { normalizeLanguage } from './content-language.js'
/** Validate Amazon/eBay content against the ordered marketplace language authority.
 * Shared and store translation drafts retain their explicit language. */
export class InformationLocaleError extends Error {
  readonly code = 'unsupported_information_locale'
  /** LX.F P2-17 — it carried a `code` and no `statusCode`, so an unsupported
   *  language surfaced through whatever default the route applied (a 500 on the
   *  routes that map unknown errors) instead of the 400 it is.
   *  `content-language.ts:12` sets one; this is the same class of refusal. */
  readonly statusCode = 400
  constructor(message: string) { super(message) }
}
export function assertInformationLocale(channel: string | undefined, locale: string | undefined, marketLanguages?: readonly string[]) {
  if (!locale) return
  try { locale = normalizeLanguage(locale) } catch { throw new InformationLocaleError('Choose a valid content language.') }
  /**
   * LX.F P2-17, MEASURED and then narrowed back — the allowlist stays, with its reason.
   *
   * Dropping it (the finding's proposal) refused three shipped store paths at once:
   * `information-database.vitest.test.ts` answered 400
   * "Choose a supported content language for this destination: en." for Shopify and
   * Etsy translations. The reason is that for a STORE channel the language vocabulary
   * is the store's own published locales (`shopLocales` →
   * `shopify/listing-information-plan.ts:16-20 listingLanguages`), while the
   * `Marketplace` row for SHOPIFY/GLOBAL and ETSY/GLOBAL carries the seeded `['en']`
   * (measured on the local catalogue: `SHOPIFY/GLOBAL=[en] ETSY/GLOBAL=[en]
   * WOOCOMMERCE/GLOBAL=[en]`, all 20 rows carry languages). So the authority for a
   * marketplace channel is `Marketplace.languages`, and for a store channel it is the
   * store — refusing on the former would have blocked every non-English store
   * translation.
   *
   * ❓ QUESTION FOR THE OWNER: should the store rows carry the store's published
   * locales, so this gate can cover every channel with one authority? Until then the
   * allowlist is the honest expression of "these two channels are the ones whose
   * languages this row knows".
   */
  if (channel && ['AMAZON', 'EBAY'].includes(channel) && marketLanguages && !marketLanguages.map(normalizeLanguage).includes(locale)) {
    throw new InformationLocaleError(`Choose a supported content language for this destination: ${marketLanguages.join(', ')}.`)
  }
}
