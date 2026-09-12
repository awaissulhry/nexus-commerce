import JSONbig from 'json-bigint'
/** Preserve number lexemes in arbitrary Shopify metadata and decimal lists. */
export const shopifyJson: { parse(text: string): any; stringify(value: unknown): string } = JSONbig({ alwaysParseAsBig: true })
