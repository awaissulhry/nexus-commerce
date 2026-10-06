'use client'

/**
 * CR rebuild 4 — Limits: one place for every limit automation must keep. Four views — the ads strategy (per market,
 * category and product; the Strategy tab, unchanged), the account brakes, the protected terms, and what only a deploy
 * changes.
 *
 * A view stays mounted once it was opened (hidden while another shows): the strategy keeps an unsaved draft when the
 * person looks at the brakes and comes back. The Strategy editor asks before it drops a draft only on its own moves.
 */
import { useEffect, useState } from 'react'
import { SegmentedControl } from '@/design-system/primitives'
import { Card } from '@/design-system/components'
import { ProtectedTermsPanel } from '../ProtectedTermsPanel'
import { StrategyTab } from './strategy/StrategyTab'
import { AccountBrakes } from './AccountBrakes'
import { ServerSettings } from './ServerSettings'
import { isLimitsView, LIMITS_VIEWS, type LimitsView } from './roomTabs'
import styles from './limits.module.css'

export function LimitsTab({ view, onView }: { view: LimitsView; onView: (v: LimitsView) => void }) {
  const [opened, setOpened] = useState<ReadonlySet<LimitsView>>(() => new Set([view]))
  useEffect(() => { setOpened((prev) => (prev.has(view) ? prev : new Set([...prev, view]))) }, [view])

  return (
    <div className={styles.stack}>
      <SegmentedControl
        size="sm"
        wrap
        ariaLabel="Limits view"
        options={LIMITS_VIEWS.map((v) => ({ value: v.id, label: v.label }))}
        value={view}
        onChange={(v) => { if (isLimitsView(v)) onView(v) }}
        className={styles.viewSwitch}
      />
      {opened.has('strategy') && <div hidden={view !== 'strategy'}><StrategyTab /></div>}
      {opened.has('brakes') && <div hidden={view !== 'brakes'}><AccountBrakes /></div>}
      {opened.has('terms') && (
        <div hidden={view !== 'terms'}>
          {/* The shared panel, as it is (Owner rule: shared = exactly the same). It titles and explains itself. */}
          <Card padded>
            <ProtectedTermsPanel />
          </Card>
        </div>
      )}
      {opened.has('server') && <div hidden={view !== 'server'}><ServerSettings /></div>}
    </div>
  )
}
