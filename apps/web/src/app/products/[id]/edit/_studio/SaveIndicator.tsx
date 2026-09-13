'use client'

/**
 * PES.1 — the header's autosave state.
 *
 * 🔴 It renders what the SHEET reported and nothing it worked out for itself. The frame has no
 * view of any write, so a header that inferred "Saved" from its own timer would keep saying so
 * while a cell was being refused — which is the exact failure the round-trip rule exists to stop
 * (feedback_100_percent_honest_ui). Every state here comes from `useStudioSave()`, which only
 * PES.2/PES.3 write, through `useSaveReporter()`.
 *
 * There is no page Save button anywhere in this studio: decision 7 of the approved layout retired
 * the dirty registry and the header Save with it.
 */

import { AlertTriangle, Check } from 'lucide-react'

import { useStudioSave, useStudioScope, useStudioSaveMessage } from './contracts'
import { describeSaveState } from './saveState'
import { MASTER_SCOPE } from './types'
import styles from './studio.module.css'

function clock(at: number): string {
  // Locale-formatted and client-only: the timestamp cannot exist before a write, so there is no
  // server render of it to mismatch against.
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function SaveIndicator() {
  const state = useStudioSave()
  const manualMessage = useStudioSaveMessage()
  const { tab, scope } = useStudioScope()
  // Every word, and which branch, is decided in `saveState.ts` where it is asserted. This is markup.
  const d = describeSaveState(state, clock)
  const channelInformation = (tab === 'sheet' || tab === 'variants') && scope !== MASTER_SCOPE
  const deliveryNote = scope === 'ETSY'
    ? 'Information edits save as Nexus drafts. Saving does not publish or deliver them to Etsy.'
    : 'Information edits save in Nexus. Provider delivery is confirmed through the existing synchronization workflow.'
  if (manualMessage) return <span className={styles.saveState}>{manualMessage}</span>

  if (tab === 'variation-order' || tab === 'shopify-family' || tab === 'shopify-metafields') return <span className={styles.saveState}>Save draft on this page</span>
  if (tab === 'images' && (scope === 'EBAY' || scope === 'AMAZON')) return <span className={styles.saveState}>Save draft on this page</span>

  /*
   * MX.P — the Matrix autosaves like the sheet, and says so EXPLICITLY rather than by falling
   * through to the default branch.
   *
   * 🔴 It is deliberately NOT part of `channelInformation` above. That branch says "Nexus draft
   * autosave — provider delivery is confirmed through the existing synchronization workflow",
   * which is true of channel ATTRIBUTE edits and false of every Matrix cell: a quantity, a mode, a
   * buffer or a price written here enqueues an outbound push. Saying "draft" over a write that
   * reaches a marketplace is the honesty rule's exact prohibition.
   *
   * 🔴 And while the Matrix service does not exist, the page is in PREVIEW mode and NOTHING is
   * sent anywhere. The header does not infer that — it cannot see the read's `source`. The Matrix
   * surface REPORTS it through `useManualSaveMessage(MATRIX_COPY.simulated)`, which is handled by
   * the `manualMessage` branch above, so this line is only ever reached in live mode.
   */
  if (tab === 'matrix') {
    return (
      <span className={styles.saveState} title="Every Matrix cell saves on its own and enqueues the channel push it implies. There is no page Save.">
        {d.kind === 'saving' || d.kind === 'saved' || d.kind === 'error' ? d.text : 'Autosave on'}
      </span>
    )
  }

  if (d.kind === 'idle') {
    return (
      <span className={styles.saveState} title={channelInformation ? deliveryNote : tab === 'presentation' ? 'Product assignments save automatically. The shared theme editor has its own Save changes action.' : d.title}>
        {channelInformation ? 'Nexus draft autosave' : tab === 'presentation' ? 'Product autosave' : d.text}
      </span>
    )
  }

  if (d.kind === 'saving') {
    return (
      <span className={styles.saveState} role="status" aria-live="polite">
        <span className={styles.saveSpinner} aria-hidden />
        {d.text}
      </span>
    )
  }

  if (d.kind === 'saved') {
    return (
      <span className={styles.saveState} role="status" aria-live="polite" title={channelInformation ? `${d.title}. ${deliveryNote}` : d.title}>
        <Check size={13} aria-hidden />
        {channelInformation ? `Nexus draft · ${d.text}` : d.text}
      </span>
    )
  }

  return (
    <span
      className={`${styles.saveState} ${styles.error}`}
      role="status"
      aria-live="assertive"
      title={d.title}
    >
      <AlertTriangle size={13} aria-hidden />
      {d.text}
    </span>
  )
}
