'use client'

import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { dayInstant } from '../../../model'
import { NAMESPACE_OF, type ShipWord, type WordNs } from '../word'

/** Says one of the tab's model words in the page's language. */
export type Say = (said: ShipWord) => string

/**
 * F-OS-101: the Shipments tab's one way to say its models' words (the models never format; this does): each word from its own
 * catalogue (the tab's `order-shipments`, the order page's `orders`, Warehouse's), days and instants as days, inner words said first.
 */
export function useShipSay(): Say {
  const locale = useLocale()
  const t: Record<WordNs, ReturnType<typeof useT>> = {
    os: useT(NAMESPACE_OF.os),
    orders: useT(NAMESPACE_OF.orders),
    shipments: useT(NAMESPACE_OF.shipments),
    depth: useT(NAMESPACE_OF.depth),
    dv: useT(NAMESPACE_OF.dv),
    complaints: useT(NAMESPACE_OF.complaints),
    ways: useT(NAMESPACE_OF.ways), // owb-ss3
  }
  const say: Say = (said) => {
    const values: Record<string, string | number> = { ...(said.params ?? {}) }
    for (const [name, day] of Object.entries(said.days ?? {})) values[name] = formatDate(dayInstant(day), { locale })
    for (const [name, at] of Object.entries(said.instants ?? {})) values[name] = formatDate(at, { locale })
    for (const [name, inner] of Object.entries(said.words ?? {})) values[name] = say(inner)
    return t[said.ns ?? 'os'](said.key, values)
  }
  return say
}

/** A line of parts (" · "), its first letter a capital. */
export const lineOf = (parts: readonly string[]): string => {
  const text = parts.join(' · ')
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

/** The line ended with one full stop. */
export const sentenceOf = (parts: readonly string[]): string => {
  const text = lineOf(parts)
  return text === '' || /[.!?…]$/.test(text) ? text : `${text}.`
}
