'use client'

import { useMemo } from 'react'
import type { MenuItemDef } from '@nexus/ui/components'
import { useLocale, useScopedT } from '../../../../../../lib/i18n/provider'
import { CP, sayOf, type Said, type Say } from '../../people/model'

/**
 * F-CA-108 (customer page › PEOPLE & ADDRESSES tab, lane ca-) — the tab's words, said in the page's language: its own (`customer-people`,
 * no prefix) and the catalogue words it reuses (`parties:…`, `portal-access:…`, `sales-customers-depth:…`, named in the key).
 */
export function usePeopleSay(): Say {
  const t = useScopedT(CP)
  const locale = useLocale()
  return useMemo(() => sayOf(t, locale), [t, locale])
}

/** The parts of an answer said as one sentence: joined with " · ", the first letter capital, a full stop unless it ends one. */
export function sentenceOf(parts: readonly string[], locale: string): string {
  const text = parts.filter((part) => part !== '').join(' · ')
  if (text === '') return ''
  const first = text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
  return /[.:!?]$/.test(first) ? first : `${first}.`
}

/** An item of a row's ⋯ as a rule hands it (People's and Addresses' alike). */
export interface RuleItem {
  readonly id: string
  readonly label: Said
  readonly href?: string | undefined
  /** Held by state: the item stays reachable with its reason, and does nothing. */
  readonly held?: Said | undefined
  readonly danger?: boolean | undefined
  readonly separator?: true | undefined
}

/** A rule's ⋯ item as the DS Menu's: a door is a real link, a held item says why, an act runs through the container. */
export function menuItemOf(item: RuleItem, say: Say, run: () => void): MenuItemDef {
  if (item.separator) return { id: item.id, separator: true }
  return {
    id: item.id,
    label: say(item.label),
    ...(item.href ? { href: item.href } : {}),
    ...(item.held ? { disabled: true, description: say(item.held) } : item.href ? {} : { onSelect: run }),
    ...(item.danger ? { tone: 'danger' as const } : {}),
  }
}
