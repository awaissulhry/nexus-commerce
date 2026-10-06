'use client'

/**
 * The confirm before every Archive on the ad screens (the row status menu, the bulk Archive of ad groups, keywords and
 * targets, and product ads): an archive is permanent at Amazon, so it is never one click. DS Modal, as the campaigns
 * grid's own status confirm.
 */
import { Button } from '@/design-system/primitives'
import { Modal } from '@/design-system/components'
import { archiveConfirmWords } from './archiveWords'

export function ArchiveConfirm({ count, noun, busy = false, onConfirm, onCancel }: {
  count: number
  /** What it archives, singular and plural: ['ad group', 'ad groups']. */
  noun: readonly [string, string]
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const words = archiveConfirmWords(count, noun)
  return (
    <Modal
      open
      onClose={() => { if (!busy) onCancel() }}
      title={words.title}
      subtitle={words.sentence}
      footer={
        <>
          <span className="grow" />
          <Button onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>{busy ? 'Archiving…' : words.confirm}</Button>
        </>
      }
    />
  )
}
