/**
 * 2-letter marketplace code → human-readable label.
 * Single source of truth — used by sidebar, listings pages, edit page.
 * No flag emojis per design system.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  UK: 'United Kingdom',
  NL: 'Netherlands',
  SE: 'Sweden',
  PL: 'Poland',
  US: 'United States',
  GLOBAL: 'Global',
}

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code
}
