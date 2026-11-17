'use client'

import { useEffect } from 'react'
import { RecordThread } from '../../../lib/record-thread/RecordThread'
import { MessageRemindMe } from '../../../shell/panels/remind-me/view/MessageRemindMe'
import { DockedOfficeThread, type DockedHost } from './DockedOfficeThread'
import { useRecordThread } from './use-record-thread'
import { useThreadReminder } from './use-thread-reminder'

/**
 * RecordThread in the office: `<OfficeRecordThread record={{ type, id, companyId, siteId }} title recordLabel party />`.
 * - B-TH-212 (v1): Incoming's reading pane (B-TH-217) and the request's full page (B-TH-219); it fills the height its host gives it.
 * - B-TH-300 (`docked`): on a record page inside RecordFrame — the Head with Activity's doors (R-ACT), the files line, the Files view,
 *   the one file viewer and Saved replies join the same feed and box.
 * Each message keeps the record panels' Remind me (B-W2b-388) beside its ⋯, and it opens here (the thread's own Remind me; reminders
 * are Home's, home.view). Office only: the portal keeps PortalThread on the DS PartnerThread (PR-15), and check-view-boundaries keeps
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
  const remind = remindable ? (messageId: string) => <MessageRemindMe record={host.record} messageId={messageId} /> : undefined
  if (host.docked) return <DockedOfficeThread host={host} model={model} actions={actions} base={base} reminder={reminder} remind={remind} />
  return <RecordThread model={model} actions={actions} remind={remind} slots={{ overlays: reminder.dialog }} />
}
