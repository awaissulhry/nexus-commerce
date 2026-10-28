/**
 * The 27 EU member states by ISO 3166-1 alpha-2 code, the code FatturaPA uses in IdPaese and Nazione. Greece is GR
 * here (VIES writes EL). Northern Ireland (XI, goods only) is not listed: an XI customer needs the accountant.
 */
export const EU_MEMBER_STATES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const

export type EuMemberState = (typeof EU_MEMBER_STATES)[number]

export function isEuMemberState(country: string): country is EuMemberState {
  return (EU_MEMBER_STATES as readonly string[]).includes(country)
}
