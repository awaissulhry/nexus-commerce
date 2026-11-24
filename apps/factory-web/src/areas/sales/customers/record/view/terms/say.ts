'use client'

import { useMemo } from 'react'
import type { MenuItemDef } from '@nexus/ui/components'
import { useLocale, useScopedT } from '../../../../../../lib/i18n/provider'
import type { Act } from '../../terms/holds'
import { CT, sayOf, type Said, type Say } from '../../terms/model'

/**
 * F-CT-301 (customer page › TERMS & REQUIREMENTS tab, lane ct-) — the tab's words, said in the page's language: its own
 * (`customer-terms`, no prefix) and the catalogue words it reuses (`sales-customers-depth:…`, `parties:…`, `customer-money:…`, named in
 * the key) — and one ⋯ item from an act (drawn with its right; held by state says why and does nothing).
 */
export function useTermsSay(): Say {
  const t = useScopedT(CT)
  const locale = useLocale()
  return useMemo(() => sayOf(t, locale), [t, locale])
}

/** A ⋯ item for an act the rules hand (null: not drawn — its right is missing). */
export function actItem(id: string, label: Said, act: Act, say: Say, run: () => void): MenuItemDef | null {
  if (!act.shown) return null
  return act.held ? { id, label: say(label), disabled: true, description: say(act.held) } : { id, label: say(label), onSelect: run }
}

/** The items drawn, separators only between groups (never first, last or twice). */
export function menuOf(groups: ReadonlyArray<ReadonlyArray<MenuItemDef | null>>): MenuItemDef[] {
  const out: MenuItemDef[] = []
  for (const group of groups) {
    const items = group.filter((item): item is MenuItemDef => item !== null)
    if (items.length === 0) continue
    if (out.length > 0) out.push({ id: `sep-${out.length}`, separator: true })
    out.push(...items)
  }
  return out
}
