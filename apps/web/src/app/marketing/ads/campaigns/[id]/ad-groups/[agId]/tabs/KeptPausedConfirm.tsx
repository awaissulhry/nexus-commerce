'use client'

/**
 * "Turn on anyway" — the person's confirm for keywords or targets that are KEPT paused (Negative Targeting page,
 * 2026-10-11). The server refused the turn-on (409, the hold's own words); the confirm names each one and what it does —
 * it ends the lock and lets it spend again — and resends the same PATCH with `releaseKeptPaused: true`.
 */
import { Button } from '@/design-system/primitives'
import { Modal, SummaryTable } from '@/design-system/components'

export function KeptPausedConfirm({ items, busy, onCancel, onConfirm }: {
  items: ReadonlyArray<{ id: string; text: string; reason: string }>
  busy: boolean
  onCancel(): void
  onConfirm(): void
}) {
  const n = items.length
  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      title={`${n} kept paused`}
      subtitle="Turning on ends the lock: it spends again, and rules may change it again."
      footer={
        <>
          <span className="grow" />
          <Button onClick={busy ? undefined : onCancel} aria-disabled={busy || undefined}>Cancel</Button>
          <Button variant="primary" onClick={busy ? undefined : onConfirm} aria-disabled={busy || undefined}>{busy ? 'Turning on…' : `Turn on anyway (${n})`}</Button>
        </>
      }
    >
      <SummaryTable label="Kept paused" columns={['Target', 'Why it is paused']} rows={items.map((i) => ({ id: i.id, cells: [i.text, i.reason] }))} />
    </Modal>
  )
}
