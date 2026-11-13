import type { Locale } from '../../../../../../lib/i18n/locales'
import { unitPrice } from '../../../model'

/** A signed change of a unit price ("+ 12,00 €", "− 21,00 €"); "—" when there is none. */
export function signedPrice(value: string | number | null | undefined, currency: string, locale: Locale): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const written = unitPrice(String(Math.abs(number)), currency, locale)
  return number < 0 ? `− ${written}` : `+ ${written}`
}
