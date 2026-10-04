'use client'

import { isPhotoChangeId, type StudioPublishChange, type StudioPublishValue } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { ChangeReview, Disclosure } from '@/design-system/components'
import styles from './publication.module.css'

export function publicationValueText(value: StudioPublishValue): string {
  if (value.state === 'unknown') return `Unknown — ${value.reason}`
  if (value.state === 'absent') return 'Cleared / absent'
  if (value.value === null) return 'Empty value (null)'
  return typeof value.value === 'string' ? value.value || '(empty text)' : JSON.stringify(value.value, null, 2)
}

/** The line above the list: how a value that differs on the channel is treated, whatever the ticks are. */
export const REPLACES_INTRO = 'A line that replaces a value on the channel says so under it. Untick it to keep the channel’s value.'

/**
 * One-click "Nexus wins" (Owner 2026-10-04) — the words under a line that replaces a value on the channel
 * (`change.replaces`, set by the server on a selectable DIFFERS line). Ticked: the server's warning ("Changed on Amazon
 * since the last publish. Amazon has 129.00 — Publish sets 149.00.") and its note ("Amazon's Automate Pricing can change
 * it again."). Unticked: what stays ("Unticked: Amazon keeps 129.00."). Null for every other line.
 */
export function replacesWords(change: Pick<StudioPublishChange, 'replaces'>, ticked: boolean, channel?: string | null): { warning: boolean; text: string } | null {
  const replaces = change.replaces
  if (!replaces) return null
  if (ticked) return { warning: true, text: [replaces.sentence, replaces.note].filter(Boolean).join(' ') }
  const name = channel ? channelLabel(channel) : 'the channel'
  return { warning: false, text: replaces.channel === null ? `Unticked: nothing is set on ${name}.` : `Unticked: ${name} keeps ${replaces.channel}.` }
}

export function PublicationChanges({ changes, selectedIds, disabled, onSelectionChange, photosOnly = false, compact = false, channel = null }: {
  changes: StudioPublishChange[]; selectedIds: string[]; disabled: boolean; onSelectionChange(ids: string[]): void
  /** Other fields have problems (P4c): only photo rows can be ticked; the others say why. */
  photosOnly?: boolean
  /**
   * Inside one row of the Publish window's plan table (build shape v2, P10): the row already counts its ticked fields,
   * so the two lines above the list are left out. `onSelectionChange` still receives only these changes' ids.
   */
  compact?: boolean
  /** The review's channel ("AMAZON"), for the words of an unticked line that would replace its value. */
  channel?: string | null
}) {
  const blocked = (change: StudioPublishChange) => photosOnly && !isPhotoChangeId(change.id)
  const ticked = new Set(selectedIds)
  // Amazon sheet gaps — an offer draft line names its three values in words: the saved value, live in Nexus, Amazon's.
  const values = (change: StudioPublishChange) => change.display
    ? [{ label: 'Saved (waiting)', value: change.display.current }, { label: 'Live in Nexus', value: change.display.lastAccepted }, { label: 'Amazon now', value: change.display.channel }]
    : [{ label: 'Nexus now', value: publicationValueText(change.current) }, { label: 'Last accepted', value: publicationValueText(change.lastAccepted) },
      { label: 'Channel now', value: publicationValueText(change.channel) }]
  // The reason (a line judged on Nexus's side — photos the channel re-hosts — says so here), then, on a line that
  // replaces a channel value, the warning under it (or, unticked, what the channel keeps).
  const note = (change: StudioPublishChange) => {
    if (blocked(change)) return 'Fix the problems listed above to send this field. Photos can be sent now.'
    const reason = [change.reason, change.display?.note].filter(Boolean).join(' ')
    const words = change.selectable ? replacesWords(change, ticked.has(change.id), channel) : null
    if (!words) return reason
    return <>{reason}<span className={words.warning ? styles.lineWarning : styles.lineKept}>{words.warning && <strong>Warning: </strong>}{words.text}</span></>
  }
  const row = (change: StudioPublishChange) => ({ id: change.id, label: `${change.label} · ${change.sku}`, selectable: change.selectable && !blocked(change),
    status: change.status === 'SAME' ? 'No send needed' : change.status === 'CANNOT_COMPARE' ? 'Cannot compare' : change.status === 'DIFFERS' ? 'Differs on channel' : 'Changed in Nexus',
    note: note(change), values: values(change) })
  const pending = changes.filter(c => c.status !== 'SAME'), same = changes.filter(c => c.status === 'SAME')
  const selected = changes.filter(c => c.selectable && ticked.has(c.id))
  return <>
    {!compact && <p role="status">{selected.length} {selected.length === 1 ? 'change' : 'changes'} selected.</p>}
    {!compact && <p>{REPLACES_INTRO}</p>}
    {pending.length > 0 && <ChangeReview label="Fields to publish" items={pending.map(row)} selectedIds={selectedIds} disabled={disabled} onSelectionChange={onSelectionChange} />}
    {same.length > 0 && <Disclosure summary={`${same.length} ${same.length === 1 ? 'field needs' : 'fields need'} no send`}><ChangeReview label="Fields not sent" items={same.map(row)} selectedIds={[]} disabled onSelectionChange={() => {}} /></Disclosure>}
    {!changes.length && <p>No eligible fields were found. Nothing will be sent.</p>}
  </>
}
