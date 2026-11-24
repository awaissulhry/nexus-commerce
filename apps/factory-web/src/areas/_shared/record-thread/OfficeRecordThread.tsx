'use client'

import { useEffect, useMemo } from 'react'
import { RecordThread, type RecordThreadModel } from '../../../lib/record-thread/RecordThread'
import { DockedOfficeThread, type DockedHost } from './DockedOfficeThread'
import { useRecordThread } from './use-record-thread'
import { useThreadReminder } from './use-thread-reminder'

/**
 * RecordThread in the office: `<OfficeRecordThread record={{ type, id, companyId, siteId }} title recordLabel party />`.
 * - B-TH-212 (v1): Incoming's reading pane (B-TH-217) and the request's full page (B-TH-219); it fills the height its host gives it.
 * - B-TH-300 (`docked`): on a record page inside RecordFrame — the Head with Activity's doors (R-ACT), the files line, the Files view,
 *   the one file viewer and Saved replies join the same feed and box.
 * Each message's menu keeps Remind me (B-W2b-388; tw- W2.2: a row of the menu), and it opens here (the thread's own Remind me;
 * reminders are Home's, home.view); the reader's own follow-up shows as a bell in its message's foot. Office only: the portal keeps PortalThread on the DS PartnerThread (PR-15), and check-view-boundaries keeps
 * this file out of every other view.
 */
export function OfficeRecordThread(host: DockedHost & { docked?: boolean; /* B-TH-271 */ onEmpty?: (empty: boolean) => void }) {
  const { model, actions, base } = useRecordThread(host)
  // ---- B-TH-271 (PL6): a window tells whether the thread is still empty (read, nothing written, no events): an office-only thread
  // with nothing in it folds to a slim "Add a note" column there.
  const feed = model.feed
  const empty = feed.state === 'ready' && feed.messages.length === 0 && feed.events.length === 0 && !feed.more
  const onEmpty = host.onEmpty
  useEffect(() => onEmpty?.(empty), [empty, onEmpty])
  // ---- end B-TH-271
  const remindable = base.held.has('home.view')
  const reminder = useThreadReminder(base.key, host.recordLabel, remindable)
  const shown = useMemo(() => withFollowUps(model, reminder.followUps), [model, reminder.followUps])
  if (host.docked) return <DockedOfficeThread host={host} model={shown} actions={actions} base={base} reminder={reminder} />
  return <RecordThread model={shown} actions={actions} slots={{ overlays: reminder.dialog }} />
}

/** tw- W2.2: the reader's own follow-up on their message — the bell in its foot (reminders are personal: only its sender has one). */
function withFollowUps(model: RecordThreadModel, followUps: ReadonlyMap<string, string>): RecordThreadModel {
  if (followUps.size === 0 || model.feed.state !== 'ready') return model
  const messages = model.feed.messages.map((message) => {
    const at = message.mine ? followUps.get(message.id) : undefined
    return at ? { ...message, followUp: { at } } : message
  })
  return { ...model, feed: { ...model.feed, messages } }
}
