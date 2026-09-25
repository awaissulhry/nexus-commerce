'use client'

import type { StudioPublishChange, StudioPublishValue } from '@nexus/shared/studio-publication'
import { ChangeReview, Disclosure } from '@/design-system/components'

export function publicationValueText(value: StudioPublishValue): string {
  if (value.state === 'unknown') return `Unknown — ${value.reason}`
  if (value.state === 'absent') return 'Cleared / absent'
  if (value.value === null) return 'Empty value (null)'
  return typeof value.value === 'string' ? value.value || '(empty text)' : JSON.stringify(value.value, null, 2)
}

export function PublicationChanges({ changes, selectedIds, disabled, onSelectionChange }: {
  changes: StudioPublishChange[]; selectedIds: string[]; disabled: boolean; onSelectionChange(ids: string[]): void
}) {
  const row = (change: StudioPublishChange) => ({ id: change.id, label: `${change.label} · ${change.sku}`, selectable: change.selectable,
    status: change.status === 'SAME' ? 'No send needed' : change.status === 'CANNOT_COMPARE' ? 'Cannot compare' : change.status === 'DIFFERS' ? 'Differs on channel' : 'Changed in Nexus',
    note: change.reason, values: [{ label: 'Nexus now', value: publicationValueText(change.current) },
      { label: 'Last accepted', value: publicationValueText(change.lastAccepted) }, { label: 'Channel now', value: publicationValueText(change.channel) }] })
  const pending = changes.filter(c => c.status !== 'SAME'), same = changes.filter(c => c.status === 'SAME')
  const selected = changes.filter(c => c.selectable && selectedIds.includes(c.id))
  return <>
    <p role="status">{selected.length} {selected.length === 1 ? 'change' : 'changes'} selected.</p>
    <p>Differences without an accepted publish record start unchecked. Choose the values to send, then review the exact request.</p>
    {pending.length > 0 && <ChangeReview label="Fields to publish" items={pending.map(row)} selectedIds={selectedIds} disabled={disabled} onSelectionChange={onSelectionChange} />}
    {same.length > 0 && <Disclosure summary={`${same.length} ${same.length === 1 ? 'field needs' : 'fields need'} no send`}><ChangeReview label="Fields not sent" items={same.map(row)} selectedIds={[]} disabled onSelectionChange={() => {}} /></Disclosure>}
    {!changes.length && <p>No eligible fields were found. Nothing will be sent.</p>}
  </>
}
