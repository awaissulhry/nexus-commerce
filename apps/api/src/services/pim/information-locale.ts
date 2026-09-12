/** Validate Amazon/eBay content against the ordered marketplace language authority.
 * Shared and store translation drafts retain their explicit language. */
export class InformationLocaleError extends Error {
  readonly code = 'unsupported_information_locale'
  constructor(message: string) { super(message) }
}
export function assertInformationLocale(channel: string | undefined, locale: string | undefined, marketLanguages?: readonly string[]) {
  if (!locale) return
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) throw new InformationLocaleError('Choose a valid content language.')
  if (channel && ['AMAZON', 'EBAY'].includes(channel) && marketLanguages && !marketLanguages.includes(locale.toLowerCase())) {
    throw new InformationLocaleError(`Choose a supported content language for this destination: ${marketLanguages.join(', ')}.`)
  }
}
