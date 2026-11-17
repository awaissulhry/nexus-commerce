'use client'

import { RecordThread } from '../../../lib/record-thread/RecordThread'
import { MessageRemindMe } from '../../../shell/panels/remind-me/view/MessageRemindMe'
import { useRecordThread, type RecordThreadHost } from './use-record-thread'

/**
 * RecordThread v1 in the office (B-TH-212): `<OfficeRecordThread record={{ type, id, companyId, siteId }} title recordLabel party />`
 * in Incoming's reading pane (B-TH-217) and the request's full page (B-TH-219). It fills the height its host gives it. Each message
 * keeps the record panels' Remind me (B-W2b-388) beside its ⋯. Office only: the portal keeps PortalThread on the DS PartnerThread
 * (PR-15), and check-view-boundaries keeps this file out of every other view.
 */
export function OfficeRecordThread(host: RecordThreadHost) {
  const { model, actions } = useRecordThread(host)
  return <RecordThread model={model} actions={actions} remind={(messageId) => <MessageRemindMe record={host.record} messageId={messageId} />} />
}
