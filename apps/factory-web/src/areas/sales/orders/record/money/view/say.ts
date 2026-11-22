'use client'

import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { money, percent } from '../../../../quotes/model'
import { dayInstant } from '../../../model'
import type { MoneyWord } from '../word'

/** Says a model's word in the page's language: amounts in the order's currency, days and instants as days, percents, inner words. */
export type Say = (said: MoneyWord) => string

/** F-OM-101: the Money tab's one way to say its models' words (the models never format; this does, in the page's language). */
export function useSay(currency: string): Say {
  const t = useT('orders')
  const locale = useLocale()
  const say: Say = (said) => {
    const values: Record<string, string | number> = { ...(said.params ?? {}) }
    for (const [name, amount] of Object.entries(said.money ?? {})) values[name] = money(amount, currency, locale)
    for (const [name, day] of Object.entries(said.days ?? {})) values[name] = formatDate(dayInstant(day), { locale })
    for (const [name, at] of Object.entries(said.instants ?? {})) values[name] = formatDate(at, { locale })
    for (const [name, pct] of Object.entries(said.pcts ?? {})) values[name] = percent(pct, locale)
    for (const [name, inner] of Object.entries(said.words ?? {})) values[name] = say(inner)
    return t(said.key, values)
  }
  return say
}

/** A line of parts (" · "), its first letter a capital: a part said second is written small ("deposit paid · production waits"). */
export const lineOf = (parts: readonly string[]): string => {
  const text = parts.join(' · ')
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

/** The line ended with one full stop (never two: a payment term may end with its own). */
export const sentenceOf = (parts: readonly string[]): string => {
  const text = lineOf(parts)
  return text === '' || /[.!?…]$/.test(text) ? text : `${text}.`
}
