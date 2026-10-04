'use client'

import { isPhotoChangeId, type StudioPublishChange, type StudioPublishValue } from '@nexus/shared/studio-publication'
import { ChangeReview, Disclosure } from '@/design-system/components'

export function publicationValueText(value: StudioPublishValue): string {
  if (value.state === 'unknown') return `Unknown — ${value.reason}`
  if (value.state === 'absent') return 'Cleared / absent'
  if (value.value === null) return 'Empty value (null)'
  return typeof value.value === 'string' ? value.value || '(empty text)' : JSON.stringify(value.value, null, 2)
}

export function PublicationChanges({ changes, selectedIds, disabled, onSelectionChange, photosOnly = false }: {
  changes: StudioPublishChange[]; selectedIds: string[]; disabled: boolean; onSelectionChange(ids: string[]): void
  /** Other fields have problems (P4c): only photo rows can be ticked; the others say why. */
  photosOnly?: boolean
}) {
  const blocked = (change: StudioPublishChange) => photosOnly && !isPhotoChangeId(change.id)
  // Amazon sheet gaps — an offer draft line names its three values in words: the saved value, live in Nexus, Amazon's.
  const values = (change: StudioPublishChange) => change.display
    ? [{ label: 'Saved (waiting)', value: change.display.current }, { label: 'Live in Nexus', value: change.display.lastAccepted }, { label: 'Amazon now', value: change.display.channel }]
    : [{ label: 'Nexus now', value: publicationValueText(change.current) }, { label: 'Last accepted', value: publicationValueText(change.lastAccepted) },
      { label: 'Channel now', value: publicationValueText(change.channel) }]
  const row = (change: StudioPublishChange) => ({ id: change.id, label: `${change.label} · ${change.sku}`, selectable: change.selectable && !blocked(change),
    status: change.status === 'SAME' ? 'No send needed' : change.status === 'CANNOT_COMPARE' ? 'Cannot compare' : change.status === 'DIFFERS' ? 'Differs on channel' : 'Changed in Nexus',
    note: blocked(change) ? 'Fix the problems listed above to send this field. Photos can be sent now.' : [change.reason, change.display?.note].filter(Boolean).join(' '), values: values(change) })
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
