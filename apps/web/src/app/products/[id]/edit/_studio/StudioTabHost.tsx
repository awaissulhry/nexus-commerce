'use client'

/**
 * PES.1 — where each tab's surface mounts.
 *
 * The frame owns the strip, the active id and the box. It owns NOTHING inside a tab: `sheet` is
 * PES.2 (master) and PES.3 (channel scopes); `images`, `analytics` and `activity` are PES.7. Each
 * lane replaces exactly one branch of this switch with its own component and touches nothing else.
 *
 * Until then a tab renders a placeholder that says what it is, who is building it, and what it
 * needs — not an empty box. A surface that is on the roadmap stays visible and states its state
 * (feedback_keep_placeholder_controls); a blank panel is indistinguishable from a page that broke.
 */

import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'

import { Banner, ProgressBar } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

import { useStudioScope, useStudioProduct } from './contracts'
import { studioAccountAccess } from './accountScope'
import { STUDIO_TAB_LABELS } from './navigation'
import { STUDIO_TAB_LOADERS } from './studioTabs'
import { MASTER_SCOPE, STUDIO_TABS, type StudioTabId } from './types'
import styles from './studio.module.css'

/*
 * The `Placeholder` helper that used to live here is gone: every one of the five tab slots is now a
 * real component (PES.7 filled the last two, `analytics` and `activity`), so it had no callers and
 * `noUnusedLocals` failed the build. Removed by PES.7 as a consequence of filling those slots —
 * disclosed in docs/pes-claims.md, not a silent edit to another lane's frame.
 *
 * P2 (2026-09-30, I4-7) — each tab is its own chunk (`studioTabs.ts`), loaded when it is opened; the frame does not
 * know what any of them look like. MX.P's Matrix, the ONE Variants switch (master is VP.3's surface, a channel scope
 * VP.4's projection) and the Sharing studio are the same components as before, only loaded later.
 */
const TABS = Object.fromEntries(STUDIO_TABS.map((id) => [id, dynamic(STUDIO_TAB_LOADERS[id], {
  loading: () => <ProgressBar indeterminate ariaLabel={`Loading ${STUDIO_TAB_LABELS[id]}`} />,
})])) as Record<StudioTabId, ComponentType>

export function StudioTabHost() {
  const product = useStudioProduct()
  const { scope, tab, market, locale, listingId, destination, scopeError, accountId, accounts, setAccount } = useStudioScope()
  const { primary, selected } = studioAccountAccess(accounts, accountId)
  if (scopeError) return <Banner tone="neutral" title="Choose an available scope">{scopeError}</Banner>
  if (scope !== MASTER_SCOPE && destination.status === 'loading') return <ProgressBar indeterminate ariaLabel="Checking the selected destination" />
  if (scope !== MASTER_SCOPE && destination.status === 'error') return <Banner tone="danger" title="This destination is unavailable"
    action={destination.retry ? <Button size="sm" variant="secondary" onClick={destination.retry}>Try again</Button> : undefined}>{destination.message}</Banner>
  if (scope !== MASTER_SCOPE && !selected) return <Banner tone="neutral" title={accountId ? 'This account is unavailable' : 'Choose an account'}
    action={primary ? <Button onClick={() => setAccount(primary.id)}>Use {primary.label}</Button> : undefined}>
    Select a connected account in the scope controls to continue. Product values will load for that account.
  </Banner>
  if (scope !== MASTER_SCOPE && destination.status !== 'ready') return <Banner tone="neutral">Choose an available market to load this destination.</Banner>
  const Surface = TABS[tab] ?? TABS.sheet
  return (
    <section aria-label={STUDIO_TAB_LABELS[tab]} className={styles.tabPanel}>
      <Surface key={JSON.stringify([product.id, tab, scope, market, locale, accountId, listingId])} />
    </section>
  )
}
