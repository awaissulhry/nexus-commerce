'use client'

/**
 * CR rebuild 1 — History: what automation did, and what it plans for the next 24 hours, in one place (the old Activity
 * and Foresight tabs). CR rebuild 6 redrew both views on the design system (WhatHappened, NextDay).
 */
import { SegmentedControl } from '@/design-system/primitives'
import { NextDay } from './NextDay'
import { WhatHappened } from './WhatHappened'
import type { AccountHold } from './historyWords'
import type { HistoryView } from './roomTabs'
import styles from './room.module.css'

/** `account`: the account level and stop, so Next 24 hours never says an engine can change the ads when the account holds it. */
export function HistoryTab({ view, onView, account }: { view: HistoryView; onView: (v: HistoryView) => void; account?: AccountHold | null }) {
  return (
    <div className={styles.stack}>
      <SegmentedControl
        size="sm"
        ariaLabel="History view"
        options={[{ value: 'done', label: 'What happened' }, { value: 'next', label: 'Next 24 hours' }]}
        value={view}
        onChange={(v) => onView(v === 'next' ? 'next' : 'done')}
        className={styles.viewSwitch}
      />
      {view === 'next' ? <NextDay account={account} /> : <WhatHappened />}
    </div>
  )
}
