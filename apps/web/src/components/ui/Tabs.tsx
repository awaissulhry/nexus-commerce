'use client'

/**
 * Tabs — ADAPTER over the design system's `Tabs` (Phase 9.3).
 *
 * This file used to be a second, independent implementation of the same concept: its own
 * markup, its own Tailwind classes, its own underline treatment. Two definitions of "tab bar"
 * drift by construction, and they had — the DS bar carries the H10 count pill, the icon slot
 * and the `lg` page-level size that this one never grew.
 *
 * The legacy API is kept verbatim so no call site changes:
 *   • `activeTab` → the DS's `active` (rename only)
 *   • `Tab.disabled` → lifted into the DS rather than shimmed here (one real caller)
 *
 * The legacy `trailing` prop is GONE: measured across every `<Tabs>` in the app, it had zero
 * call sites. Porting it into the DS would have added an API nobody asked for to the one place
 * that is meant to hold only what the platform actually uses.
 *
 * New code should import from `@/design-system/components/Tabs` directly. This adapter exists
 * to retire the duplicate without a 9-file rewrite, not to be a permanent second front door.
 */

import { type ReactNode } from 'react'
import { Tabs as DsTabs, type TabItem } from '@/design-system/components/Tabs'

export interface Tab {
  id: string
  label: ReactNode
  count?: number
  disabled?: boolean
}

interface TabsProps {
  tabs: Tab[]
  activeTab: string
  onChange: (id: string) => void
  className?: string
}

export function Tabs({ tabs, activeTab, onChange, className }: TabsProps) {
  return (
    <DsTabs
      tabs={tabs as TabItem[]}
      active={activeTab}
      onChange={onChange}
      className={className}
    />
  )
}
