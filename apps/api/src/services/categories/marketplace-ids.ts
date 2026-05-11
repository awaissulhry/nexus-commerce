// Map internal 2-letter marketplace codes to Amazon's marketplaceId.
// Existing call-sites use raw IDs from env; this lookup centralises
// the mapping so the schema-sync service can accept the same
// 2-letter codes the bulk-operations UI uses (IT, DE, US, …).

const CODE_TO_AMAZON_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
}

// Map marketplace code to the locale Amazon uses for schema labels / enumNames.
const CODE_TO_LOCALE: Record<string, string> = {
  IT: 'it_IT',
  DE: 'de_DE',
  FR: 'fr_FR',
  ES: 'es_ES',
  NL: 'nl_NL',
  UK: 'en_GB',
  GB: 'en_GB',
  US: 'en_US',
  CA: 'en_CA',
  MX: 'es_MX',
}

export function amazonLocale(code: string | null | undefined): string {
  if (!code) return 'en_US'
  return CODE_TO_LOCALE[code.toUpperCase()] ?? 'en_US'
}

export function amazonMarketplaceId(code: string | null | undefined): string {
  if (!code) {
    return process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  }
  const upper = code.toUpperCase()
  // If the value already looks like an Amazon ID, pass through.
  if (upper.length > 6) return upper
  return CODE_TO_AMAZON_ID[upper] ?? upper
}
