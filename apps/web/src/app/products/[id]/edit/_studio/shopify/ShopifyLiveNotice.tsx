'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Banner } from '@/design-system/components'
import styles from './linked.module.css'

/** A store-level fallback notice; it must never take space away from the editor. */
export function ShopifyLiveNotice({ issue, accountLabel, storageKey }: { issue: string; accountLabel: string; storageKey: string }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    try { setVisible(sessionStorage.getItem(storageKey) !== issue) }
    catch { setVisible(true) }
  }, [storageKey, issue])

  const dismiss = () => {
    setVisible(false)
    try { sessionStorage.setItem(storageKey, issue) }
    catch { /* Dismissal still works for this visit when browser storage is unavailable. */ }
  }

  if (!visible) return null
  return createPortal(
    <div className={styles.liveNotice}>
      <Banner tone="warning" title="Live attribute notifications are unavailable" onDismiss={dismiss}>
        {accountLabel} · Nexus checks for changes every 30 seconds while this page is visible.
      </Banner>
    </div>,
    document.body,
  )
}
