'use client'

/**
 * Bid page — the small confirm before the Brain's Stop or Start again (Owner 2026-10-12): the DS `Modal`, a title, one
 * line, two buttons. The safe button ("Keep running" / "Keep stopped") takes the focus first; Esc closes it like it. While
 * a stop is sent both buttons are held ("Stopping…"), so it cannot be sent twice. The focus goes back to the detail's
 * Stop / Start again button (`returnFocusTo`), whichever of the two the detail shows by then. Words: `brainStop.ts`.
 */
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import type { StopConfirmWords } from './brainStop'
import styles from '../bid.module.css'

export function BrainStopConfirm({ words, busy, onConfirm, onClose, returnFocusTo }: {
  words: StopConfirmWords
  busy: boolean
  onConfirm(): void
  onClose(): void
  returnFocusTo: () => HTMLElement | null
}) {
  const held = busy ? words.busy : null
  return (
    <Modal
      open
      size="sm"
      title={words.title}
      onClose={() => { if (!busy) onClose() }}
      returnFocusTo={returnFocusTo}
      footer={(
        <>
          <Button variant="secondary" data-autofocus heldReason={held} onClick={onClose}>{words.cancel}</Button>
          <Button variant={words.tone} heldReason={held} onClick={onConfirm}>{busy ? words.busy : words.confirm}</Button>
        </>
      )}
    >
      <p className={styles.confirmLine}>{words.line}</p>
    </Modal>
  )
}
