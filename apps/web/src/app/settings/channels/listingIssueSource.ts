/**
 * Where a saved finding came from, in words (review 2026-09-26). The recorder's source codes
 * (apps/api `IssueSource`) name internal producers and are never shown; the card test reads that
 * union, so a new producer cannot reach the screen without a label here.
 */
const SOURCE_LABEL: Readonly<Record<string, string>> = {
  'listings-api': 'Amazon listing status',
  'validation-preview': 'Amazon pre-publish check',
  'amazon-feed': 'Amazon feed upload',
  'amazon-suppression': 'Amazon suppressed listings report',
  'amazon-notification': 'Amazon notification',
  'ebay-write': 'eBay listing update',
  'ebay-feed': 'eBay feed upload',
  'shopify-write': 'Shopify product update',
}

/** Unknown producers say so rather than echoing an internal code or guessing a channel. */
export function listingIssueSourceLabel(source: string): string {
  return Object.prototype.hasOwnProperty.call(SOURCE_LABEL, source) ? SOURCE_LABEL[source] : 'an unrecognised source'
}

/** Severity in sentence case for the Tag (the recorder stores ERROR / WARNING / INFO); empty is stated, not blank. */
export function listingIssueSeverityLabel(severity: string): string {
  const word = severity.trim().toLowerCase()
  return word ? word[0].toUpperCase() + word.slice(1) : 'Unknown severity'
}
